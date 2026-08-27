#!/usr/bin/env node

import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const label = "com.mrfdev.cmibot";
const ADMIN_ALERT_CHANNEL_KEY = "DISCORD_ADMIN_ALERT_CHANNEL_ID";
const MAX_PRIVATE_INPUT_BYTES = 128;
const MAX_ENV_FILE_BYTES = 1024 * 1024;

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

function xmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

async function renderServiceDefinition() {
  const root = path.resolve(projectRoot());
  const currentRelease = path.join(root, ".deploy", "current");
  const node = process.env.CMIBOT_NODE || process.execPath;
  if (!path.isAbsolute(node)) {
    throw new Error("The configured Node executable must be absolute.");
  }
  const executablePath = [...new Set([path.dirname(node), "/usr/bin", "/bin", "/usr/sbin", "/sbin"])]
    .join(path.delimiter);
  const templatePath = path.join(root, "operations", `${label}.plist`);
  let template = await fs.readFile(templatePath, "utf8");
  const replacements = {
    __NODE_EXECUTABLE__: node,
    __SERVICE_RUNNER__: path.join(root, "scripts", "service-runner.mjs"),
    __WORKING_DIRECTORY__: currentRelease,
    __EXECUTABLE_PATH__: executablePath,
  };

  for (const [placeholder, value] of Object.entries(replacements)) {
    if (!template.includes(placeholder)) {
      throw new Error("The service definition template is incomplete.");
    }
    template = template.replaceAll(placeholder, xmlEscape(value));
  }
  if (/__[A-Z0-9_]+__/.test(template)) {
    throw new Error("The service definition template contains an unresolved placeholder.");
  }
  return template;
}

async function installServiceDefinition({ announce = true } = {}) {
  const destination = installedPlistPath();
  const temporary = `${destination}.tmp-${process.pid}`;
  const definition = await renderServiceDefinition();
  await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  try {
    await fs.writeFile(temporary, definition, { encoding: "utf8", mode: 0o600 });
    await fs.rename(temporary, destination);
    await fs.chmod(destination, 0o600);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
  if (announce) {
    console.log("LookupBot service definition installed.");
  }
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
  await installServiceDefinition({ announce: false });
  await stopService({ announce: false });
  await startService({ announce: false });
  console.log("LookupBot restarted.");
}

async function readPrivateLine() {
  process.stdin.setEncoding("utf8");
  let input = "";

  for await (const chunk of process.stdin) {
    input += chunk;
    if (Buffer.byteLength(input, "utf8") > MAX_PRIVATE_INPUT_BYTES) {
      throw new Error("Private configuration input is invalid.");
    }
  }

  const value = input.replace(/\r?\n$/, "");
  if (value.includes("\n") || value.includes("\r")) {
    throw new Error("Private configuration input is invalid.");
  }
  return value;
}

async function readPrivateEnvironmentFile(environmentPath) {
  let handle;
  try {
    handle = await fs.open(environmentPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch {
    throw new Error("The private environment file is unavailable.");
  }

  try {
    const stats = await handle.stat();
    if (!stats.isFile()) {
      throw new Error("The private environment file must be a regular file.");
    }
    if (typeof process.getuid === "function" && stats.uid !== process.getuid()) {
      throw new Error("The private environment file must be owned by the service user.");
    }
    if (stats.size > MAX_ENV_FILE_BYTES) {
      throw new Error("The private environment file is unexpectedly large.");
    }
    return await handle.readFile("utf8");
  } finally {
    await handle.close().catch(() => {});
  }
}

function replaceEnvironmentAssignment(contents, key, value) {
  const newline = contents.includes("\r\n") ? "\r\n" : "\n";
  const lines = contents.split(/\r?\n/);
  if (lines.at(-1) === "") {
    lines.pop();
  }

  const assignmentPattern = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`);
  const matchingIndexes = lines
    .map((line, index) => (assignmentPattern.test(line) ? index : -1))
    .filter((index) => index !== -1);
  if (matchingIndexes.length > 1) {
    throw new Error("The private environment file contains a duplicate alert destination setting.");
  }

  const assignment = `${key}=${value}`;
  if (matchingIndexes.length === 1) {
    lines[matchingIndexes[0]] = assignment;
  } else {
    lines.push(assignment);
  }
  return `${lines.join(newline)}${newline}`;
}

async function writePrivateEnvironmentFile(environmentPath, contents) {
  const temporaryPath = `${environmentPath}.tmp-${process.pid}-${randomUUID()}`;
  let handle;
  try {
    handle = await fs.open(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(temporaryPath, environmentPath);
    await fs.chmod(environmentPath, 0o600);
  } finally {
    await handle?.close().catch(() => {});
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
  }
}

async function configureAlertChannel() {
  const value = await readPrivateLine();
  if (!/^\d{17,20}$/.test(value)) {
    throw new Error("Private configuration input is invalid.");
  }

  const environmentPath = path.join(projectRoot(), ".env");
  const current = await readPrivateEnvironmentFile(environmentPath);
  const updated = replaceEnvironmentAssignment(current, ADMIN_ALERT_CHANNEL_KEY, value);
  await writePrivateEnvironmentFile(environmentPath, updated);
  console.log("LookupBot admin alert destination configured privately.");
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
  } else if (command === "configure-alert-channel") {
    await configureAlertChannel();
  } else if (command === "logs") {
    await displayLogs(process.argv.slice(3));
  } else if (command === "install") {
    await installServiceDefinition();
  } else {
    console.error(
      "Usage: cmibot-ops.mjs <configure-alert-channel|install|logs|restart|start|status|stop>",
    );
    process.exitCode = 64;
  }
}

main().catch((error) => {
  console.error(`LookupBot operation failed: ${error.message}`);
  process.exitCode = 1;
});
