#!/usr/bin/env node

import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { OllamaProvider, normalizeLoopbackOllamaBaseUrl } from "../src/ollama.js";

const execFileAsync = promisify(execFile);
const OLLAMA_LABEL = "com.mrfdev.cmibot.ollama";
const APPROVED_MODEL = "qwen3:8b";
const MAX_CONFIG_BYTES = 64 * 1024;
const MAX_API_RESPONSE_BYTES = 1024 * 1024;
const MINIMUM_FREE_BYTES = 8n * 1024n * 1024n * 1024n;

function projectRoot() {
  return process.env.CMIBOT_PROJECT_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

function configuredPath(name, fallback) {
  const value = process.env[name] || fallback;
  if (!path.isAbsolute(value) || path.normalize(value) === path.parse(value).root || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error("invalid-private-path");
  }
  return path.normalize(value);
}

function configuredMilliseconds(name, fallback, maximum) {
  const value = process.env[name];
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > maximum) {
    throw new Error("invalid-timeout");
  }
  return Number(value);
}

function xmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

async function secureDirectory(directory, mode = 0o700) {
  try {
    const stats = await fs.lstat(directory);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new Error("unsafe-directory");
    }
    if (typeof process.getuid === "function" && stats.uid !== process.getuid()) {
      throw new Error("unsafe-owner");
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    await fs.mkdir(directory, { recursive: true, mode });
  }
  await fs.chmod(directory, mode);
}

async function requireInstallationSpace(directory) {
  const stats = await fs.statfs(directory);
  const available = BigInt(stats.bavail) * BigInt(stats.bsize);
  if (available < MINIMUM_FREE_BYTES) throw new Error("insufficient-space");
}

async function readOwnerJson(filePath) {
  let handle;
  try {
    handle = await fs.open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw error;
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile() || stats.size > MAX_CONFIG_BYTES) throw new Error("unsafe-config");
    if (typeof process.getuid === "function" && stats.uid !== process.getuid()) {
      throw new Error("unsafe-owner");
    }
    const value = JSON.parse(await handle.readFile("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("unsafe-config");
    return value;
  } finally {
    await handle.close().catch(() => {});
  }
}

async function atomicOwnerWrite(filePath, contents) {
  const temporaryPath = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
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
    await fs.rename(temporaryPath, filePath);
    await fs.chmod(filePath, 0o600);
  } finally {
    await handle?.close().catch(() => {});
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
  }
}

async function configureLocalOnlyMode(stateDirectory) {
  const configPath = path.join(stateDirectory, "server.json");
  const current = await readOwnerJson(configPath);
  await atomicOwnerWrite(
    configPath,
    `${JSON.stringify({ ...current, disable_ollama_cloud: true }, null, 2)}\n`,
  );
}

async function executableAt(candidate) {
  if (!candidate || !path.isAbsolute(candidate) || /[\u0000-\u001f\u007f]/.test(candidate)) return "";
  try {
    const real = await fs.realpath(candidate);
    const stats = await fs.stat(real);
    if (!stats.isFile()) return "";
    await fs.access(real, constants.X_OK);
    return real;
  } catch {
    return "";
  }
}

async function findOllamaExecutable() {
  const candidates = [
    process.env.CMIBOT_OLLAMA_BINARY,
    "/opt/homebrew/bin/ollama",
    "/usr/local/bin/ollama",
  ];
  for (const candidate of candidates) {
    const executable = await executableAt(candidate);
    if (executable) return executable;
  }
  return "";
}

async function findBrewExecutable() {
  const candidates = [
    process.env.CMIBOT_BREW,
    "/opt/homebrew/bin/brew",
    "/usr/local/bin/brew",
  ];
  for (const candidate of candidates) {
    const executable = await executableAt(candidate);
    if (executable) return executable;
  }
  throw new Error("brew-unavailable");
}

async function runQuiet(command, args, { env = process.env, logger = console, progressMessage = "" } = {}) {
  let progress;
  try {
    if (progressMessage) {
      progress = setInterval(() => logger.log(progressMessage), 30_000);
      progress.unref?.();
    }
    await new Promise((resolve, reject) => {
      const child = spawn(command, args, { env, stdio: "ignore" });
      child.once("error", reject);
      child.once("exit", (code, signal) => {
        if (code === 0) resolve();
        else reject(new Error(signal ? "command-signalled" : `command-exit-${code}`));
      });
    });
  } finally {
    clearInterval(progress);
  }
}

async function installOllama(logger) {
  let executable = await findOllamaExecutable();
  if (executable) return executable;

  const brew = await findBrewExecutable();
  logger.log("Installing the local AI runtime from the verified Homebrew formula.");
  await runQuiet(brew, ["install", "ollama"], {
    logger,
    progressMessage: "The local AI runtime installation is still in progress.",
  });
  executable = await findOllamaExecutable();
  if (executable) return executable;

  const { stdout } = await execFileAsync(brew, ["--prefix", "ollama"], {
    encoding: "utf8",
    maxBuffer: 16 * 1024,
  });
  const prefix = stdout.trim();
  if (!path.isAbsolute(prefix) || /[\u0000-\u001f\u007f]/.test(prefix)) {
    throw new Error("unsafe-brew-prefix");
  }
  executable = await executableAt(path.join(prefix, "bin", "ollama"));
  if (!executable) throw new Error("ollama-unavailable");
  return executable;
}

async function renderLaunchAgent({ executable, stateDirectory, logsDirectory, baseUrl }) {
  const templatePath = path.join(projectRoot(), "operations", `${OLLAMA_LABEL}.plist`);
  let template = await fs.readFile(templatePath, "utf8");
  const url = new URL(baseUrl);
  const executablePath = [...new Set([path.dirname(executable), "/usr/bin", "/bin", "/usr/sbin", "/sbin"])]
    .join(path.delimiter);
  const replacements = {
    __OLLAMA_EXECUTABLE__: executable,
    __OLLAMA_EXECUTABLE_PATH__: executablePath,
    __OLLAMA_HOME__: os.homedir(),
    __OLLAMA_HOST__: url.host,
    __OLLAMA_STANDARD_ERROR__: path.join(logsDirectory, "cmibot-ollama.error.log"),
    __OLLAMA_STANDARD_OUT__: path.join(logsDirectory, "cmibot-ollama.log"),
    __OLLAMA_STATE_DIRECTORY__: stateDirectory,
  };
  for (const [placeholder, value] of Object.entries(replacements)) {
    if (!template.includes(placeholder)) throw new Error("incomplete-template");
    template = template.replaceAll(placeholder, xmlEscape(value));
  }
  if (/__[A-Z0-9_]+__/.test(template)) throw new Error("unresolved-template");
  return template;
}

function launchdDomain() {
  const uid = process.env.CMIBOT_UID || String(process.getuid());
  return `gui/${uid}`;
}

function launchdTarget() {
  return `${launchdDomain()}/${OLLAMA_LABEL}`;
}

async function readLaunchdJob(launchctl) {
  try {
    const { stdout } = await execFileAsync(launchctl, ["print", launchdTarget()], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    });
    return stdout;
  } catch (error) {
    if (typeof error?.code === "number") return null;
    throw error;
  }
}

async function installLaunchAgent({ executable, stateDirectory, logsDirectory, baseUrl }) {
  const launchctl = await executableAt(process.env.CMIBOT_LAUNCHCTL || "/bin/launchctl");
  if (!launchctl) throw new Error("launchctl-unavailable");
  const launchAgentsDirectory = configuredPath(
    "CMIBOT_OLLAMA_LAUNCH_AGENTS_DIR",
    path.join(os.homedir(), "Library", "LaunchAgents"),
  );
  await secureDirectory(launchAgentsDirectory);
  const destination = path.join(launchAgentsDirectory, `${OLLAMA_LABEL}.plist`);
  const definition = await renderLaunchAgent({ executable, stateDirectory, logsDirectory, baseUrl });

  if (await readLaunchdJob(launchctl)) {
    await execFileAsync(launchctl, ["bootout", launchdTarget()], { encoding: "utf8" });
  }
  await atomicOwnerWrite(destination, definition);
  await execFileAsync(launchctl, ["bootstrap", launchdDomain(), destination], { encoding: "utf8" });
  return launchctl;
}

async function readBoundedJson(response) {
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > MAX_API_RESPONSE_BYTES) throw new Error("oversized-response");
  return JSON.parse(text);
}

async function waitForService({ launchctl, baseUrl, fetchImpl }) {
  const timeoutMs = configuredMilliseconds("CMIBOT_OLLAMA_START_TIMEOUT_MS", 30_000, 120_000);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const job = await readLaunchdJob(launchctl);
    const running = /^\s*state\s*=\s*running\s*$/m.test(job ?? "") && /^\s*pid\s*=\s*\d+\s*$/m.test(job ?? "");
    if (running) {
      try {
        const response = await fetchImpl(`${baseUrl}/api/tags`, {
          redirect: "error",
          signal: AbortSignal.timeout(2_000),
        });
        if (response.ok) {
          await response.body?.cancel();
          return;
        }
      } catch {
        // The launchd job can be running briefly before the loopback API is ready.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("ollama-start-timeout");
}

async function verifyModelInstalled(baseUrl, fetchImpl) {
  const response = await fetchImpl(`${baseUrl}/api/tags`, {
    redirect: "error",
    signal: AbortSignal.timeout(5_000),
    headers: { accept: "application/json" },
  });
  if (!response.ok) throw new Error("ollama-unavailable");
  const body = await readBoundedJson(response);
  if (!Array.isArray(body.models) || !body.models.some((item) => item?.name === APPROVED_MODEL || item?.model === APPROVED_MODEL)) {
    throw new Error("model-unavailable");
  }
}

async function smokeTest(baseUrl, fetchImpl) {
  const provider = new OllamaProvider({
    baseUrl,
    model: APPROVED_MODEL,
    requestTimeoutMs: 120_000,
    statusTimeoutMs: 5_000,
    maxOutputTokens: 128,
  }, { fetchImpl });
  const result = await provider.generate({
    question: "Is the example setting enabled?",
    evidence: [{ id: "E1", profile: "example", name: "example-setting", content: "example-setting: true" }],
  });
  if (!result.citations.includes("E1")) throw new Error("invalid-smoke-response");
}

export async function installLocalAi({
  args = process.argv.slice(2),
  fetchImpl = globalThis.fetch,
  logger = console,
  platform = process.platform,
} = {}) {
  if (args.length !== 0) throw new Error("unexpected-arguments");
  if (platform !== "darwin" && process.env.CMIBOT_OLLAMA_TEST_MODE !== "1") {
    throw new Error("unsupported-platform");
  }
  if (typeof fetchImpl !== "function") throw new Error("fetch-unavailable");

  const baseUrl = normalizeLoopbackOllamaBaseUrl(
    process.env.CMIBOT_OLLAMA_BASE_URL || "http://127.0.0.1:11434",
  );
  if (!baseUrl) throw new Error("non-loopback-endpoint");
  const stateDirectory = configuredPath("CMIBOT_OLLAMA_STATE_DIR", path.join(os.homedir(), ".ollama"));
  const logsDirectory = path.join(stateDirectory, "logs");

  logger.log("Preparing zero-cost local AI with cloud features disabled.");
  await secureDirectory(stateDirectory);
  await requireInstallationSpace(stateDirectory);
  await secureDirectory(logsDirectory);
  await configureLocalOnlyMode(stateDirectory);
  const executable = await installOllama(logger);

  logger.log("Starting the loopback-only local AI service.");
  const launchctl = await installLaunchAgent({ executable, stateDirectory, logsDirectory, baseUrl });
  await waitForService({ launchctl, baseUrl, fetchImpl });

  logger.log("Downloading the approved local model. This may take several minutes.");
  await runQuiet(executable, ["pull", APPROVED_MODEL], {
    env: {
      ...process.env,
      OLLAMA_HOST: new URL(baseUrl).host,
      OLLAMA_NO_CLOUD: "1",
      NO_COLOR: "1",
      TERM: "dumb",
    },
    logger,
    progressMessage: "The approved local model download is still in progress.",
  });

  await verifyModelInstalled(baseUrl, fetchImpl);
  logger.log("Verifying privacy-safe structured local generation.");
  await smokeTest(baseUrl, fetchImpl);
  logger.log("Zero-cost local AI is installed and ready.");
}

const isEntrypoint = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint) {
  installLocalAi().catch(() => {
    console.error("Local AI installation failed safely. LookupBot's cited fallback remains available.");
    process.exitCode = 1;
  });
}
