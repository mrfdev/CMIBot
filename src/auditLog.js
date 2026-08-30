import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { serviceLogger } from "./logger.js";

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_FILES = 5;
const writeQueues = new Map();
const securedArchiveSets = new Set();

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
  const sourceIsSafe = await secureExistingFile(source);
  if (!sourceIsSafe) {
    return;
  }
  try {
    await fs.rename(source, destination);
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
}

function validateOwnedFile(stats) {
  if (!stats.isFile()) {
    throw new Error("The audit log must be a regular file.");
  }
  if (typeof process.getuid === "function" && stats.uid !== process.getuid()) {
    throw new Error("The audit log must be owned by the service user.");
  }
}

async function secureExistingFile(filePath) {
  let initialStats;
  try {
    initialStats = await fs.lstat(filePath);
  } catch (error) {
    if (error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
  if (!initialStats.isFile()) {
    throw new Error("The audit log must not be a symbolic link.");
  }

  const handle = await fs.open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stats = await handle.stat();
    const currentStats = await fs.lstat(filePath);
    validateOwnedFile(stats);
    if (
      !currentStats.isFile() ||
      currentStats.dev !== stats.dev ||
      currentStats.ino !== stats.ino
    ) {
      throw new Error("The audit log changed while it was being secured.");
    }
    await handle.chmod(0o600);
    return true;
  } finally {
    await handle.close().catch(() => {});
  }
}

async function secureAuditDirectory(directoryPath) {
  await fs.mkdir(directoryPath, { recursive: true, mode: 0o700 });
  const resolvedPath = await fs.realpath(directoryPath);
  const stats = await fs.stat(resolvedPath);
  if (!stats.isDirectory()) {
    throw new Error("The audit log directory must be a directory.");
  }
  if (typeof process.getuid === "function" && stats.uid !== process.getuid()) {
    throw new Error("The audit log directory must be owned by the service user.");
  }
  await fs.chmod(resolvedPath, 0o700);
  return resolvedPath;
}

async function openAuditLog(filePath) {
  let initialStats = null;
  try {
    initialStats = await fs.lstat(filePath);
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
  if (initialStats && !initialStats.isFile()) {
    throw new Error("The audit log must not be a symbolic link.");
  }

  const handle = await fs.open(
    filePath,
    constants.O_WRONLY |
      constants.O_APPEND |
      constants.O_CREAT |
      (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    const stats = await handle.stat();
    const currentStats = await fs.lstat(filePath);
    validateOwnedFile(stats);
    if (
      !currentStats.isFile() ||
      currentStats.dev !== stats.dev ||
      currentStats.ino !== stats.ino
    ) {
      throw new Error("The audit log changed while it was being opened.");
    }
    await handle.chmod(0o600);
    return handle;
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

async function secureAuditArchives(filePath) {
  if (securedArchiveSets.has(filePath)) {
    return;
  }
  const directoryPath = path.dirname(filePath);
  const archivePrefix = `${path.basename(filePath)}.`;
  const entries = await fs.readdir(directoryPath);
  for (const entry of entries) {
    const suffix = entry.startsWith(archivePrefix) ? entry.slice(archivePrefix.length) : "";
    if (/^[1-9]\d*$/.test(suffix)) {
      await secureExistingFile(path.join(directoryPath, entry));
    }
  }
  securedArchiveSets.add(filePath);
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
      const directoryPath = await secureAuditDirectory(path.dirname(absolutePath));
      const securePath = path.join(directoryPath, path.basename(absolutePath));
      await secureAuditArchives(securePath);
      let handle;
      try {
        handle = await openAuditLog(securePath);
        if (maxBytes > 0) {
          const currentSize = (await handle.stat()).size;
          if (currentSize > 0 && currentSize + lineBytes > maxBytes) {
            await handle.close();
            handle = null;
            await rotateAuditLog(securePath, maxFiles);
            handle = await openAuditLog(securePath);
          }
        }

        await handle.writeFile(line, "utf8");
      } finally {
        await handle?.close().catch(() => {});
      }
    } catch (error) {
      serviceLogger.warn("audit.write_failed", { error });
    }
  });
}
