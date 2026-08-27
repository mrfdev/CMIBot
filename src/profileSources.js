import { createHash } from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";

class ProfileSourceSafetyError extends Error {
  constructor(message) {
    super(message);
    this.name = "ProfileSourceSafetyError";
  }
}

function toPosixPath(value) {
  return value.split(path.sep).join("/");
}

function isSafeRelativePath(value) {
  if (typeof value !== "string" || !value || /[\u0000-\u001f\u007f]/.test(value)) {
    return false;
  }

  const normalized = value.replace(/\\/g, "/");
  return (
    !normalized.startsWith("/") &&
    !/^[a-z]:\//i.test(normalized) &&
    !normalized.split("/").some((segment) => segment === "..")
  );
}

function updateLengthPrefixed(hash, value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value), "utf8");
  hash.update(String(bytes.byteLength));
  hash.update(":");
  hash.update(bytes);
  hash.update("\n");
}

async function readSafeSourceFile(workspaceRoot, relativePath) {
  if (!isSafeRelativePath(relativePath)) {
    throw new ProfileSourceSafetyError("An indexed source path escaped the project workspace.");
  }

  const root = path.resolve(workspaceRoot);
  const absolutePath = path.resolve(root, relativePath);
  if (absolutePath === root || !absolutePath.startsWith(`${root}${path.sep}`)) {
    throw new ProfileSourceSafetyError("An indexed source path escaped the project workspace.");
  }

  let handle;
  try {
    handle = await fs.open(
      absolutePath,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    const stats = await handle.stat();
    if (!stats.isFile()) {
      throw new ProfileSourceSafetyError("An indexed source is not a regular file.");
    }
    return await handle.readFile();
  } catch (error) {
    if (error instanceof ProfileSourceSafetyError) {
      throw error;
    }
    if (error?.code === "ELOOP") {
      throw new ProfileSourceSafetyError("An indexed source cannot be a symbolic link.");
    }
    throw new ProfileSourceSafetyError("An indexed source could not be read safely.");
  } finally {
    await handle?.close().catch(() => {});
  }
}

export async function loadProfileSourceSnapshot(profile, workspaceRoot) {
  let relativePaths;
  try {
    relativePaths = await fg(profile.include, {
      cwd: workspaceRoot,
      ignore: profile.exclude,
      onlyFiles: true,
      unique: true,
      dot: false,
      followSymbolicLinks: false,
    });
  } catch {
    throw new ProfileSourceSafetyError("Indexed source discovery failed safely.");
  }
  const hash = createHash("sha256");
  const files = [];

  for (const discoveredPath of relativePaths.sort()) {
    const relativePath = toPosixPath(discoveredPath);
    const bytes = await readSafeSourceFile(workspaceRoot, relativePath);
    updateLengthPrefixed(hash, relativePath);
    updateLengthPrefixed(hash, bytes);
    files.push({
      relativePath,
      fileText: bytes.toString("utf8"),
    });
  }

  return {
    files,
    fingerprint: hash.digest("hex"),
  };
}
