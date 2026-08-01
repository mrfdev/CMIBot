import { execFile } from "node:child_process";
import { spawn } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DEPENDENCY_MANIFESTS = new Set(["package.json", "package-lock.json"]);

export class SafeUpdateError extends Error {
  constructor(message) {
    super(message);
    this.name = "SafeUpdateError";
  }
}

function commandLabel(command, args) {
  return [command, ...args].join(" ");
}

function commandFailure(command, args, error) {
  const details = String(error?.stderr || error?.message || error).trim();
  return new SafeUpdateError(
    `${commandLabel(command, args)} failed${details ? `: ${details}` : "."}`,
  );
}

export function createCommandRunner(workspaceRoot) {
  return {
    async capture(command, args) {
      try {
        const { stdout } = await execFileAsync(command, args, {
          cwd: workspaceRoot,
          encoding: "utf8",
          maxBuffer: 10 * 1024 * 1024,
        });
        return stdout.trim();
      } catch (error) {
        throw commandFailure(command, args, error);
      }
    },

    async inherit(command, args) {
      await new Promise((resolve, reject) => {
        const child = spawn(command, args, {
          cwd: workspaceRoot,
          stdio: "inherit",
        });

        child.once("error", (error) => reject(commandFailure(command, args, error)));
        child.once("exit", (code, signal) => {
          if (code === 0) {
            resolve();
            return;
          }

          const suffix = signal ? `signal ${signal}` : `exit code ${code}`;
          reject(new SafeUpdateError(`${commandLabel(command, args)} failed with ${suffix}.`));
        });
      });
    },
  };
}

export function parseRevisionCounts(value) {
  const parts = String(value)
    .trim()
    .split(/\s+/)
    .map((part) => Number.parseInt(part, 10));

  if (parts.length !== 2 || parts.some((part) => !Number.isInteger(part) || part < 0)) {
    throw new SafeUpdateError(`Could not parse Git revision counts from ${JSON.stringify(value)}.`);
  }

  return { ahead: parts[0], behind: parts[1] };
}

export function classifyTrackingState({ ahead, behind }) {
  if (ahead > 0 && behind > 0) {
    return "diverged";
  }
  if (ahead > 0) {
    return "ahead";
  }
  if (behind > 0) {
    return "behind";
  }
  return "current";
}

export function dependencyManifestsChanged(files) {
  return files.some((file) => DEPENDENCY_MANIFESTS.has(file));
}

function formatDirtyPreview(status) {
  const lines = status.split("\n").filter(Boolean);
  const shown = lines.slice(0, 10);
  const remaining = lines.length - shown.length;
  return `${shown.join("\n")}${remaining > 0 ? `\n...and ${remaining} more` : ""}`;
}

async function requireCleanWorktree(runner, stage) {
  const status = await runner.capture("git", [
    "status",
    "--porcelain=v1",
    "--untracked-files=normal",
  ]);
  if (!status) {
    return;
  }

  throw new SafeUpdateError(
    `Refusing to ${stage} because the Git worktree is not clean:\n${formatDirtyPreview(status)}`,
  );
}

async function resolveRepositoryState(runner) {
  const insideWorktree = await runner.capture("git", ["rev-parse", "--is-inside-work-tree"]);
  if (insideWorktree !== "true") {
    throw new SafeUpdateError("The update command must run inside a Git worktree.");
  }

  const branch = await runner.capture("git", ["branch", "--show-current"]);
  if (!branch) {
    throw new SafeUpdateError("Refusing to update a detached HEAD. Switch to a tracked branch first.");
  }

  let upstream;
  try {
    upstream = await runner.capture("git", [
      "rev-parse",
      "--abbrev-ref",
      "--symbolic-full-name",
      "@{upstream}",
    ]);
  } catch {
    throw new SafeUpdateError(
      `Branch ${branch} has no configured upstream. Set its tracking branch before updating.`,
    );
  }

  return { branch, upstream };
}

function assertFastForwardable(state, branch, upstream) {
  if (state === "ahead") {
    throw new SafeUpdateError(
      `${branch} is ahead of ${upstream}. Review or push the local commits; no pull was attempted.`,
    );
  }
  if (state === "diverged") {
    throw new SafeUpdateError(
      `${branch} has diverged from ${upstream}. Resolve it manually; no merge or rebase was attempted.`,
    );
  }
}

export async function runSafeSourceUpdate({
  workspaceRoot,
  checkOnly = false,
  runner = createCommandRunner(workspaceRoot),
  log = (message) => console.log(message),
} = {}) {
  await requireCleanWorktree(runner, "check for updates");
  const { branch, upstream } = await resolveRepositoryState(runner);
  const oldHead = await runner.capture("git", ["rev-parse", "HEAD"]);

  log(`[update] Branch: ${branch} (tracking ${upstream})`);
  log("[update] Fetching remote metadata...");
  await runner.inherit("git", ["fetch", "--prune"]);

  const counts = parseRevisionCounts(
    await runner.capture("git", ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"]),
  );
  const state = classifyTrackingState(counts);
  assertFastForwardable(state, branch, upstream);

  if (state === "current") {
    log(`[update] ${branch} is already current with ${upstream} at ${oldHead.slice(0, 12)}.`);
    return { state, branch, upstream, oldHead, newHead: oldHead, changedFiles: [] };
  }

  if (checkOnly) {
    log(
      `[update] A safe fast-forward is available: ${counts.behind} commit${counts.behind === 1 ? "" : "s"}.`,
    );
    log("[update] Stop the bot, then run `npm run update:safe` to apply and verify it.");
    return { state, branch, upstream, oldHead, newHead: oldHead, changedFiles: [] };
  }

  log(
    `[update] Applying ${counts.behind} commit${counts.behind === 1 ? "" : "s"} with git pull --ff-only...`,
  );
  await runner.inherit("git", ["pull", "--ff-only"]);

  const newHead = await runner.capture("git", ["rev-parse", "HEAD"]);
  const changedOutput = await runner.capture("git", ["diff", "--name-only", oldHead, newHead]);
  const changedFiles = changedOutput ? changedOutput.split("\n").filter(Boolean) : [];

  if (dependencyManifestsChanged(changedFiles)) {
    log("[update] Dependency manifests changed; installing the committed lockfile with npm ci...");
    await runner.inherit("npm", ["ci"]);
  }

  log("[update] Running bot syntax checks and tests before restart...");
  await runner.inherit("npm", ["run", "check:bot"]);
  await requireCleanWorktree(runner, "finish the update");

  log(`[update] Verified ${oldHead.slice(0, 12)} -> ${newHead.slice(0, 12)}.`);
  log("[update] Source update complete. The bot was not restarted automatically.");
  return { state: "updated", branch, upstream, oldHead, newHead, changedFiles };
}
