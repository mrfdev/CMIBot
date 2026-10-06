import { glob, lstat } from "node:fs/promises";
import path from "node:path";

function assertRelativePath(value) {
  const normalized = typeof value === "string" ? value.replace(/\\/g, "/") : "";
  if (
    !normalized ||
    /[\u0000-\u001f\u007f]/.test(normalized) ||
    normalized.startsWith("/") ||
    /^[a-z]:\//i.test(normalized) ||
    normalized.split("/").includes("..")
  ) {
    throw new Error("An indexed source path escaped the project workspace.");
  }
}

async function hasRealParentDirectories(root, relativePath, directories) {
  let current = root;
  for (const segment of relativePath.split(path.sep).slice(0, -1)) {
    current = path.join(current, segment);
    if (!directories.has(current)) {
      directories.set(current, (await lstat(current)).isDirectory());
    }
    if (!directories.get(current)) {
      return false;
    }
  }
  return true;
}

// Native glob includes directories and symlink entries. Keep discovery limited
// to unique regular source files, including when a pattern names a link's child.
export async function discoverSourceFiles(workspaceRoot, includeGlobs, excludeGlobs = []) {
  const include = [];
  const exclude = [...excludeGlobs];
  for (const pattern of includeGlobs) {
    if (typeof pattern === "string" && pattern.startsWith("!") && !pattern.startsWith("!(")) {
      exclude.push(pattern.slice(1));
    } else {
      include.push(pattern);
    }
  }
  for (const pattern of [...include, ...exclude]) {
    assertRelativePath(pattern);
  }
  if (!include.length) {
    return [];
  }

  const root = path.resolve(workspaceRoot);
  // Also match descendants when an excluded directory is a literal prefix in
  // an include pattern and native glob skips calling its exclusion callback.
  const excludedPatterns = exclude.flatMap((pattern) => [
    path.normalize(pattern),
    path.join(pattern, "**"),
  ]);
  function isExcludedEntry(entry) {
    if (!entry || entry.isSymbolicLink()) {
      return true;
    }
    const relativePath = path.relative(root, path.join(entry.parentPath, entry.name));
    return excludedPatterns.some((pattern) =>
      path.matchesGlob(relativePath, pattern) ||
      (entry.isDirectory() && path.matchesGlob(`${relativePath}${path.sep}`, pattern)),
    );
  }
  const directories = new Map();
  const files = new Set();
  for await (const entry of glob(include, { cwd: root, exclude: isExcludedEntry, withFileTypes: true })) {
    // Literal patterns bypass the exclusion callback on some Node versions.
    if (!entry.isFile() || isExcludedEntry(entry)) {
      continue;
    }
    const relativePath = path.relative(root, path.join(entry.parentPath, entry.name));
    assertRelativePath(relativePath);
    if (await hasRealParentDirectories(root, relativePath, directories)) {
      files.add(relativePath);
    }
  }
  return [...files];
}
