#!/usr/bin/env node

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { hasHealthyServiceLog } from "./deploy-health.mjs";

const execFileAsync = promisify(execFile);
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));

function projectRoot() {
  return process.env.CMIBOT_PROJECT_ROOT || path.resolve(scriptDirectory, "..");
}

function configuredMilliseconds(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined) {
    return fallback;
  }
  if (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > 300_000) {
    throw new Error(`${name} must be an integer from 1 through 300000.`);
  }
  return Number(raw);
}

async function capture(command, args, options = {}) {
  const { stdout } = await execFileAsync(command, args, {
    ...options,
    encoding: "utf8",
  });
  return stdout.trim();
}

async function run(command, args, options = {}) {
  const { stdout, stderr } = await execFileAsync(command, args, {
    ...options,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (stdout) {
    process.stdout.write(stdout);
  }
  if (stderr) {
    process.stderr.write(stderr);
  }
}

async function pathExists(candidate) {
  try {
    await fs.access(candidate);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function atomicSymlink(linkPath, target) {
  const temporaryLink = `${linkPath}.next-${process.pid}`;
  await fs.symlink(target, temporaryLink, "dir");
  try {
    await fs.rename(temporaryLink, linkPath);
  } catch (error) {
    await fs.rm(temporaryLink, { force: true });
    throw error;
  }
}

async function readOptionalSymlink(linkPath) {
  try {
    return await fs.readlink(linkPath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function validateReleaseTarget(deployRoot, releasesRoot, target) {
  const resolved = path.resolve(deployRoot, target);
  if (path.dirname(resolved) !== releasesRoot || !/^[0-9a-f]{40}$/i.test(path.basename(resolved))) {
    throw new Error(`Refusing unsafe release link target: ${target}`);
  }
}

async function readLogSince(logPath, startingSize) {
  let contents;
  try {
    contents = await fs.readFile(logPath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return "";
    }
    throw error;
  }
  const offset = contents.length < startingSize ? 0 : startingSize;
  return contents.subarray(offset).toString("utf8");
}

async function logSize(logPath) {
  try {
    return (await fs.stat(logPath)).size;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return 0;
    }
    throw error;
  }
}

async function waitForHealthyService(logPath, startingSize) {
  const timeout = configuredMilliseconds("CMIBOT_HEALTH_TIMEOUT_MS", 60_000);
  const interval = configuredMilliseconds("CMIBOT_HEALTH_INTERVAL_MS", 500);
  const deadline = Date.now() + timeout;

  while (Date.now() <= deadline) {
    try {
      await execFileAsync(path.join(scriptDirectory, "status"), [], {
        encoding: "utf8",
        env: process.env,
      });
      const freshLog = await readLogSince(logPath, startingSize);
      if (hasHealthyServiceLog(freshLog)) {
        return;
      }
    } catch (error) {
      if (error?.code === "ENOENT") {
        throw error;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }

  throw new Error(`LookupBot did not become healthy within ${timeout}ms.`);
}

async function restartAndWaitForHealth(sourceRoot, serviceLogPath) {
  const startingSize = await logSize(serviceLogPath);
  await run(path.join(scriptDirectory, "restart"), [], { cwd: sourceRoot, env: process.env });
  await waitForHealthyService(serviceLogPath, startingSize);
}

async function acquireDeploymentLock(lockPath) {
  try {
    await fs.mkdir(lockPath, { mode: 0o700 });
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw new Error("Another LookupBot deployment is already running.");
    }
    throw error;
  }
}

async function stageRelease({ commit, deployRoot, git, npm, releasePath, sourceRoot, tar }) {
  if (await pathExists(releasePath)) {
    return;
  }

  const releasesRoot = path.dirname(releasePath);
  const stagingPath = path.join(releasesRoot, `${commit}.staging-${process.pid}`);
  const archivePath = path.join(deployRoot, `${commit}.archive-${process.pid}.tar`);
  await fs.mkdir(stagingPath);

  try {
    await run(git, ["archive", "--format=tar", `--output=${archivePath}`, commit], { cwd: sourceRoot });
    await run(tar, ["-xf", archivePath, "-C", stagingPath], { cwd: sourceRoot });
    await fs.rm(archivePath, { force: true });
    await run(npm, ["ci"], { cwd: stagingPath, env: process.env });
    await run(npm, ["run", "check:bot"], { cwd: stagingPath, env: process.env });
    await fs.symlink(path.join(sourceRoot, ".env"), path.join(stagingPath, ".env"), "file");
    await fs.symlink(path.join(sourceRoot, "logs"), path.join(stagingPath, "logs"), "dir");
    await fs.rename(stagingPath, releasePath);
  } catch (error) {
    await fs.rm(archivePath, { force: true });
    await fs.rm(stagingPath, { recursive: true, force: true });
    throw error;
  }
}

async function deploy() {
  const sourceRoot = projectRoot();
  const git = process.env.CMIBOT_GIT || "/usr/bin/git";
  const npm = process.env.CMIBOT_NPM || "/opt/homebrew/bin/npm";
  const tar = process.env.CMIBOT_TAR || "/usr/bin/tar";
  const deployRoot = process.env.CMIBOT_DEPLOY_ROOT || path.join(sourceRoot, ".deploy");
  const releasesRoot = path.join(deployRoot, "releases");
  const lockPath = path.join(deployRoot, "deploy.lock");
  const currentLink = path.join(deployRoot, "current");
  const previousLink = path.join(deployRoot, "previous");
  const environmentPath = path.join(sourceRoot, ".env");
  const logsPath = path.join(sourceRoot, "logs");
  const serviceLogPath = path.join(logsPath, "cmibot-service.log");

  const status = await capture(git, ["status", "--porcelain=v1", "--untracked-files=normal"], { cwd: sourceRoot });
  if (status) {
    throw new Error("The source worktree is not clean; refusing to deploy.");
  }
  await fs.access(environmentPath);
  const commit = await capture(git, ["rev-parse", "--verify", "HEAD^{commit}"], { cwd: sourceRoot });
  if (!/^[0-9a-f]{40}$/i.test(commit)) {
    throw new Error("Git did not return a full commit ID.");
  }

  await fs.mkdir(releasesRoot, { recursive: true, mode: 0o700 });
  await fs.mkdir(logsPath, { recursive: true, mode: 0o700 });
  await acquireDeploymentLock(lockPath);

  try {
    const releasePath = path.join(releasesRoot, commit);
    try {
      await stageRelease({ commit, deployRoot, git, npm, releasePath, sourceRoot, tar });
    } catch (error) {
      throw new Error(`Release verification failed before activation; current release was not changed. ${error.message}`);
    }
    const nextTarget = path.relative(deployRoot, releasePath);
    const previousTarget = await readOptionalSymlink(currentLink);
    if (previousTarget) {
      validateReleaseTarget(deployRoot, releasesRoot, previousTarget);
    }
    const initialLogSize = await logSize(serviceLogPath);
    await atomicSymlink(currentLink, nextTarget);

    try {
      await run(path.join(scriptDirectory, "restart"), [], { cwd: sourceRoot, env: process.env });
      await waitForHealthyService(serviceLogPath, initialLogSize);
      if (previousTarget && previousTarget !== nextTarget) {
        await atomicSymlink(previousLink, previousTarget);
      }
      console.log(`Deployed ${commit}.`);
    } catch (deploymentError) {
      if (!previousTarget) {
        await fs.rm(currentLink, { force: true });
        await run(path.join(scriptDirectory, "stop"), [], { cwd: sourceRoot, env: process.env }).catch(() => {});
        throw new Error(`${deploymentError.message} No previous release was available; the service was stopped.`);
      }

      await atomicSymlink(currentLink, previousTarget);
      try {
        await restartAndWaitForHealth(sourceRoot, serviceLogPath);
      } catch (rollbackError) {
        throw new Error(
          `${deploymentError.message} The previous release was reselected, but rollback health verification failed: ${rollbackError.message}`,
        );
      }
      throw new Error(`${deploymentError.message} Restored the previous release and verified it healthy.`);
    }
  } finally {
    await fs.rm(lockPath, { recursive: true, force: true });
  }
}

async function rollback() {
  const sourceRoot = projectRoot();
  const deployRoot = process.env.CMIBOT_DEPLOY_ROOT || path.join(sourceRoot, ".deploy");
  const releasesRoot = path.join(deployRoot, "releases");
  const currentLink = path.join(deployRoot, "current");
  const previousLink = path.join(deployRoot, "previous");
  const lockPath = path.join(deployRoot, "deploy.lock");
  const serviceLogPath = path.join(sourceRoot, "logs", "cmibot-service.log");

  await fs.mkdir(deployRoot, { recursive: true, mode: 0o700 });
  await acquireDeploymentLock(lockPath);
  try {
    const currentTarget = await readOptionalSymlink(currentLink);
    const previousTarget = await readOptionalSymlink(previousLink);
    if (!currentTarget || !previousTarget) {
      throw new Error("Both current and previous verified releases are required for rollback.");
    }
    validateReleaseTarget(deployRoot, releasesRoot, currentTarget);
    validateReleaseTarget(deployRoot, releasesRoot, previousTarget);
    if (currentTarget === previousTarget) {
      throw new Error("Current and previous point to the same release; refusing a meaningless rollback.");
    }

    await atomicSymlink(currentLink, previousTarget);
    try {
      await restartAndWaitForHealth(sourceRoot, serviceLogPath);
    } catch (rollbackError) {
      await atomicSymlink(currentLink, currentTarget);
      try {
        await restartAndWaitForHealth(sourceRoot, serviceLogPath);
      } catch (recoveryError) {
        throw new Error(
          `Rollback failed: ${rollbackError.message} The original release was reselected, but recovery health verification also failed: ${recoveryError.message}`,
        );
      }
      throw new Error(`Rollback failed: ${rollbackError.message} Restored and verified the original release.`);
    }

    await atomicSymlink(previousLink, currentTarget);
    const restoredCommit = path.basename(path.resolve(deployRoot, previousTarget));
    console.log(`Rolled back to ${restoredCommit}.`);
  } finally {
    await fs.rm(lockPath, { recursive: true, force: true });
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    await deploy();
    return;
  }
  if (args.length === 1 && args[0] === "--rollback") {
    await rollback();
    return;
  }
  throw new Error("Usage: deploy [--rollback]");
}

main().catch((error) => {
  console.error(`Deployment failed: ${error.message}`);
  process.exitCode = 1;
});
