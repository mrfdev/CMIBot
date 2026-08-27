export function compareVersions(left, right) {
  const toParts = (value) =>
    String(value)
      .split(/[.-]/)
      .map((part) => (/^\d+$/.test(part) ? Number(part) : part.toLowerCase()));
  const leftParts = toParts(left);
  const rightParts = toParts(right);
  const length = Math.max(leftParts.length, rightParts.length);

  for (let index = 0; index < length; index += 1) {
    const leftPart = leftParts[index] ?? 0;
    const rightPart = rightParts[index] ?? 0;
    if (leftPart === rightPart) {
      continue;
    }
    if (typeof leftPart === "number" && typeof rightPart === "number") {
      return leftPart > rightPart ? 1 : -1;
    }
    return String(leftPart).localeCompare(String(rightPart));
  }
  return 0;
}

export function comparePluginRelease(plugin, upstream) {
  const versionComparison = compareVersions(plugin.version, upstream.version);
  if (versionComparison !== 0) {
    return versionComparison;
  }
  if (plugin.build == null || upstream.build == null) {
    return 0;
  }
  return Number(plugin.build) - Number(upstream.build);
}

export function formatPluginRelease(version, build) {
  return build == null ? String(version) : `${version} build ${build}`;
}
