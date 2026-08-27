import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { hasHealthyServiceLog } from "../scripts/deploy-health.mjs";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function runGit(cwd, args) {
  const { stdout } = await execFileAsync("/usr/bin/git", args, { cwd, encoding: "utf8" });
  return stdout.trim();
}

async function createSourceRepository(temporaryRoot) {
  const sourceRoot = path.join(temporaryRoot, "source");
  await fs.mkdir(sourceRoot);
  await runGit(sourceRoot, ["init", "--initial-branch=main"]);
  await runGit(sourceRoot, ["config", "user.name", "LookupBot Test"]);
  await runGit(sourceRoot, ["config", "user.email", "lookupbot@example.invalid"]);
  await fs.mkdir(path.join(sourceRoot, "src"));
  await fs.writeFile(path.join(sourceRoot, ".gitignore"), ".deploy/\n.env\nlogs/\n", "utf8");
  await fs.writeFile(path.join(sourceRoot, "package.json"), '{"name":"deployment-fixture","version":"1.0.0"}\n', "utf8");
  await fs.writeFile(path.join(sourceRoot, "package-lock.json"), '{"name":"deployment-fixture","version":"1.0.0","lockfileVersion":3,"packages":{}}\n', "utf8");
  await fs.writeFile(path.join(sourceRoot, "src/index.js"), 'console.log("fixture");\n', "utf8");
  await runGit(sourceRoot, ["add", ".gitignore", "package.json", "package-lock.json", "src/index.js"]);
  await runGit(sourceRoot, ["commit", "-m", "Initial fixture"]);

  await fs.writeFile(path.join(sourceRoot, ".env"), "shared environment sentinel\n", { mode: 0o600 });
  await fs.mkdir(path.join(sourceRoot, "logs"));
  await fs.writeFile(path.join(sourceRoot, "logs", "cmibot-service.log"), "pre-deployment output\n", "utf8");
  await fs.writeFile(path.join(sourceRoot, "logs", "usage.jsonl"), '{"preserved":true}\n', "utf8");

  return { sourceRoot, commit: await runGit(sourceRoot, ["rev-parse", "HEAD"]) };
}

async function createDeploymentBoundaries(temporaryRoot, sourceRoot) {
  const binDirectory = path.join(temporaryRoot, "bin");
  const launchAgentsDirectory = path.join(temporaryRoot, "LaunchAgents");
  const launchctlState = path.join(temporaryRoot, "launchctl.state");
  const healthModePath = path.join(temporaryRoot, "health.mode");
  const npmPath = path.join(binDirectory, "npm");
  const launchctlPath = path.join(binDirectory, "launchctl");
  await fs.mkdir(binDirectory);
  await fs.mkdir(launchAgentsDirectory);
  await fs.writeFile(path.join(launchAgentsDirectory, "com.mrfdev.cmibot.plist"), "test plist\n", "utf8");
  await fs.writeFile(
    npmPath,
    [
      "#!/bin/sh",
      "set -eu",
      "case \":$PATH:\" in *\":$CMIBOT_TEST_BIN:\"*) ;; *) exit 65 ;; esac",
      "case \"$*\" in",
      "  ci) exit 0 ;;",
      "  'run check:bot')",
      "    if [ \"${CMIBOT_TEST_NPM_FAIL_CHECK:-0}\" = \"1\" ]; then exit 42; fi",
      "    exit 0",
      "    ;;",
      "esac",
      "exit 64",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  await fs.writeFile(
    launchctlPath,
    [
      "#!/bin/sh",
      "set -eu",
      "case \"$1\" in",
      "  print)",
      "    if [ -f \"$CMIBOT_TEST_LAUNCHCTL_STATE\" ]; then",
      "      printf '%s\\n' 'state = running' 'pid = 3579'",
      "      exit 0",
      "    fi",
      "    exit 113",
      "    ;;",
      "  bootstrap)",
      "    : > \"$CMIBOT_TEST_LAUNCHCTL_STATE\"",
      "    if [ -f \"$CMIBOT_TEST_HEALTH_MODE\" ] && [ \"$(cat \"$CMIBOT_TEST_HEALTH_MODE\")\" = \"fail-once\" ]; then",
      "      printf '%s\\n' 'healthy' > \"$CMIBOT_TEST_HEALTH_MODE\"",
      "    else",
      "      printf '%s\\n' '{\"timestamp\":\"2026-08-27T10:00:00.000Z\",\"level\":\"info\",\"event\":\"discord.connected\",\"ready\":true}' >> \"$CMIBOT_TEST_HEALTH_LOG\"",
      "    fi",
      "    exit 0",
      "    ;;",
      "  bootout)",
      "    rm -f \"$CMIBOT_TEST_LAUNCHCTL_STATE\"",
      "    exit 0",
      "    ;;",
      "esac",
      "exit 64",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );

  return {
    environment: {
      ...process.env,
      CMIBOT_GIT: "/usr/bin/git",
      CMIBOT_HEALTH_INTERVAL_MS: "10",
      CMIBOT_HEALTH_TIMEOUT_MS: "1000",
      CMIBOT_LAUNCHCTL: launchctlPath,
      CMIBOT_LAUNCH_AGENTS_DIR: launchAgentsDirectory,
      CMIBOT_NPM: npmPath,
      CMIBOT_PROJECT_ROOT: sourceRoot,
      CMIBOT_TAR: "/usr/bin/tar",
      CMIBOT_TEST_BIN: binDirectory,
      CMIBOT_TEST_HEALTH_LOG: path.join(sourceRoot, "logs", "cmibot-service.log"),
      CMIBOT_TEST_HEALTH_MODE: healthModePath,
      CMIBOT_TEST_LAUNCHCTL_STATE: launchctlState,
      CMIBOT_UID: "501",
    },
    healthModePath,
  };
}

test("deployment health accepts structured records and legacy rollback output", () => {
  assert.equal(
    hasHealthyServiceLog(
      '{"timestamp":"2026-08-27T10:00:00.000Z","level":"info","event":"discord.connected","ready":true}\n',
    ),
    true,
  );
  assert.equal(hasHealthyServiceLog("LookupBot connected as legacy-release.\n"), true);
  assert.equal(hasHealthyServiceLog('{"event":"discord.connected","ready":false}\n'), false);
});

test("deploy switches to a verified release while preserving shared environment and logs", async () => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lookupbot-deploy-"));

  try {
    const { sourceRoot, commit } = await createSourceRepository(temporaryRoot);
    const { environment } = await createDeploymentBoundaries(temporaryRoot, sourceRoot);
    const result = await execFileAsync(path.join(repositoryRoot, "scripts/deploy"), [], {
      cwd: sourceRoot,
      encoding: "utf8",
      env: environment,
    });

    const currentRelease = await fs.realpath(path.join(sourceRoot, ".deploy", "current"));
    assert.match(result.stdout, new RegExp(`Deployed ${commit}\\.`));
    assert.equal(path.basename(currentRelease), commit);
    assert.equal(await fs.readFile(path.join(currentRelease, ".env"), "utf8"), "shared environment sentinel\n");
    assert.equal(await fs.readFile(path.join(currentRelease, "logs", "usage.jsonl"), "utf8"), '{"preserved":true}\n');
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("a failed health check restores and restarts the previous release", async () => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lookupbot-deploy-"));

  try {
    const { sourceRoot, commit: firstCommit } = await createSourceRepository(temporaryRoot);
    const { environment, healthModePath } = await createDeploymentBoundaries(temporaryRoot, sourceRoot);
    await execFileAsync(path.join(repositoryRoot, "scripts/deploy"), [], {
      cwd: sourceRoot,
      encoding: "utf8",
      env: environment,
    });

    await fs.writeFile(path.join(sourceRoot, "src/index.js"), 'console.log("second fixture");\n', "utf8");
    await runGit(sourceRoot, ["add", "src/index.js"]);
    await runGit(sourceRoot, ["commit", "-m", "Second fixture"]);
    await fs.writeFile(healthModePath, "fail-once\n", "utf8");

    await assert.rejects(
      execFileAsync(path.join(repositoryRoot, "scripts/deploy"), [], {
        cwd: sourceRoot,
        encoding: "utf8",
        env: { ...environment, CMIBOT_HEALTH_TIMEOUT_MS: "50" },
      }),
      (error) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /restored the previous release/i);
        return true;
      },
    );

    const currentRelease = await fs.realpath(path.join(sourceRoot, ".deploy", "current"));
    assert.equal(path.basename(currentRelease), firstCommit);
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("deploy --rollback health-checks the previous release and keeps the newer release recoverable", async () => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lookupbot-deploy-"));

  try {
    const { sourceRoot, commit: firstCommit } = await createSourceRepository(temporaryRoot);
    const { environment } = await createDeploymentBoundaries(temporaryRoot, sourceRoot);
    await execFileAsync(path.join(repositoryRoot, "scripts/deploy"), [], {
      cwd: sourceRoot,
      encoding: "utf8",
      env: environment,
    });

    await fs.writeFile(path.join(sourceRoot, "src/index.js"), 'console.log("second fixture");\n', "utf8");
    await runGit(sourceRoot, ["add", "src/index.js"]);
    await runGit(sourceRoot, ["commit", "-m", "Second fixture"]);
    const secondCommit = await runGit(sourceRoot, ["rev-parse", "HEAD"]);
    await execFileAsync(path.join(repositoryRoot, "scripts/deploy"), [], {
      cwd: sourceRoot,
      encoding: "utf8",
      env: environment,
    });

    const result = await execFileAsync(path.join(repositoryRoot, "scripts/deploy"), ["--rollback"], {
      cwd: sourceRoot,
      encoding: "utf8",
      env: environment,
    });

    const currentRelease = await fs.realpath(path.join(sourceRoot, ".deploy", "current"));
    const previousRelease = await fs.realpath(path.join(sourceRoot, ".deploy", "previous"));
    assert.match(result.stdout, new RegExp(`Rolled back to ${firstCommit}\\.`));
    assert.equal(path.basename(currentRelease), firstCommit);
    assert.equal(path.basename(previousRelease), secondCommit);
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("failed staged verification leaves the active release untouched", async () => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lookupbot-deploy-"));

  try {
    const { sourceRoot, commit: firstCommit } = await createSourceRepository(temporaryRoot);
    const { environment } = await createDeploymentBoundaries(temporaryRoot, sourceRoot);
    await execFileAsync(path.join(repositoryRoot, "scripts/deploy"), [], {
      cwd: sourceRoot,
      encoding: "utf8",
      env: environment,
    });

    await fs.writeFile(path.join(sourceRoot, "src/index.js"), 'console.log("unverified fixture");\n', "utf8");
    await runGit(sourceRoot, ["add", "src/index.js"]);
    await runGit(sourceRoot, ["commit", "-m", "Unverified fixture"]);

    await assert.rejects(
      execFileAsync(path.join(repositoryRoot, "scripts/deploy"), [], {
        cwd: sourceRoot,
        encoding: "utf8",
        env: { ...environment, CMIBOT_TEST_NPM_FAIL_CHECK: "1" },
      }),
      (error) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /verification failed before activation; current release was not changed/i);
        return true;
      },
    );

    const currentRelease = await fs.realpath(path.join(sourceRoot, ".deploy", "current"));
    assert.equal(path.basename(currentRelease), firstCommit);
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
});
