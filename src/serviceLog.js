import fs from "node:fs";
import path from "node:path";

const SERVICE_LOG_NAMES = Object.freeze({
  info: "cmibot-service.log",
  error: "cmibot-service.error.log",
});

export const DEFAULT_SERVICE_LOG_OPTIONS = Object.freeze({
  maxBytes: 10 * 1024 * 1024,
  maxFiles: 5,
  minFreeBytes: 256 * 1024 * 1024,
});

const ACTIVE_SERVICE_LOG_MANAGER = Symbol.for("com.mrfdev.cmibot.activeServiceLogManager");

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(minimum, Math.min(maximum, parsed));
}

export function parseServiceLogOptions(environment = {}) {
  return {
    maxBytes:
      boundedInteger(environment.SERVICE_LOG_MAX_SIZE_MB, 10, 1, 1_024) * 1024 * 1024,
    maxFiles: boundedInteger(environment.SERVICE_LOG_MAX_FILES, 5, 1, 20),
    minFreeBytes:
      boundedInteger(environment.SERVICE_LOG_MIN_FREE_MB, 256, 64, 1_048_576) * 1024 * 1024,
  };
}

export function setActiveServiceLogManager(manager) {
  globalThis[ACTIVE_SERVICE_LOG_MANAGER] = manager;
}

export function getActiveServiceLogManager() {
  return globalThis[ACTIVE_SERVICE_LOG_MANAGER] ?? null;
}

function fileSize(filePath) {
  try {
    return fs.statSync(filePath).size;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return 0;
    }
    throw error;
  }
}

function removeIfPresent(filePath) {
  try {
    fs.rmSync(filePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function renameIfPresent(source, destination) {
  try {
    fs.renameSync(source, destination);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
}

function availableBytes(directory) {
  const stats = fs.statfsSync(directory);
  return Number(stats.bavail) * Number(stats.bsize);
}

function rotate(filePath, maxFiles) {
  removeIfPresent(`${filePath}.${maxFiles}`);
  for (let index = maxFiles; index > 1; index -= 1) {
    renameIfPresent(`${filePath}.${index - 1}`, `${filePath}.${index}`);
  }
  renameIfPresent(filePath, `${filePath}.1`);
}

export function createRotatingLogSink({
  directory,
  fileName,
  maxBytes,
  maxFiles,
  minFreeBytes,
  now = () => new Date(),
  getAvailableBytes = availableBytes,
} = {}) {
  if (!path.isAbsolute(directory || "")) {
    throw new Error("The service log directory must be absolute.");
  }
  if (!Object.values(SERVICE_LOG_NAMES).includes(fileName)) {
    throw new Error("The service log file name is not allowed.");
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error("The service log size limit must be a positive integer.");
  }
  if (!Number.isSafeInteger(maxFiles) || maxFiles < 1) {
    throw new Error("The service log archive limit must be a positive integer.");
  }
  if (!Number.isSafeInteger(minFreeBytes) || minFreeBytes < 1) {
    throw new Error("The service log disk reserve must be a positive integer.");
  }

  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  const filePath = path.join(directory, fileName);
  let currentBytes = fileSize(filePath);
  let rotations = 0;
  let prunedArchives = 0;
  let droppedWrites = 0;
  let lastWriteAt = null;
  let lastRotationAt = null;
  let lastDropReason = "none";

  function protectDiskReserve(requiredBytes) {
    if (getAvailableBytes(directory) - requiredBytes >= minFreeBytes) {
      return true;
    }

    for (let index = maxFiles; index >= 1; index -= 1) {
      if (removeIfPresent(`${filePath}.${index}`)) {
        prunedArchives += 1;
      }
      if (getAvailableBytes(directory) - requiredBytes >= minFreeBytes) {
        return true;
      }
    }
    return false;
  }

  function write(line) {
    try {
      const normalizedLine = `${String(line).replace(/[\r\n]+$/g, "")}\n`;
      const lineBytes = Buffer.byteLength(normalizedLine);

      if (lineBytes > maxBytes) {
        droppedWrites += 1;
        lastDropReason = "oversized-entry";
        return false;
      }
      if (!protectDiskReserve(lineBytes)) {
        droppedWrites += 1;
        lastDropReason = "disk-reserve";
        return false;
      }
      if (currentBytes > 0 && currentBytes + lineBytes > maxBytes) {
        rotate(filePath, maxFiles);
        currentBytes = 0;
        rotations += 1;
        lastRotationAt = now().toISOString();
      }

      fs.appendFileSync(filePath, normalizedLine, { encoding: "utf8", mode: 0o600 });
      fs.chmodSync(filePath, 0o600);
      currentBytes += lineBytes;
      lastWriteAt = now().toISOString();
      lastDropReason = "none";
      return true;
    } catch {
      droppedWrites += 1;
      lastDropReason = "write-error";
      return false;
    }
  }

  return {
    write,
    getSnapshot() {
      return {
        currentBytes,
        maxBytes,
        maxFiles,
        rotations,
        prunedArchives,
        droppedWrites,
        lastWriteAt,
        lastRotationAt,
        lastDropReason,
      };
    },
  };
}

export function createServiceLogManager(workspaceRoot, options = {}) {
  const logsDirectory = path.resolve(workspaceRoot, "logs");
  const common = {
    directory: logsDirectory,
    maxBytes: options.maxBytes,
    maxFiles: options.maxFiles,
    minFreeBytes: options.minFreeBytes,
    now: options.now,
  };
  const info = createRotatingLogSink({ ...common, fileName: SERVICE_LOG_NAMES.info });
  const error = createRotatingLogSink({ ...common, fileName: SERVICE_LOG_NAMES.error });

  return {
    stdout: (line) => info.write(line),
    stderr: (line) => error.write(line),
    getSnapshot() {
      const infoSnapshot = info.getSnapshot();
      const errorSnapshot = error.getSnapshot();
      return {
        maxBytesPerFile: options.maxBytes,
        maxArchivesPerStream: options.maxFiles,
        minFreeBytes: options.minFreeBytes,
        currentBytes: infoSnapshot.currentBytes + errorSnapshot.currentBytes,
        rotations: infoSnapshot.rotations + errorSnapshot.rotations,
        prunedArchives: infoSnapshot.prunedArchives + errorSnapshot.prunedArchives,
        droppedWrites: infoSnapshot.droppedWrites + errorSnapshot.droppedWrites,
        reserveProtected:
          infoSnapshot.lastDropReason === "disk-reserve" ||
          errorSnapshot.lastDropReason === "disk-reserve",
      };
    },
  };
}
