import fs from "node:fs/promises";
import path from "node:path";

const SAFE_VERSION_PATTERN = /^[0-9][0-9A-Za-z.+-]{0,63}$/;
const COMMIT_PATTERN = /^[a-f0-9]{7,40}$/i;

function normalizeVersion(value) {
  return typeof value === "string" && SAFE_VERSION_PATTERN.test(value) ? value : "unknown";
}

function normalizeRevision(value) {
  return typeof value === "string" && COMMIT_PATTERN.test(value) ? value.toLowerCase().slice(0, 12) : "";
}

export async function createRuntimeInfo(
  workspaceRoot,
  { startedAt = new Date(), configuredRelease = process.env.CMIBOT_RELEASE } = {},
) {
  const packageJson = JSON.parse(await fs.readFile(path.join(workspaceRoot, "package.json"), "utf8"));
  const packageVersion = normalizeVersion(packageJson.version);
  let revision = normalizeRevision(configuredRelease);

  if (!revision) {
    const realWorkspaceRoot = await fs.realpath(workspaceRoot);
    revision = normalizeRevision(path.basename(realWorkspaceRoot));
  }

  return {
    startedAt: new Date(startedAt),
    packageVersion,
    revision,
    release: revision ? `${packageVersion} (${revision})` : packageVersion,
  };
}
