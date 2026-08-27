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

function formatBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) {
    return "unknown";
  }
  const units = ["B", "KiB", "MiB", "GiB"];
  let amount = bytes;
  let unitIndex = 0;
  while (amount >= 1024 && unitIndex < units.length - 1) {
    amount /= 1024;
    unitIndex += 1;
  }
  return `${amount >= 10 || unitIndex === 0 ? Math.round(amount) : amount.toFixed(1)} ${units[unitIndex]}`;
}

export function formatHealthMessage({
  config,
  searchCache,
  versionService,
  client,
  metrics,
  runtimeInfo,
  serviceLogs,
  startupState,
  now = Date.now(),
}) {
  const cacheSummary = searchCache.getGlobalSummary();
  const resultCacheSummary = searchCache.getResultCacheSummary?.();
  const derivedIndexSummary = searchCache.getDerivedIndexSummary?.();
  const versionSnapshot = versionService.getSnapshot();
  const discordState = getDiscordConnectionState(client);
  const cacheReady = Boolean(
    startupState?.ready &&
      cacheSummary.totalEntries > 0 &&
      cacheSummary.totalFiles > 0 &&
      cacheSummary.pluginSummaries?.length === Object.keys(config.plugins).length,
  );
  const versionState = getVersionCheckState(versionSnapshot);
  const metricsSnapshot = metrics?.getSnapshot?.();
  const serviceLogSnapshot = serviceLogs?.getSnapshot?.();
  const overall = !cacheReady || discordState === "not ready"
    ? "unhealthy"
    : versionState.startsWith("degraded") || versionState === "pending"
      ? "degraded"
      : "healthy";
  const startedAt = runtimeInfo?.startedAt ?? new Date(now - process.uptime() * 1000);

  const lines = [
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
  ];

  if (metricsSnapshot) {
    lines.push(
      `Commands: \`${metricsSnapshot.commands.count} observed, p95 ${metricsSnapshot.commands.p95Ms} ms, ${metricsSnapshot.commands.outcomes.error} errors\``,
      `Search: \`${metricsSnapshot.searches.count} observed, p95 ${metricsSnapshot.searches.p95Ms} ms, ${metricsSnapshot.searches.results.returned} results returned\``,
      `Reloads: \`${metricsSnapshot.reloads.count} observed, p95 ${metricsSnapshot.reloads.p95Ms} ms\``,
      `AI: \`${metricsSnapshot.ai.count} local/fallback requests, ${metricsSnapshot.ai.tokens.total} tokens reported, $0 paid budget\``,
      `Process memory: \`${formatBytes(metricsSnapshot.memory.rssBytes)} RSS, ${formatBytes(metricsSnapshot.memory.heapUsedBytes)} heap used\``,
    );
    if (metricsSnapshot.upstream?.checks) {
      lines.push(
        `Upstream resilience: \`retries: ${metricsSnapshot.upstream.checks.retries}, circuits opened: ${metricsSnapshot.upstream.checks.circuitOpenings}, requests skipped: ${metricsSnapshot.upstream.checks.circuitRejections}\``,
      );
    }
  }

  if (resultCacheSummary) {
    lines.push(
      `Repeated-search LRU: \`${resultCacheSummary.entries}/${resultCacheSummary.maxEntries} entries, ${resultCacheSummary.hits} hits, ${resultCacheSummary.misses} misses, ${resultCacheSummary.evictions} evictions\``,
    );
  }

  if (derivedIndexSummary?.enabled) {
    lines.push(
      `Derived indexes: \`${derivedIndexSummary.hits} reused, ${derivedIndexSummary.rebuilds} rebuilt (${derivedIndexSummary.forcedRebuilds} forced), ${derivedIndexSummary.rejectedArtifacts} rejected, ${derivedIndexSummary.writeFailures} write failures\``,
    );
  }

  if (serviceLogSnapshot) {
    lines.push(
      `Service logs: \`bounded to ${formatBytes(serviceLogSnapshot.maxBytesPerFile)} per stream with ${serviceLogSnapshot.maxArchivesPerStream} archives; ${serviceLogSnapshot.droppedWrites} writes dropped\``,
    );
  }

  return lines.join("\n");
}
