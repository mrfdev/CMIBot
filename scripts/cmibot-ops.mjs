#!/usr/bin/env node

import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const label = "com.mrfdev.cmibot";

function launchdDomain() {
  const uid = process.env.CMIBOT_UID || String(process.getuid());
  return `gui/${uid}`;
}

function launchdTarget() {
  return `${launchdDomain()}/${label}`;
}

function launchctlPath() {
  return process.env.CMIBOT_LAUNCHCTL || "/bin/launchctl";
}

function installedPlistPath() {
  const directory = process.env.CMIBOT_LAUNCH_AGENTS_DIR || path.join(os.homedir(), "Library", "LaunchAgents");
  return path.join(directory, `${label}.plist`);
}

function projectRoot() {
  return process.env.CMIBOT_PROJECT_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

function configuredMilliseconds(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined) {
    return fallback;
  }
  if (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > 60_000) {
    throw new Error(`${name} must be an integer from 1 through 60000.`);
  }
  return Number(raw);
}

async function readLaunchdJob() {
  try {
    const { stdout } = await execFileAsync(launchctlPath(), ["print", launchdTarget()], {
      encoding: "utf8",
    });
    return stdout;
  } catch (error) {
    if (typeof error?.code === "number") {
      return null;
    }
    throw error;
  }
}

async function reportStatus() {
  const job = await readLaunchdJob();
  const state = job?.match(/^\s*state\s*=\s*(\S+)/m)?.[1];
  const pid = job?.match(/^\s*pid\s*=\s*(\d+)/m)?.[1];

  if (state === "running" && pid) {
    console.log(`LookupBot is running (pid ${pid}).`);
    return;
  }

  console.log("LookupBot is stopped.");
  process.exitCode = 3;
}

async function waitForRunningJob() {
  const timeout = configuredMilliseconds("CMIBOT_START_TIMEOUT_MS", 10_000);
  const interval = configuredMilliseconds("CMIBOT_START_INTERVAL_MS", 100);
  const deadline = Date.now() + timeout;

  while (Date.now() <= deadline) {
    const job = await readLaunchdJob();
    const state = job?.match(/^\s*state\s*=\s*(\S+)/m)?.[1];
    const pid = job?.match(/^\s*pid\s*=\s*(\d+)/m)?.[1];
    if (state === "running" && pid) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }

  throw new Error(`launchd accepted the job, but LookupBot did not reach the running state within ${timeout}ms.`);
}

async function waitForUnloadedJob() {
  const timeout = configuredMilliseconds("CMIBOT_STOP_TIMEOUT_MS", 30_000);
  const interval = configuredMilliseconds("CMIBOT_STOP_INTERVAL_MS", 100);
  const deadline = Date.now() + timeout;

  while (Date.now() <= deadline) {
    if (!(await readLaunchdJob())) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }

  throw new Error(`launchd accepted the stop request, but LookupBot remained loaded after ${timeout}ms.`);
}

async function startService({ announce = true } = {}) {
  const currentJob = await readLaunchdJob();
  if (currentJob?.match(/^\s*state\s*=\s*running\s*$/m)) {
    if (announce) {
      console.log("LookupBot is already running.");
    }
    return;
  }

  if (currentJob) {
    await execFileAsync(launchctlPath(), ["kickstart", launchdTarget()], {
      encoding: "utf8",
    });
  } else {
    const plist = installedPlistPath();
    await fs.access(plist);
    await execFileAsync(launchctlPath(), ["bootstrap", launchdDomain(), plist], {
      encoding: "utf8",
    });
  }

  await waitForRunningJob();
  if (announce) {
    console.log("LookupBot started.");
  }
}

async function stopService({ announce = true } = {}) {
  const currentJob = await readLaunchdJob();
  if (!currentJob) {
    if (announce) {
      console.log("LookupBot is already stopped.");
    }
    return;
  }

  await execFileAsync(launchctlPath(), ["bootout", launchdTarget()], {
    encoding: "utf8",
  });

  await waitForUnloadedJob();
  if (announce) {
    console.log("LookupBot stopped.");
  }
}

async function restartService() {
  await stopService({ announce: false });
  await startService({ announce: false });
  console.log("LookupBot restarted.");
}

function parseLogArguments(args) {
  let follow = false;
  let lines = 100;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--follow" || argument === "-f") {
      follow = true;
      continue;
    }
    if (argument === "--lines" || argument === "-n") {
      const value = args[index + 1];
      if (!/^\d+$/.test(value ?? "") || Number(value) < 1 || Number(value) > 10_000) {
        throw new Error("--lines must be an integer from 1 through 10000.");
      }
      lines = Number(value);
      index += 1;
      continue;
    }
    throw new Error(`Unknown logs argument: ${argument}`);
  }

  return { follow, lines };
}

async function runWithInheritedOutput(command, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${path.basename(command)} exited with ${signal ? `signal ${signal}` : `status ${code}`}.`));
    });
  });
}

async function displayLogs(args) {
  const { follow, lines } = parseLogArguments(args);
  const logsDirectory = path.join(projectRoot(), "logs");
  const candidates = [
    path.join(logsDirectory, "cmibot-service.log"),
    path.join(logsDirectory, "cmibot-service.error.log"),
  ];
  const existing = [];
  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      existing.push(candidate);
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }
  }

  if (existing.length === 0) {
    throw new Error(`No service logs exist in ${logsDirectory}.`);
  }

  const tail = process.env.CMIBOT_TAIL || "/usr/bin/tail";
  const tailArguments = ["-n", String(lines)];
  if (follow) {
    tailArguments.push("-F");
  }
  tailArguments.push(...existing);
  await runWithInheritedOutput(tail, tailArguments);
}

async function main() {
  const command = process.argv[2];

  if (command === "status") {
    await reportStatus();
  } else if (command === "start") {
    await startService();
  } else if (command === "stop") {
    await stopService();
  } else if (command === "restart") {
    await restartService();
  } else if (command === "logs") {
    await displayLogs(process.argv.slice(3));
  } else {
    console.error("Usage: cmibot-ops.mjs <logs|restart|start|status|stop>");
    process.exitCode = 64;
  }
}

main().catch((error) => {
  console.error(`LookupBot operation failed: ${error.message}`);
  process.exitCode = 1;
});
