import { isSafeIndexedRelativePath } from "./discord/browse.js";

const FULL_COMMIT_PATTERN = /^[a-f0-9]{40}$/i;
const SAFE_REPOSITORY_SEGMENT_PATTERN = /^[a-z0-9_.-]+$/i;

export function normalizePublicGitHubRepositoryUrl(value) {
  if (typeof value !== "string" || !value) {
    return "";
  }

  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.hostname.toLowerCase() !== "github.com" ||
      url.port ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      return "";
    }
    const segments = url.pathname.split("/").filter(Boolean);
    if (segments.length !== 2) {
      return "";
    }
    const repository = segments[1].replace(/\.git$/i, "");
    if (
      !SAFE_REPOSITORY_SEGMENT_PATTERN.test(segments[0]) ||
      !SAFE_REPOSITORY_SEGMENT_PATTERN.test(repository)
    ) {
      return "";
    }
    return `https://github.com/${segments[0]}/${repository}`;
  } catch {
    return "";
  }
}

export function buildPinnedSourceUrl({
  enabled = true,
  repositoryUrl,
  revision,
  relativePath,
  lineNumber,
  allowedRoots = [],
}) {
  const normalizedRepositoryUrl = normalizePublicGitHubRepositoryUrl(repositoryUrl);
  const normalizedRevision =
    typeof revision === "string" && FULL_COMMIT_PATTERN.test(revision)
      ? revision.toLowerCase()
      : "";
  const line = Number(lineNumber);

  if (
    !enabled ||
    !normalizedRepositoryUrl ||
    !normalizedRevision ||
    !Number.isSafeInteger(line) ||
    line < 1 ||
    !isSafeIndexedRelativePath(relativePath, allowedRoots, { allowIndexedLogs: true })
  ) {
    return "";
  }

  const encodedPath = relativePath
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `${normalizedRepositoryUrl}/blob/${normalizedRevision}/${encodedPath}#L${line}`;
}
