import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  classifyTrackingState,
  dependencyManifestsChanged,
  parseRevisionCounts,
  runSafeSourceUpdate,
} from "../scripts/safe-update-lib.mjs";

const execFileAsync = promisify(execFile);

async function runGit(cwd, args) {
  await execFileAsync("git", args, { cwd, encoding: "utf8" });
}

function commandKey(command, args) {
  return [command, ...args].join(" ");
}

function createFakeRunner(responses) {
  const calls = [];
  const remaining = new Map(
    Object.entries(responses).map(([key, value]) => [key, Array.isArray(value) ? [...value] : [value]]),
  );

  function take(command, args) {
    const key = commandKey(command, args);
    const values = remaining.get(key);
    assert.ok(values?.length, `Unexpected command: ${key}`);
    const value = values.shift();
    if (value instanceof Error) {
      throw value;
    }
    return value ?? "";
  }

  return {
    calls,
    async capture(command, args) {
      calls.push({ type: "capture", command, args });
      return take(command, args);
    },
    async inherit(command, args) {
      calls.push({ type: "inherit", command, args });
      take(command, args);
    },
  };
}

const cleanStatusCommand = "git status --porcelain=v1 --untracked-files=normal";
const baseResponses = {
  [cleanStatusCommand]: "",
  "git rev-parse --is-inside-work-tree": "true",
  "git branch --show-current": "main",
  "git rev-parse --abbrev-ref --symbolic-full-name @{upstream}": "origin/main",
  "git fetch --prune": "",
};

test("revision state parsing distinguishes safe and unsafe histories", () => {
  assert.deepEqual(parseRevisionCounts("0\t0"), { ahead: 0, behind: 0 });
  assert.equal(classifyTrackingState({ ahead: 0, behind: 0 }), "current");
  assert.equal(classifyTrackingState({ ahead: 0, behind: 2 }), "behind");
  assert.equal(classifyTrackingState({ ahead: 1, behind: 0 }), "ahead");
  assert.equal(classifyTrackingState({ ahead: 1, behind: 2 }), "diverged");
  assert.throws(() => parseRevisionCounts("unknown"), /Could not parse/);
});

test("dependency installation is limited to committed npm manifests", () => {
  assert.equal(dependencyManifestsChanged(["README.md", "src/index.js"]), false);
  assert.equal(dependencyManifestsChanged(["src/index.js", "package-lock.json"]), true);
  assert.equal(dependencyManifestsChanged(["package.json"]), true);
});

test("check mode fetches and reports an available update without pulling", async () => {
  const runner = createFakeRunner({
    ...baseResponses,
    "git rev-parse HEAD": "1111111111111111111111111111111111111111",
    "git rev-list --left-right --count HEAD...@{upstream}": "0\t2",
  });
  const messages = [];

  const result = await runSafeSourceUpdate({
    workspaceRoot: "/test/repo",
    checkOnly: true,
    runner,
    log: (message) => messages.push(message),
  });

  assert.equal(result.state, "behind");
  assert.ok(messages.some((message) => /safe fast-forward is available/i.test(message)));
  assert.equal(runner.calls.some((call) => commandKey(call.command, call.args) === "git pull --ff-only"), false);
});

test("safe update fast-forwards, installs changed dependencies, and verifies", async () => {
  const runner = createFakeRunner({
    ...baseResponses,
    [cleanStatusCommand]: ["", ""],
    "git rev-parse HEAD": [
      "1111111111111111111111111111111111111111",
      "2222222222222222222222222222222222222222",
    ],
    "git rev-list --left-right --count HEAD...@{upstream}": "0\t3",
    "git pull --ff-only": "",
    "git diff --name-only 1111111111111111111111111111111111111111 2222222222222222222222222222222222222222":
      "src/index.js\npackage-lock.json",
    "npm ci": "",
    "npm run check:bot": "",
  });

  const result = await runSafeSourceUpdate({
    workspaceRoot: "/test/repo",
    runner,
    log: () => {},
  });

  assert.equal(result.state, "updated");
  assert.deepEqual(
    runner.calls.filter((call) => call.type === "inherit").map((call) => commandKey(call.command, call.args)),
    ["git fetch --prune", "git pull --ff-only", "npm ci", "npm run check:bot"],
  );
});

test("dirty and diverged repositories fail closed without pulling", async () => {
  const dirtyRunner = createFakeRunner({
    [cleanStatusCommand]: " M src/index.js",
  });
  await assert.rejects(
    () => runSafeSourceUpdate({ workspaceRoot: "/test/repo", runner: dirtyRunner, log: () => {} }),
    /worktree is not clean/,
  );
  assert.equal(dirtyRunner.calls.length, 1);

  const divergedRunner = createFakeRunner({
    ...baseResponses,
    "git rev-parse HEAD": "1111111111111111111111111111111111111111",
    "git rev-list --left-right --count HEAD...@{upstream}": "1\t1",
  });
  await assert.rejects(
    () => runSafeSourceUpdate({ workspaceRoot: "/test/repo", runner: divergedRunner, log: () => {} }),
    /diverged.*no merge or rebase/i,
  );
  assert.equal(
    divergedRunner.calls.some((call) => commandKey(call.command, call.args) === "git pull --ff-only"),
    false,
  );
});

test("check mode detects a real fast-forward without changing the checkout", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lookupbot-safe-update-"));
  const remote = path.join(root, "remote.git");
  const source = path.join(root, "source");
  const deployment = path.join(root, "deployment");

  try {
    await fs.mkdir(source);
    await runGit(root, ["init", "--bare", remote]);
    await runGit(source, ["init", "--initial-branch=main"]);
    await runGit(source, ["config", "user.name", "LookupBot Test"]);
    await runGit(source, ["config", "user.email", "lookupbot@example.invalid"]);
    await fs.writeFile(path.join(source, "README.md"), "first\n", "utf8");
    await runGit(source, ["add", "README.md"]);
    await runGit(source, ["commit", "-m", "Initial"]);
    await runGit(source, ["remote", "add", "origin", remote]);
    await runGit(source, ["push", "-u", "origin", "main"]);
    await runGit(root, ["clone", "--branch", "main", remote, deployment]);

    await fs.writeFile(path.join(source, "README.md"), "second\n", "utf8");
    await runGit(source, ["add", "README.md"]);
    await runGit(source, ["commit", "-m", "Update"]);
    await runGit(source, ["push"]);

    const before = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: deployment })).stdout.trim();
    const result = await runSafeSourceUpdate({
      workspaceRoot: deployment,
      checkOnly: true,
      log: () => {},
    });
    const after = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: deployment })).stdout.trim();

    assert.equal(result.state, "behind");
    assert.equal(before, after);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
