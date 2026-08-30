#!/usr/bin/env node

import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { isLocalOllamaModelName, normalizeLoopbackOllamaBaseUrl } from "../src/ollama.js";
import {
  readPrivateEnvironmentFile as readValidatedPrivateEnvironmentFile,
} from "../src/privateEnvironment.js";

const execFileAsync = promisify(execFile);
const label = "com.mrfdev.cmibot";
const ADMIN_ALERT_CHANNEL_KEY = "DISCORD_ADMIN_ALERT_CHANNEL_ID";
const ALLOWED_CHANNELS_KEY = "DISCORD_ALLOWED_CHANNEL_IDS";
const TEST_CHANNELS_KEY = "DISCORD_TEST_CHANNEL_IDS";
const LEGACY_TEST_CHANNELS_KEY = "DISCORD_CMI_TEST_CHANNEL_IDS";
const PLUGIN_CHANNEL_KEYS = [
  "DISCORD_CMI_CHANNEL_IDS",
  "DISCORD_JOBS_CHANNEL_IDS",
  "DISCORD_SVIS_CHANNEL_IDS",
  "DISCORD_MFM_CHANNEL_IDS",
  "DISCORD_TRYME_CHANNEL_IDS",
  "DISCORD_TRADEME_CHANNEL_IDS",
  "DISCORD_RESIDENCE_CHANNEL_IDS",
  "DISCORD_BOTTLEDEXP_CHANNEL_IDS",
];
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
  await readPrivateEnvironmentFile(path.join(projectRoot(), ".env"));
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

  await readPrivateEnvironmentFile(path.join(projectRoot(), ".env"));

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

async function readPrivateEnvironmentFile(environmentPath, options = {}) {
  return readValidatedPrivateEnvironmentFile(environmentPath, {
    ...options,
    maxBytes: MAX_ENV_FILE_BYTES,
  });
}

function environmentLines(contents) {
  const lines = contents.split(/\r?\n/);
  if (lines.at(-1) === "") {
    lines.pop();
  }
  return lines;
}

function findEnvironmentAssignment(contents, key) {
  const lines = environmentLines(contents);
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const assignmentPattern = new RegExp(`^\\s*(?:export\\s+)?${escapedKey}\\s*=\\s*(.*)$`);
  const matches = lines
    .map((line, index) => {
      const match = line.match(assignmentPattern);
      return match ? { index, value: match[1] } : null;
    })
    .filter(Boolean);

  if (matches.length > 1) {
    throw new Error("The private environment file contains a duplicate private setting.");
  }
  return matches[0] ?? null;
}

function replaceEnvironmentAssignment(contents, key, value) {
  const newline = contents.includes("\r\n") ? "\r\n" : "\n";
  const lines = environmentLines(contents);
  const match = findEnvironmentAssignment(contents, key);

  const assignment = `${key}=${value}`;
  if (match) {
    lines[match.index] = assignment;
  } else {
    lines.push(assignment);
  }
  return `${lines.join(newline)}${newline}`;
}

function parsePrivateEnvironmentScalar(contents, key, fallback = "") {
  const assignment = findEnvironmentAssignment(contents, key);
  if (!assignment) {
    return fallback;
  }
  let value = assignment.value.trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  if (/\r|\n|[\u0000-\u001f\u007f]/.test(value) || value.length > 512) {
    throw new Error("The private local AI configuration is invalid.");
  }
  return value;
}

function parsePrivateBoolean(value, fallback) {
  if (value == null || value === "") {
    return fallback;
  }
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new Error("The private local AI configuration is invalid.");
}

async function reportAiStatus() {
  const environmentPath = path.join(projectRoot(), ".env");
  const contents = await readPrivateEnvironmentFile(environmentPath);
  const aiEnabled = parsePrivateBoolean(parsePrivateEnvironmentScalar(contents, "AI_ENABLED", "true"), true);
  const ollamaEnabled = parsePrivateBoolean(parsePrivateEnvironmentScalar(contents, "OLLAMA_ENABLED", "true"), true);
  const externalEnabled = parsePrivateBoolean(
    parsePrivateEnvironmentScalar(contents, "AI_EXTERNAL_PROVIDERS_ENABLED", "false"),
    false,
  );
  const paidBudget = Number(parsePrivateEnvironmentScalar(contents, "AI_PAID_BUDGET_USD", "0"));

  console.log("Local AI mode: zero-cost and local-only.");
  if (externalEnabled || paidBudget !== 0 || !Number.isFinite(paidBudget)) {
    console.log("External providers and paid usage: rejected by the safety lock.");
    console.log("Local generation: unavailable because the safety lock rejected its configuration.");
    process.exitCode = 3;
    return;
  }
  console.log("External providers: disabled.");
  console.log("Paid budget: locked to zero.");
  if (!aiEnabled || !ollamaEnabled) {
    console.log("Local generation: disabled; cited fallback remains available.");
    process.exitCode = 3;
    return;
  }

  const baseUrl = normalizeLoopbackOllamaBaseUrl(
    parsePrivateEnvironmentScalar(contents, "OLLAMA_BASE_URL", "http://127.0.0.1:11434"),
  );
  const model = parsePrivateEnvironmentScalar(contents, "OLLAMA_MODEL", "qwen3:8b");
  if (!baseUrl || !isLocalOllamaModelName(model)) {
    console.log("Local generation: unavailable because the local configuration is invalid.");
    process.exitCode = 3;
    return;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2_000);
  timeout.unref?.();
  try {
    const response = await fetch(`${baseUrl}/api/tags`, {
      method: "GET",
      redirect: "error",
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
    if (!response.ok) {
      throw new Error("unavailable");
    }
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > 1024 * 1024) {
      throw new Error("unavailable");
    }
    const body = JSON.parse(text);
    const installed = Array.isArray(body.models) && body.models.some(
      (item) => item?.name === model || item?.model === model,
    );
    if (installed) {
      console.log("Local generation: ready with the configured local model.");
      return;
    }
    console.log("Local generation: unavailable because the configured local model is not installed.");
    process.exitCode = 3;
  } catch {
    console.log("Local generation: unavailable; cited fallback remains available.");
    process.exitCode = 3;
  } finally {
    clearTimeout(timeout);
  }
}

function parsePrivateChannelList(contents, key) {
  const assignment = findEnvironmentAssignment(contents, key);
  if (!assignment) {
    return null;
  }

  let value = assignment.value.trim();
  if (!value) {
    return [];
  }

  if (value.startsWith('"') || value.startsWith("'")) {
    const quote = value[0];
    if (value.length < 2 || value.at(-1) !== quote) {
      throw new Error("The existing private channel configuration is invalid.");
    }
    value = value.slice(1, -1);
  }

  const channelIds = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (
    !channelIds.every((channelId) => /^\d{17,20}$/.test(channelId)) ||
    new Set(channelIds).size !== channelIds.length
  ) {
    throw new Error("The existing private channel configuration is invalid.");
  }
  return channelIds;
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
  const current = await readPrivateEnvironmentFile(environmentPath, {
    allowBroadPermissions: true,
  });
  const updated = replaceEnvironmentAssignment(current, ADMIN_ALERT_CHANNEL_KEY, value);
  await writePrivateEnvironmentFile(environmentPath, updated);
  console.log("LookupBot admin alert destination configured privately.");
}

async function configureTestChannel() {
  const value = await readPrivateLine();
  if (!/^\d{17,20}$/.test(value)) {
    throw new Error("Private configuration input is invalid.");
  }

  const environmentPath = path.join(projectRoot(), ".env");
  const current = await readPrivateEnvironmentFile(environmentPath, {
    allowBroadPermissions: true,
  });
  const allowedChannelIds = parsePrivateChannelList(current, ALLOWED_CHANNELS_KEY);
  if (!allowedChannelIds) {
    throw new Error("The private allowed-channel setting is unavailable.");
  }

  const configuredTestChannelIds = parsePrivateChannelList(current, TEST_CHANNELS_KEY);
  const testChannelIds = configuredTestChannelIds?.length
    ? configuredTestChannelIds
    : (parsePrivateChannelList(current, LEGACY_TEST_CHANNELS_KEY) ?? []);
  const isPluginRoute = PLUGIN_CHANNEL_KEYS.some((key) =>
    (parsePrivateChannelList(current, key) ?? []).includes(value),
  );
  if (isPluginRoute) {
    throw new Error("The private channel is already assigned to another route.");
  }
  const updatedAllowedChannelIds = [...new Set([...allowedChannelIds, value])];
  const updatedTestChannelIds = [...new Set([...testChannelIds, value])];

  let updated = replaceEnvironmentAssignment(
    current,
    ALLOWED_CHANNELS_KEY,
    updatedAllowedChannelIds.join(","),
  );
  updated = replaceEnvironmentAssignment(
    updated,
    TEST_CHANNELS_KEY,
    updatedTestChannelIds.join(","),
  );
  await writePrivateEnvironmentFile(environmentPath, updated);
  console.log("LookupBot private test channel configured.");
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
  } else if (command === "ai-status") {
    await reportAiStatus();
  } else if (command === "start") {
    await startService();
  } else if (command === "stop") {
    await stopService();
  } else if (command === "restart") {
    await restartService();
  } else if (command === "configure-alert-channel") {
    await configureAlertChannel();
  } else if (command === "configure-test-channel") {
    await configureTestChannel();
  } else if (command === "logs") {
    await displayLogs(process.argv.slice(3));
  } else if (command === "install") {
    await installServiceDefinition();
  } else {
    console.error(
      "Usage: cmibot-ops.mjs <ai-status|configure-alert-channel|configure-test-channel|install|logs|restart|start|status|stop>",
    );
    process.exitCode = 64;
  }
}

main().catch((error) => {
  console.error(`LookupBot operation failed: ${error.message}`);
  process.exitCode = 1;
});
