#!/usr/bin/env node

import path from "node:path";
import { format } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { sanitizeLogText } from "../src/logger.js";
import {
  createServiceLogManager,
  parseServiceLogOptions,
  setActiveServiceLogManager,
} from "../src/serviceLog.js";
import { readPrivateEnvironmentFile } from "../src/privateEnvironment.js";

const LOG_SETTING_NAMES = new Set([
  "SERVICE_LOG_MAX_SIZE_MB",
  "SERVICE_LOG_MAX_FILES",
  "SERVICE_LOG_MIN_FREE_MB",
]);
function readLogSettings(contents = "") {
  const settings = {};
  for (const line of contents.split(/\r?\n/)) {
    const match = line.match(
      /^\s*([A-Z][A-Z0-9_]*)\s*=\s*(?:"([0-9]+)"|'([0-9]+)'|([0-9]+))\s*(?:#.*)?$/,
    );
    if (match && LOG_SETTING_NAMES.has(match[1])) {
      settings[match[1]] = match[2] ?? match[3] ?? match[4];
    }
  }
  return settings;
}

function installConsoleCapture(manager) {
  const info = (...values) => manager.stdout(sanitizeLogText(format(...values)));
  const error = (...values) => manager.stderr(sanitizeLogText(format(...values)));
  console.log = info;
  console.info = info;
  console.debug = info;
  console.error = error;
  console.warn = error;
}

async function main() {
  const sourceRoot = path.resolve(
    process.env.CMIBOT_PROJECT_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
  );
  const currentRelease = path.join(sourceRoot, ".deploy", "current");
  const environmentPath = path.join(sourceRoot, ".env");
  const environmentContents = await readPrivateEnvironmentFile(environmentPath, {
    allowMissing: true,
  });
  const fileSettings = readLogSettings(environmentContents ?? "");
  const settings = Object.fromEntries(
    [...LOG_SETTING_NAMES].map((name) => [name, process.env[name] ?? fileSettings[name]]),
  );
  const serviceLogs = createServiceLogManager(sourceRoot, parseServiceLogOptions(settings));
  setActiveServiceLogManager(serviceLogs);
  installConsoleCapture(serviceLogs);
  process.env.CMIBOT_ENV_PATH = environmentPath;
  process.chdir(currentRelease);
  await import(pathToFileURL(path.join(currentRelease, "src", "index.js")).href);
}

main().catch((error) => {
  console.error(`LookupBot managed startup failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
