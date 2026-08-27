import path from "node:path";

const SAFE_FILE_EXTENSION_PATTERN = /\.(?:ya?ml|json|md|txt)$/i;
const INDEXED_LOG_EXTENSION_PATTERN = /\.log$/i;
const SAFE_PATH_CHARACTER_PATTERN = /^[a-z0-9._+() /-]+$/i;
const SENSITIVE_FILE_PATTERN =
  /(?:^|[._-])(?:secret|secrets|credential|credentials|private[-_.]?key|api[-_.]?key|token|tokens|passwd|shadow|id[-_.]?(?:rsa|dsa|ecdsa|ed25519)|authorized[-_.]?keys)(?:$|[._-])/i;

function normalizeAllowedRoots(allowedRoots) {
  return new Set(
    allowedRoots
      .map((root) => String(root).replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, ""))
      .filter((root) => root && !root.includes("/")),
  );
}

export function isSafeIndexedRelativePath(
  relativePath,
  allowedRoots = [],
  { allowIndexedLogs = false } = {},
) {
  if (typeof relativePath !== "string" || !relativePath || relativePath.length > 240) {
    return false;
  }
  if (
    relativePath !== relativePath.trim() ||
    relativePath.includes("\\") ||
    path.posix.isAbsolute(relativePath) ||
    !SAFE_PATH_CHARACTER_PATTERN.test(relativePath) ||
    (!SAFE_FILE_EXTENSION_PATTERN.test(relativePath) &&
      !(allowIndexedLogs && INDEXED_LOG_EXTENSION_PATTERN.test(relativePath)))
  ) {
    return false;
  }

  const segments = relativePath.split("/");
  if (
    segments.length < 2 ||
    segments.some((segment) => !segment || segment === "." || segment === ".." || segment.startsWith(".")) ||
    path.posix.normalize(relativePath) !== relativePath
  ) {
    return false;
  }

  const roots = normalizeAllowedRoots(allowedRoots);
  if (!roots.has(segments[0])) {
    return false;
  }

  const baseName = segments.at(-1);
  return (
    !segments.some((segment) => SENSITIVE_FILE_PATTERN.test(segment)) &&
    !/\.(?:key|pem|p12|pfx)$/i.test(baseName)
  );
}

export function listSafeIndexedFiles(entries, { allowedRoots = [], maxFiles = 100 } = {}) {
  const candidates = new Set();
  let rejectedCount = 0;

  for (const entry of entries ?? []) {
    if (isSafeIndexedRelativePath(entry?.relativePath, allowedRoots)) {
      candidates.add(entry.relativePath);
    } else {
      rejectedCount += 1;
    }
  }

  const allFiles = [...candidates].sort((left, right) =>
    left.localeCompare(right, undefined, { sensitivity: "base" }),
  );
  const safeLimit = Math.max(1, Math.min(250, Number(maxFiles) || 100));
  return {
    files: allFiles.slice(0, safeLimit),
    totalFileCount: allFiles.length,
    rejectedCount,
    truncated: allFiles.length > safeLimit,
  };
}

function pluralize(count, singular, plural = `${singular}s`) {
  return count === 1 ? singular : plural;
}

export function formatIndexedFilesMessage(plugin, listing, profileName = "") {
  const lines = [
    "### Indexed Files",
    `Current context: \`${plugin.label}\``,
    profileName ? `Profile: \`${profileName}\`` : "Profiles: all available categories",
    "Only cached, plugin-relative filenames are shown. File contents cannot be read with this command.",
    "",
  ];

  if (!listing.files.length) {
    lines.push("No safely displayable indexed files were found for this scope.");
    return lines.join("\n");
  }

  for (const file of listing.files) {
    lines.push(`- \`${file}\``);
  }
  lines.push(
    "",
    listing.truncated
      ? `_Showing ${listing.files.length} of ${listing.totalFileCount} safely displayable files._`
      : `_Showing ${listing.totalFileCount} ${pluralize(listing.totalFileCount, "file")}._`,
  );
  return lines.join("\n");
}

export function formatIndexedCategoriesMessage(plugin, summary) {
  const profiles = summary?.profileSummaries ?? [];
  const lines = [
    "### Indexed Categories",
    `Current context: \`${plugin.label}\``,
    "These are fixed cache profiles, not filesystem paths.",
    "",
  ];

  if (!profiles.length) {
    lines.push("No indexed categories are currently loaded for this context.");
    return lines.join("\n");
  }

  for (const profile of profiles) {
    lines.push(
      `- \`${profile.profileName}\`: ${profile.entryCount} ${pluralize(profile.entryCount, "entry", "entries")} in ${profile.fileCount} ${pluralize(profile.fileCount, "file")}`,
    );
  }
  return lines.join("\n");
}
