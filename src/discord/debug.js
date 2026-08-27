import fs from "node:fs/promises";
import path from "node:path";
import { version as discordJsVersion } from "discord.js";

const DEBUG_SIZE_SKIP_DIRS = new Set([".git"]);

export function formatBytes(bytes) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let index = 0;

  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }

  const digits = index === 0 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${units[index]}`;
}

export function formatDuration(milliseconds) {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts = [];

  if (days) {
    parts.push(`${days}d`);
  }
  if (hours || parts.length) {
    parts.push(`${hours}h`);
  }
  if (minutes || parts.length) {
    parts.push(`${minutes}m`);
  }
  parts.push(`${seconds}s`);

  return parts.join(" ");
}

export function formatTimestamp(value) {
  if (!value) {
    return "not loaded yet";
  }

  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "unknown";
  }

  return date.toLocaleString("en-GB", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

async function getDirectorySize(directoryPath) {
  let totalSize = 0;
  const entries = await fs.readdir(directoryPath, { withFileTypes: true });

  for (const entry of entries) {
    if (DEBUG_SIZE_SKIP_DIRS.has(entry.name)) {
      continue;
    }

    const absolutePath = path.join(directoryPath, entry.name);
    if (entry.isDirectory()) {
      totalSize += await getDirectorySize(absolutePath);
      continue;
    }

    if (entry.isFile()) {
      const stats = await fs.stat(absolutePath);
      totalSize += stats.size;
    }
  }

  return totalSize;
}

async function safeGetDirectorySize(directoryPath) {
  try {
    return await getDirectorySize(directoryPath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return 0;
    }

    throw error;
  }
}

function getProfileDisplayCounts(profileSummary) {
  if (profileSummary.localEntryCount != null && profileSummary.localFileCount != null) {
    return {
      entryCount: profileSummary.localEntryCount,
      fileCount: profileSummary.localFileCount,
    };
  }

  return {
    entryCount: profileSummary.entryCount ?? 0,
    fileCount: profileSummary.fileCount ?? 0,
  };
}

function formatRouteSummary(config) {
  const routeCounts = Object.entries(config.discord.pluginChannelIds)
    .filter(([, channelIds]) => channelIds.length)
    .map(([pluginId, channelIds]) => `${pluginId}(${channelIds.length})`);

  if (config.discord.testChannelIds.length) {
    routeCounts.push(`test(${config.discord.testChannelIds.length})`);
  }

  return routeCounts.length ? routeCounts.join(", ") : "none";
}

function getLargestCacheBucket(globalSummary) {
  let largestBucket = null;

  for (const pluginSummary of globalSummary.pluginSummaries ?? []) {
    for (const profileSummary of pluginSummary.profileSummaries ?? []) {
      const counts = getProfileDisplayCounts(profileSummary);
      if (!largestBucket || counts.entryCount > largestBucket.entryCount) {
        largestBucket = {
          scopeLabel: pluginSummary.pluginLabel,
          profileLabel: profileSummary.profileDisplayName ?? profileSummary.profileName,
          entryCount: counts.entryCount,
          fileCount: counts.fileCount,
        };
      }
    }
  }

  for (const profileSummary of globalSummary.sharedCmilibSummary?.profileSummaries ?? []) {
    if (!largestBucket || profileSummary.entryCount > largestBucket.entryCount) {
      largestBucket = {
        scopeLabel: globalSummary.sharedCmilibSummary.pluginLabel,
        profileLabel: profileSummary.profileDisplayName ?? profileSummary.profileName,
        entryCount: profileSummary.entryCount,
        fileCount: profileSummary.fileCount,
      };
    }
  }

  return largestBucket;
}

function formatContextProfileCounts(contextSummary) {
  if (!contextSummary?.profileSummaries?.length) {
    return "none";
  }

  return contextSummary.profileSummaries
    .map((profileSummary) => {
      const counts = getProfileDisplayCounts(profileSummary);
      return `${profileSummary.profileDisplayName ?? profileSummary.profileName} ${counts.fileCount}f`;
    })
    .join(", ");
}

function formatCommandAvailabilitySummary(plugin) {
  const ready = [];
  const unavailable = [];

  for (const [commandName, availability] of Object.entries(plugin.commandAvailability)) {
    if (["help", "stats", "langstats", "latest", "health", "debug", "reload"].includes(commandName)) {
      continue;
    }

    if (availability === "ready") {
      ready.push(commandName);
      continue;
    }

    unavailable.push(commandName);
  }

  return {
    ready: ready.join(", ") || "none",
    unavailable: unavailable.join(", ") || "none",
  };
}

function formatTestOverrideSummary(testChannelIds, testOverrides, config) {
  if (!testChannelIds.length) {
    return "no configured test channels";
  }

  if (!testOverrides.size) {
    return "none";
  }

  const entries = [];
  for (const channelId of testChannelIds) {
    const pluginId = testOverrides.get(channelId);
    if (!pluginId) {
      continue;
    }

    const pluginLabel = config.plugins[pluginId]?.label ?? pluginId;
    entries.push(`${channelId} -> ${pluginLabel}`);
  }

  return entries.length ? entries.join(", ") : "none";
}

async function getTrackedDiskFootprint(config) {
  const results = [];

  for (const plugin of Object.values(config.plugins)) {
    let totalSize = 0;
    for (const directory of plugin.debugRoots ?? []) {
      totalSize += await safeGetDirectorySize(path.join(config.workspaceRoot, directory));
    }

    results.push(`${plugin.label} ${formatBytes(totalSize)}`);
  }

  for (const sharedRoot of config.sharedDebugRoots ?? []) {
    let totalSize = 0;
    for (const directory of sharedRoot.directories ?? []) {
      totalSize += await safeGetDirectorySize(path.join(config.workspaceRoot, directory));
    }

    results.push(`${sharedRoot.label} ${formatBytes(totalSize)}`);
  }

  return results.join(" | ");
}

export async function formatDebugMessage(
  interaction,
  context,
  config,
  searchCache,
  versionService,
  testOverrides,
) {
  const memory = process.memoryUsage();
  const workspaceSize = await getDirectorySize(config.workspaceRoot);
  const globalSummary = searchCache.getGlobalSummary();
  const contextSummary = context.plugin ? searchCache.getPluginSummary(context.plugin.id) : null;
  const largestBucket = getLargestCacheBucket(globalSummary);
  const diskFootprint = await getTrackedDiskFootprint(config);
  const commandAvailability = context.plugin ? formatCommandAvailabilitySummary(context.plugin) : null;
  const versionSnapshot = versionService.getSnapshot();
  const paperRuntime = versionSnapshot.catalog?.paper;
  const lines = [
    "### Lookup Debug",
    `Detected context: \`${context.plugin?.label ?? "Unknown"}\``,
    `Channel type: \`${context.channelType}\``,
    `Channel ID: \`${interaction.channelId}\``,
    `Tracked plugins: \`${[...Object.values(config.plugins).map((plugin) => plugin.label), "Shared CMILib"].join(", ")}\``,
    `Known channel routes: \`${formatRouteSummary(config)}\``,
    `Context file counts: \`${formatContextProfileCounts(contextSummary)}\``,
    `Uptime: \`${formatDuration(process.uptime() * 1000)}\``,
    `Runtime: \`Node ${process.version}, discord.js ${discordJsVersion}\``,
    `Project size on disk: \`${formatBytes(workspaceSize)}\``,
    `Process RAM (RSS): \`${formatBytes(memory.rss)}\``,
    `Process heap used: \`${formatBytes(memory.heapUsed)}\``,
    `Global cache: \`${globalSummary.totalEntries ?? 0}\` entries from \`${globalSummary.totalFiles ?? 0}\` files`,
    `Last cache reload: \`${formatTimestamp(globalSummary.lastReloadedAt)}\``,
    `Version catalog: \`${versionSnapshot.catalog?.plugins.length ?? 0} plugins, generated ${formatTimestamp(versionSnapshot.catalog?.generatedAt)}\``,
    `Paper runtime: \`${
      paperRuntime
        ? `${paperRuntime.version} build ${paperRuntime.build ?? "unknown"} ${paperRuntime.channel ?? "unknown"}, API ${paperRuntime.apiCoordinate ?? "unknown"}, exporter Java ${paperRuntime.javaTarget ?? "unknown"}`
        : "unknown"
    }\``,
    `Upstream versions: \`${versionSnapshot.checkedAt ? `${formatTimestamp(versionSnapshot.checkedAt)}, ${versionSnapshot.errorCount} refresh failures${versionSnapshot.retainedCount ? `, ${versionSnapshot.retainedCount} last-known retained` : ""}` : versionSnapshot.checkEnabled ? "pending" : "disabled"}\``,
    `Largest cache bucket: \`${largestBucket ? `${largestBucket.scopeLabel} ${largestBucket.profileLabel} (${largestBucket.entryCount} entries / ${largestBucket.fileCount} files)` : "unknown"}\``,
    `Active test overrides: \`${formatTestOverrideSummary(config.discord.testChannelIds, testOverrides, config)}\``,
    `Disk footprint: \`${diskFootprint}\``,
  ];

  if (contextSummary) {
    lines.push(
      `Context cache: \`${contextSummary.totalEntries ?? 0}\` entries from \`${contextSummary.totalFiles ?? 0}\` files`,
    );
  }

  if (commandAvailability) {
    lines.push(`Available here: \`${commandAvailability.ready}\``);
    lines.push(`Not supported here: \`${commandAvailability.unavailable}\``);
  }

  lines.push("", context.routingNote);
  return lines.join("\n");
}
