import fs from "node:fs/promises";
import path from "node:path";

const SAFE_VERSION_PATTERN = /^[0-9][0-9A-Za-z.+-]{0,63}$/;
const COMMIT_PATTERN = /^[a-f0-9]{7,40}$/i;

function normalizeVersion(value) {
  return typeof value === "string" && SAFE_VERSION_PATTERN.test(value) ? value : "unknown";
}

function normalizeRevision(value) {
  return typeof value === "string" && COMMIT_PATTERN.test(value) ? value.toLowerCase() : "";
}

export async function createRuntimeInfo(
  workspaceRoot,
  { startedAt = new Date(), configuredRelease = process.env.CMIBOT_RELEASE } = {},
) {
  const packageJson = JSON.parse(await fs.readFile(path.join(workspaceRoot, "package.json"), "utf8"));
  const packageVersion = normalizeVersion(packageJson.version);
  let detectedRevision = normalizeRevision(configuredRelease);

  if (!detectedRevision) {
    const realWorkspaceRoot = await fs.realpath(workspaceRoot);
    detectedRevision = normalizeRevision(path.basename(realWorkspaceRoot));
  }

  const revision = detectedRevision.slice(0, 12);
  const fullRevision = detectedRevision.length === 40 ? detectedRevision : "";

  return {
    startedAt: new Date(startedAt),
    packageVersion,
    revision,
    fullRevision,
    release: revision ? `${packageVersion} (${revision})` : packageVersion,
  };
}
