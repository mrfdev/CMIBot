import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { parse } from "dotenv";

export const MAX_PRIVATE_ENVIRONMENT_BYTES = 256 * 1024;

function unavailableError() {
  return new Error("The private environment file is unavailable.");
}

function regularFileError() {
  return new Error("The private environment file must be a regular file, not a symbolic link.");
}

function validateOwner(stats) {
  if (typeof process.getuid === "function" && stats.uid !== process.getuid()) {
    throw new Error("The private environment file must be owned by the service user.");
  }
}

function validateMode(stats, allowBroadPermissions) {
  if (!allowBroadPermissions && (stats.mode & 0o077) !== 0) {
    throw new Error("The private environment file must use owner-only permissions (chmod 600 .env).");
  }
}

export async function readPrivateEnvironmentFile(
  environmentPath,
  {
    allowBroadPermissions = false,
    allowMissing = false,
    maxBytes = MAX_PRIVATE_ENVIRONMENT_BYTES,
  } = {},
) {
  let initialStats;
  try {
    initialStats = await fs.lstat(environmentPath);
  } catch (error) {
    if (allowMissing && error?.code === "ENOENT") {
      return null;
    }
    throw unavailableError();
  }
  if (!initialStats.isFile()) {
    throw regularFileError();
  }

  let handle;
  try {
    handle = await fs.open(
      environmentPath,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
  } catch (error) {
    if (allowMissing && error?.code === "ENOENT") {
      return null;
    }
    if (["ELOOP", "EMLINK"].includes(error?.code)) {
      throw regularFileError();
    }
    throw unavailableError();
  }

  try {
    const stats = await handle.stat();
    const currentStats = await fs.lstat(environmentPath).catch(() => null);
    if (
      !stats.isFile() ||
      !currentStats?.isFile() ||
      currentStats.dev !== stats.dev ||
      currentStats.ino !== stats.ino
    ) {
      throw regularFileError();
    }
    validateOwner(stats);
    validateMode(stats, allowBroadPermissions);
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || stats.size > maxBytes) {
      throw new Error("The private environment file is unexpectedly large.");
    }
    const contents = await handle.readFile();
    if (contents.byteLength > maxBytes) {
      throw new Error("The private environment file is unexpectedly large.");
    }
    return contents.toString("utf8");
  } finally {
    await handle.close().catch(() => {});
  }
}

export async function loadPrivateEnvironment({
  allowMissing = true,
  environmentPath = path.join(process.cwd(), ".env"),
  target = process.env,
} = {}) {
  const contents = await readPrivateEnvironmentFile(environmentPath, { allowMissing });
  if (contents == null) {
    return false;
  }

  const values = parse(contents);
  for (const [name, value] of Object.entries(values)) {
    if (!Object.prototype.hasOwnProperty.call(target, name)) {
      target[name] = value;
    }
  }
  return true;
}
