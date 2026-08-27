import { formatDuration, formatTimestamp } from "./debug.js";

function formatDataAge(value, now) {
  if (!value) {
    return "unknown";
  }
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) {
    return "unknown";
  }
  return `${formatDuration(Math.max(0, now - timestamp))} ago`;
}

function getDiscordConnectionState(client) {
  if (!client || typeof client.isReady !== "function") {
    return "unknown";
  }
  if (!client.isReady()) {
    return "not ready";
  }

  const ping = Number(client.ws?.ping);
  return Number.isFinite(ping) && ping >= 0
    ? `connected (${Math.round(ping)} ms gateway latency)`
    : "connected";
}

function getVersionCheckState(snapshot) {
  if (!snapshot.checkEnabled) {
    return "disabled";
  }
  if (!snapshot.checkedAt) {
    return "pending";
  }
  if (snapshot.errorCount) {
    return `degraded (${snapshot.errorCount} failed, ${snapshot.retainedCount ?? 0} last-known retained)`;
  }
  return "healthy";
}

export function formatHealthMessage({
  config,
  searchCache,
  versionService,
  client,
  runtimeInfo,
  startupState,
  now = Date.now(),
}) {
  const cacheSummary = searchCache.getGlobalSummary();
  const versionSnapshot = versionService.getSnapshot();
  const discordState = getDiscordConnectionState(client);
  const cacheReady = Boolean(
    startupState?.ready &&
      cacheSummary.totalEntries > 0 &&
      cacheSummary.totalFiles > 0 &&
      cacheSummary.pluginSummaries?.length === Object.keys(config.plugins).length,
  );
  const versionState = getVersionCheckState(versionSnapshot);
  const overall = !cacheReady || discordState === "not ready"
    ? "unhealthy"
    : versionState.startsWith("degraded") || versionState === "pending"
      ? "degraded"
      : "healthy";
  const startedAt = runtimeInfo?.startedAt ?? new Date(now - process.uptime() * 1000);

  return [
    "### Lookup Health",
    `Overall: \`${overall}\``,
    `Release: \`${runtimeInfo?.release ?? "unknown"}\``,
    `Uptime: \`${formatDuration(now - new Date(startedAt).getTime())}\``,
    `Discord: \`${discordState}\``,
    `Search cache: \`${cacheReady ? "ready" : "not ready"}, ${cacheSummary.totalEntries ?? 0} entries from ${cacheSummary.totalFiles ?? 0} files\``,
    `Cache refreshed: \`${formatTimestamp(cacheSummary.lastReloadedAt)} (${formatDataAge(cacheSummary.lastReloadedAt, now)})\``,
    `Version catalog: \`${versionSnapshot.catalog?.plugins.length ?? 0} plugins, generated ${formatTimestamp(versionSnapshot.catalog?.generatedAt)}\``,
    `Upstream checks: \`${versionState}\``,
    `Startup validation: \`${startupState?.ready ? "passed" : "not confirmed"}\``,
  ].join("\n");
}
