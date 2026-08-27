#!/usr/bin/env node

import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_CONFIG_PATH = path.join(repositoryRoot, ".cmibot-remote.json");
const MAX_CONFIG_BYTES = 16 * 1024;
const SSH_OPTIONS = ["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10"];
const EXPECTED_CONFIG_KEYS = ["host", "nodePath", "projectRoot"];

class UsageError extends Error {}
class ConfigurationError extends Error {}

function assertNoArguments(command, args) {
  if (args.length) {
    throw new UsageError(`${command} does not accept arguments.`);
  }
}

function validateLogArguments(args) {
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--follow" || argument === "-f") {
      continue;
    }
    if (argument === "--lines" || argument === "-n") {
      const value = args[index + 1];
      if (!/^\d+$/.test(value ?? "") || Number(value) < 1 || Number(value) > 10_000) {
        throw new UsageError("--lines must be an integer from 1 through 10000.");
      }
      index += 1;
      continue;
    }
    throw new UsageError(`Unknown logs argument: ${argument}`);
  }
}

function parseOperation(command, args) {
  if (command === "ai-install") {
    assertNoArguments(command, args);
    return { script: "ai-install", args: [] };
  }

  if (
    command === "status" ||
    command === "ai-status" ||
    command === "restart" ||
    command === "configure-alert-channel" ||
    command === "configure-test-channel"
  ) {
    assertNoArguments(command, args);
    return { script: "operations", args: [command] };
  }

  if (command === "update") {
    assertNoArguments(command, args);
    return { script: "update", args: [] };
  }

  if (command === "logs") {
    validateLogArguments(args);
    return { script: "operations", args: ["logs", ...args] };
  }

  if (command === "deploy") {
    if (args.length > 1 || (args.length === 1 && args[0] !== "--rollback")) {
      throw new UsageError("deploy accepts only the optional --rollback argument.");
    }
    return { script: "deploy", args };
  }

  throw new UsageError(
    "Usage: remote <ai-install|ai-status|configure-alert-channel|configure-test-channel|deploy [--rollback]|logs [--lines N] [--follow]|restart|status|update>",
  );
}

function validateHost(value) {
  const destinationPattern = /^(?:[A-Za-z0-9._-]+@)?(?:[A-Za-z0-9][A-Za-z0-9._-]*|\[[0-9A-Fa-f:.]+\])$/;
  if (typeof value !== "string" || value.startsWith("-") || value.length > 255 || !destinationPattern.test(value)) {
    throw new ConfigurationError("Remote configuration has an invalid SSH destination.");
  }
  return value;
}

function validateAbsolutePath(value, label, { allowRoot = false } = {}) {
  if (
    typeof value !== "string" ||
    value.length > 4096 ||
    !path.posix.isAbsolute(value) ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new ConfigurationError(`Remote configuration has an invalid ${label}.`);
  }

  const normalized = path.posix.normalize(value);
  if (!allowRoot && normalized === "/") {
    throw new ConfigurationError(`Remote configuration has an invalid ${label}.`);
  }
  return normalized;
}

function parseConfiguration(contents) {
  let raw;
  try {
    raw = JSON.parse(contents);
  } catch {
    throw new ConfigurationError("Remote configuration is not valid JSON.");
  }

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigurationError("Remote configuration must be a JSON object.");
  }

  const keys = Object.keys(raw).sort();
  if (keys.length !== EXPECTED_CONFIG_KEYS.length || keys.some((key, index) => key !== EXPECTED_CONFIG_KEYS[index])) {
    throw new ConfigurationError("Remote configuration must contain only host, nodePath, and projectRoot.");
  }

  return Object.freeze({
    host: validateHost(raw.host),
    nodePath: validateAbsolutePath(raw.nodePath, "Node executable path"),
    projectRoot: validateAbsolutePath(raw.projectRoot, "project path"),
  });
}

async function loadConfiguration() {
  const configPath = process.env.CMIBOT_REMOTE_CONFIG
    ? path.resolve(process.env.CMIBOT_REMOTE_CONFIG)
    : DEFAULT_CONFIG_PATH;
  let handle;

  try {
    handle = await open(configPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch {
    throw new ConfigurationError(
      "Remote configuration is unavailable. Create the ignored .cmibot-remote.json file from the tracked example.",
    );
  }

  try {
    const stats = await handle.stat();
    if (!stats.isFile()) {
      throw new ConfigurationError("Remote configuration must be a regular file.");
    }
    if (typeof process.getuid === "function" && stats.uid !== process.getuid()) {
      throw new ConfigurationError("Remote configuration must be owned by the current user.");
    }
    if ((stats.mode & 0o077) !== 0) {
      throw new ConfigurationError("Remote configuration permissions must be owner-only (chmod 600).");
    }
    if (stats.size > MAX_CONFIG_BYTES) {
      throw new ConfigurationError("Remote configuration is unexpectedly large.");
    }

    return parseConfiguration(await handle.readFile("utf8"));
  } catch (error) {
    if (error instanceof ConfigurationError) {
      throw error;
    }
    throw new ConfigurationError("Remote configuration could not be read.");
  } finally {
    await handle.close().catch(() => {});
  }
}

function shellQuote(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function buildRemoteCommand(configuration, operation) {
  const scriptName =
    operation.script === "ai-install"
      ? "install-local-ai.mjs"
      : operation.script === "deploy"
      ? "deploy.mjs"
      : operation.script === "update"
        ? "safe-update.mjs"
        : "cmibot-ops.mjs";
  const scriptPath = path.posix.join(configuration.projectRoot, "scripts", scriptName);
  const command = [configuration.nodePath, scriptPath, ...operation.args].map(shellQuote).join(" ");
  if (operation.script !== "update") {
    return command;
  }

  const remotePath = [path.posix.dirname(configuration.nodePath), "/usr/bin", "/bin", "/usr/sbin", "/sbin"]
    .filter((directory, index, entries) => entries.indexOf(directory) === index)
    .join(":");
  return `PATH=${shellQuote(remotePath)} ${command}`;
}

async function runRemote(configuration, remoteCommand) {
  const ssh = process.env.CMIBOT_SSH || "/usr/bin/ssh";
  return new Promise((resolve, reject) => {
    const child = spawn(ssh, [...SSH_OPTIONS, configuration.host, remoteCommand], {
      stdio: "inherit",
    });
    child.once("error", () => reject(new Error("The SSH client could not be started.")));
    child.once("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`The SSH client exited with signal ${signal}.`));
        return;
      }
      resolve(code ?? 1);
    });
  });
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const operation = parseOperation(command, args);
  const configuration = await loadConfiguration();
  process.exitCode = await runRemote(configuration, buildRemoteCommand(configuration, operation));
}

main().catch((error) => {
  console.error(`LookupBot remote operation failed: ${error.message}`);
  process.exitCode = error instanceof UsageError ? 64 : error instanceof ConfigurationError ? 78 : 1;
});
