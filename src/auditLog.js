import fs from "node:fs/promises";
import path from "node:path";
import { serviceLogger } from "./logger.js";

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_FILES = 5;
const writeQueues = new Map();

function normalizeNonNegativeInteger(value, fallback) {
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

async function removeIfPresent(filePath) {
  try {
    await fs.rm(filePath);
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
}

async function renameIfPresent(source, destination) {
  try {
    await fs.rename(source, destination);
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
}

async function rotateAuditLog(absolutePath, maxFiles) {
  if (maxFiles === 0) {
    await removeIfPresent(absolutePath);
    return;
  }

  await removeIfPresent(`${absolutePath}.${maxFiles}`);
  for (let index = maxFiles; index > 1; index -= 1) {
    await renameIfPresent(`${absolutePath}.${index - 1}`, `${absolutePath}.${index}`);
  }
  await renameIfPresent(absolutePath, `${absolutePath}.1`);
}

async function getFileSize(filePath) {
  try {
    return (await fs.stat(filePath)).size;
  } catch (error) {
    if (error.code === "ENOENT") {
      return 0;
    }
    throw error;
  }
}

function enqueueWrite(absolutePath, operation) {
  const previous = writeQueues.get(absolutePath) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  writeQueues.set(absolutePath, current);

  return current.finally(() => {
    if (writeQueues.get(absolutePath) === current) {
      writeQueues.delete(absolutePath);
    }
  });
}

export async function writeAuditLog(workspaceRoot, relativePath, payload, options = {}) {
  const absolutePath = path.join(workspaceRoot, relativePath);
  const maxBytes = normalizeNonNegativeInteger(options.maxBytes, DEFAULT_MAX_BYTES);
  const maxFiles = normalizeNonNegativeInteger(options.maxFiles, DEFAULT_MAX_FILES);
  const line = `${JSON.stringify(payload)}\n`;
  const lineBytes = Buffer.byteLength(line);

  return enqueueWrite(absolutePath, async () => {
    try {
      if (maxBytes > 0) {
        const currentSize = await getFileSize(absolutePath);
        if (currentSize > 0 && currentSize + lineBytes > maxBytes) {
          await rotateAuditLog(absolutePath, maxFiles);
        }
      }

      await fs.mkdir(path.dirname(absolutePath), { recursive: true });
      await fs.appendFile(absolutePath, line, "utf8");
    } catch (error) {
      serviceLogger.warn("audit.write_failed", { error });
    }
  });
}
