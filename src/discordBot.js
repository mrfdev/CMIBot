import fs from "node:fs/promises";
import path from "node:path";
import { MessageFlags, REST, Routes, SlashCommandBuilder, version as discordJsVersion } from "discord.js";
import { writeAuditLog } from "./auditLog.js";
import { formatCacheSummary } from "./cache.js";
import { createCooldownManager, resolveFileFilter, sanitizeForDisplay, validateQuery } from "./security.js";
import { AiReranker, lexicalSearch, orderMatchesForDisplay } from "./search.js";
import { findRelatedEntries, makeDisplayContext } from "./yamlIndex.js";

const PRIMARY_COMMAND_NAME = "lookup";
const SUPPORTED_COMMAND_NAMES = new Set([PRIMARY_COMMAND_NAME]);
const MAX_RESULT_LIMIT = 15;
const MATERIAL_MAX_RESULT_LIMIT = 25;
const NO_MENTIONS = { parse: [] };
const DEBUG_SIZE_SKIP_DIRS = new Set([".git"]);

function pluralize(count, singular, plural = `${singular}s`) {
  return count === 1 ? singular : plural;
}

function hasRole(member, { roleIds = [] } = {}) {
  const roles = member.roles?.cache;
  if (!roles) {
    return false;
  }

  return roleIds.length > 0 && roles.some((role) => roleIds.includes(role.id));
}

function resolveCanonicalSubcommand(subcommand) {
  if (subcommand === "lang") {
    return "language";
  }

  if (subcommand === "cmd") {
    return "command";
  }

  if (subcommand === "perm") {
    return "permission";
  }

  return subcommand;
}

function getSearchCommandLabel(commandName, canonicalSubcommand) {
  const prefix = `/${commandName}`;

  switch (canonicalSubcommand) {
    case "config":
      return `\`${prefix} config <keyword>\``;
    case "language":
      return `\`${prefix} language|lang <keyword>\``;
    case "placeholder":
      return `\`${prefix} placeholder <keyword>\``;
    case "material":
      return `\`${prefix} material <keyword>\``;
    case "command":
      return `\`${prefix} command|cmd <keyword>\``;
    case "permission":
      return `\`${prefix} permission|perm <keyword>\``;
    case "faq":
      return `\`${prefix} faq <keyword>\``;
    case "tabcomplete":
      return `\`${prefix} tabcomplete <keyword>\``;
    default:
      return `\`${prefix} ${canonicalSubcommand}\``;
  }
}

function addCommonLookupOptions(
  subcommand,
  defaultResultLimit,
  { includeRelated = false, includeFileFilter = false, maxResultLimit = MAX_RESULT_LIMIT } = {},
) {
  let builder = subcommand
    .addStringOption((option) =>
      option.setName("keyword").setDescription("Keyword, phrase, or token to search for.").setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName("mode")
        .setDescription("Search mode. Defaults to exact.")
        .addChoices(
          { name: "exact", value: "exact" },
          { name: "whole", value: "whole" },
          { name: "broad", value: "broad" },
        ),
    )
    .addIntegerOption((option) =>
      option
        .setName("limit")
        .setDescription(`How many results to show. Default ${defaultResultLimit}.`)
        .setMinValue(1)
        .setMaxValue(maxResultLimit),
    );

  if (includeFileFilter) {
    builder = builder.addStringOption((option) =>
      option
        .setName("file")
        .setDescription("Optional indexed config file filter, like Chat.yml, config.yml, or a plugin-relative path."),
    );
  }

  if (includeRelated) {
    builder = builder.addBooleanOption((option) =>
      option
        .setName("related")
        .setDescription("Include up to two nearby related YAML entries. Defaults to false."),
    );
  }

  return builder.addBooleanOption((option) =>
    option.setName("summary").setDescription("Include an optional AI-generated summary. Defaults to false."),
  );
}

function buildCommandTree(commandName, config) {
  const defaultResultLimit = config.search.defaultResultLimit;
  const materialDefaultLimit =
    config.plugins.cmi?.profiles.material?.defaultResultLimit ?? MATERIAL_MAX_RESULT_LIMIT;
  const debugContextChoices = [
    { name: "auto", value: "auto" },
    ...Object.values(config.plugins).map((plugin) => ({
      name: plugin.label.toLowerCase(),
      value: plugin.id,
    })),
  ];

  return new SlashCommandBuilder()
    .setName(commandName)
    .setDescription("Look up plugin config, locale, and exported support data by keyword.")
    .addSubcommand((subcommand) =>
      subcommand.setName("help").setDescription("Show available commands and usage notes for this channel context."),
    )
    .addSubcommand((subcommand) =>
      addCommonLookupOptions(
        subcommand.setName("config").setDescription("Search indexed config files for the active plugin context."),
        defaultResultLimit,
        { includeRelated: true, includeFileFilter: true },
      ),
    )
    .addSubcommand((subcommand) =>
      addCommonLookupOptions(
        subcommand
          .setName("language")
          .setDescription("Search indexed English locale and translation YAML files for the active plugin context."),
        defaultResultLimit,
        { includeRelated: true },
      ),
    )
    .addSubcommand((subcommand) =>
      addCommonLookupOptions(
        subcommand.setName("lang").setDescription("Alias for the active context language search."),
        defaultResultLimit,
        { includeRelated: true },
      ),
    )
    .addSubcommand((subcommand) =>
      addCommonLookupOptions(
        subcommand.setName("placeholder").setDescription("Search exported placeholder entries."),
        defaultResultLimit,
      ),
    )
    .addSubcommand((subcommand) =>
      addCommonLookupOptions(
        subcommand.setName("material").setDescription("Search exported material names."),
        materialDefaultLimit,
        { maxResultLimit: MATERIAL_MAX_RESULT_LIMIT },
      ),
    )
    .addSubcommand((subcommand) =>
      addCommonLookupOptions(
        subcommand.setName("command").setDescription("Search exported command usage entries."),
        defaultResultLimit,
      ),
    )
    .addSubcommand((subcommand) =>
      addCommonLookupOptions(
        subcommand.setName("cmd").setDescription("Alias for the exported command usage search."),
        defaultResultLimit,
      ),
    )
    .addSubcommand((subcommand) =>
      addCommonLookupOptions(
        subcommand.setName("permission").setDescription("Search exported permission entries."),
        defaultResultLimit,
      ),
    )
    .addSubcommand((subcommand) =>
      addCommonLookupOptions(
        subcommand.setName("perm").setDescription("Alias for the exported permission search."),
        defaultResultLimit,
      ),
    )
    .addSubcommand((subcommand) =>
      addCommonLookupOptions(
        subcommand.setName("faq").setDescription("Search curated FAQ titles, links, and short notes."),
        defaultResultLimit,
      ),
    )
    .addSubcommand((subcommand) =>
      addCommonLookupOptions(
        subcommand.setName("tabcomplete").setDescription("Search exported tab-complete token entries."),
        defaultResultLimit,
      ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("langstats")
        .setDescription("Show language-category stats for the active plugin context."),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("stats")
        .setDescription("Show cache totals and per-profile counts for the active plugin context."),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("debug")
        .setDescription("Show the current channel context and optionally override it in test channels.")
        .addStringOption((option) =>
          option
            .setName("context")
            .setDescription("For test channels only: set the active context or reset to auto.")
            .addChoices(...debugContextChoices),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand.setName("reload").setDescription("Reload the in-memory search cache for every plugin context."),
    )
    .toJSON();
}

function buildCommandData(config) {
  return [buildCommandTree(PRIMARY_COMMAND_NAME, config)];
}

function formatReloadMessage(summary) {
  return formatCacheSummary(summary, { verb: "Reloaded" }).replace(/- (\w+):/g, "- `$1`:");
}

function formatStatsMessage(plugin, summary) {
  return [`### Lookup Stats`, `Current context: \`${plugin.label}\``, formatCacheSummary(summary)].join("\n");
}

function formatBytes(bytes) {
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

function formatDuration(milliseconds) {
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

function formatTimestamp(value) {
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
    if (["help", "stats", "langstats", "debug", "reload"].includes(commandName)) {
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

function resolveChannelContext(channelId, config, testOverrides) {
  const isTestChannel = config.discord.testChannelIds.includes(channelId);
  const overridePluginId = testOverrides.get(channelId) ?? "";

  if (isTestChannel) {
    const pluginId = overridePluginId || config.discord.testDefaultContext;
    const plugin = config.plugins[pluginId] ?? null;

    return {
      pluginId,
      plugin,
      channelType: "test channel",
      isTestChannel: true,
      overridePluginId,
      routingNote: plugin
        ? overridePluginId
          ? `This test channel is currently overridden to the ${plugin.label} context.`
          : `This test channel is currently following the default ${plugin.label} context.`
        : "This test channel does not currently resolve to a configured plugin context.",
    };
  }

  for (const [pluginId, channelIds] of Object.entries(config.discord.pluginChannelIds)) {
    if (channelIds.includes(channelId)) {
      const plugin = config.plugins[pluginId] ?? null;
      return {
        pluginId,
        plugin,
        channelType: "support channel",
        isTestChannel: false,
        overridePluginId: "",
        routingNote: plugin
          ? `This channel is mapped to the ${plugin.label} lookup set.`
          : "This channel is mapped to an unknown plugin context.",
      };
    }
  }

  return {
    pluginId: "",
    plugin: null,
    channelType: "unmapped channel",
    isTestChannel: false,
    overridePluginId: "",
    routingNote: "This channel does not currently map to a known plugin context.",
  };
}

async function formatDebugMessage(interaction, context, config, searchCache, testOverrides) {
  const memory = process.memoryUsage();
  const workspaceSize = await getDirectorySize(config.workspaceRoot);
  const globalSummary = searchCache.getGlobalSummary();
  const contextSummary = context.plugin ? searchCache.getPluginSummary(context.plugin.id) : null;
  const largestBucket = getLargestCacheBucket(globalSummary);
  const diskFootprint = await getTrackedDiskFootprint(config);
  const commandAvailability = context.plugin ? formatCommandAvailabilitySummary(context.plugin) : null;
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

function getCommandAvailability(plugin, canonicalSubcommand) {
  return plugin.commandAvailability[canonicalSubcommand] ?? "unsupported";
}

function formatCommandUnavailableMessage(plugin, canonicalSubcommand, commandName, availability) {
  const commandLabel = getSearchCommandLabel(commandName, canonicalSubcommand);

  if (availability === "coming_soon") {
    return `${commandLabel} is still being worked on for the ${plugin.label} context.`;
  }

  return `${commandLabel} is not a feature of the ${plugin.label} context.`;
}

function formatHelpMessage(config, member, context, commandName) {
  const plugin = context.plugin;
  const canLookup = hasRole(member, { roleIds: config.discord.allowedRoleIds });
  const canReload = hasRole(member, { roleIds: config.discord.adminRoleIds });
  const canUseAi = hasRole(member, { roleIds: config.discord.aiRoleIds });
  const aiEnabled = config.openai.enabled;
  const prefix = `/${PRIMARY_COMMAND_NAME}`;
  const currentCommand = `/${commandName}`;
  const lines = ["### Lookup Help"];

  if (!plugin) {
    lines.push("This allowed channel does not map to a plugin context yet.");
    return lines.join("\n");
  }

  lines.push(`Current context: \`${plugin.label}\``);

  if (context.isTestChannel) {
    lines.push(
      `Test channel mode: \`${context.overridePluginId || "auto"}\`${context.overridePluginId ? " override active" : ""}`,
    );
  }

  lines.push("", "Available here:");
  lines.push(`- \`${prefix} help\` shows this help message`);

  const commandDescriptions = new Map([
    ["config", "searches indexed config files"],
    ["language", "searches indexed English locale files"],
    ["placeholder", "searches exported placeholder entries"],
    ["material", "searches exported material names"],
    ["command", "searches exported command entries"],
    ["permission", "searches exported permission entries"],
    ["faq", "searches curated FAQ entries"],
    ["tabcomplete", "searches exported tab-complete entries"],
  ]);

  const readyCommands = [...commandDescriptions.keys()].filter(
    (subcommand) => getCommandAvailability(plugin, subcommand) === "ready",
  );
  const comingSoonCommands = [...commandDescriptions.keys()].filter(
    (subcommand) => getCommandAvailability(plugin, subcommand) === "coming_soon",
  );
  const unsupportedCommands = [...commandDescriptions.keys()].filter(
    (subcommand) => getCommandAvailability(plugin, subcommand) === "unsupported",
  );

  for (const subcommand of readyCommands) {
    lines.push(`- ${getSearchCommandLabel(PRIMARY_COMMAND_NAME, subcommand)} ${commandDescriptions.get(subcommand)}`);
  }

  lines.push(`- \`${prefix} langstats\` shows language-category stats for this plugin context`);
  lines.push(`- \`${prefix} stats\` shows cache totals for this plugin context`);
  lines.push(`- \`${prefix} debug\` shows the current channel context`);
  lines.push(`- \`${prefix} reload\` refreshes the cache for every plugin context`);

  if (comingSoonCommands.length) {
    lines.push("", `Still being worked on for ${plugin.label}:`);
    for (const subcommand of comingSoonCommands) {
      lines.push(`- ${getSearchCommandLabel(PRIMARY_COMMAND_NAME, subcommand)}`);
    }
  }

  if (unsupportedCommands.length) {
    lines.push("", `Not part of the ${plugin.label} scope:`);
    for (const subcommand of unsupportedCommands) {
      lines.push(`- ${getSearchCommandLabel(PRIMARY_COMMAND_NAME, subcommand)}`);
    }
  }

  lines.push("", "Options:");
  lines.push("- `mode: exact|whole|broad` controls how strict the search is");

  if (getCommandAvailability(plugin, "config") === "ready") {
    lines.push("- `file: <name>` narrows `config` to a matching indexed file");
  }

  lines.push(
    `- \`limit: 1-${MAX_RESULT_LIMIT}\` is used by most commands, with \`${config.search.defaultResultLimit}\` as the default`,
  );

  if (getCommandAvailability(plugin, "material") === "ready") {
    const materialDefaultLimit =
      plugin.profiles.material?.defaultResultLimit ?? MATERIAL_MAX_RESULT_LIMIT;
    lines.push(
      `- \`material\` uses \`limit: 1-${MATERIAL_MAX_RESULT_LIMIT}\` and defaults to \`${materialDefaultLimit}\``,
    );
  }

  if (getCommandAvailability(plugin, "config") === "ready" || getCommandAvailability(plugin, "language") === "ready") {
    lines.push("- `related: true|false` adds nearby YAML entries for `config`, `language`, and `lang`");
  }

  lines.push(
    aiEnabled
      ? "- `summary: true|false` adds an optional AI-generated summary (admin-only for now)"
      : "- `summary: true|false` is currently disabled in bot config",
  );

  if (context.isTestChannel) {
    lines.push(
      "- `debug context:auto|cmi|jobs` can switch the test channel context live when used by an admin",
    );
  }

  lines.push("", "Examples:");

  if (plugin.id === "cmi") {
    lines.push(`- \`${prefix} config dynmap\``);
    lines.push(`- \`${prefix} config chat file:Chat.yml\``);
    lines.push(`- \`${prefix} config "mini message" mode:whole\``);
    lines.push(`- \`${prefix} language home\``);
    lines.push(`- \`${prefix} placeholder balance\``);
    lines.push(`- \`${prefix} material shulker\``);
    lines.push(`- \`${prefix} cmd balance\``);
    lines.push(`- \`${prefix} perm cmi.command.balance\``);
    lines.push(`- \`${prefix} faq refund\``);
  } else if (plugin.id === "jobs") {
    lines.push(`- \`${prefix} language exp\``);
    lines.push(`- \`${prefix} placeholder points\``);
    lines.push(`- \`${prefix} cmd join\``);
    lines.push(`- \`${prefix} perm jobs.use\``);
    lines.push(`- \`${prefix} faq vault\``);
  } else if (plugin.id === "svis") {
    lines.push(`- \`${prefix} config selection\``);
    lines.push(`- \`${prefix} language particle\``);
    lines.push(`- \`${prefix} cmd gui\``);
    lines.push(`- \`${prefix} perm sv.worldedit.use\``);
    lines.push(`- \`${prefix} langstats\``);
  } else if (plugin.id === "mfm") {
    lines.push(`- \`${prefix} config farm\``);
    lines.push(`- \`${prefix} language mob\``);
    lines.push(`- \`${prefix} langstats\``);
  } else if (plugin.id === "tryme") {
    lines.push(`- \`${prefix} config tryme\``);
    lines.push(`- \`${prefix} language message\``);
    lines.push(`- \`${prefix} langstats\``);
  } else if (plugin.id === "trademe") {
    lines.push(`- \`${prefix} config trade\``);
    lines.push(`- \`${prefix} language seller\``);
    lines.push(`- \`${prefix} langstats\``);
  } else if (plugin.id === "residence") {
    lines.push(`- \`${prefix} config build\``);
    lines.push(`- \`${prefix} language invalid\``);
    lines.push(`- \`${prefix} placeholder owner\``);
    lines.push(`- \`${prefix} cmd set\``);
    lines.push(`- \`${prefix} perm residence.select\``);
    lines.push(`- \`${prefix} langstats\``);
    lines.push(`- \`${prefix} stats\``);
  } else {
    lines.push(`- \`${prefix} config setting\``);
    lines.push(`- \`${prefix} language message\``);
    lines.push(`- \`${prefix} langstats\``);
  }

  if (!canLookup) {
    lines.push(
      "",
      "Notice: search, stats, and reload are limited to the configured support/admin role IDs. Help and debug stay available in allowed channels.",
    );
  } else if (aiEnabled && !canReload && !canUseAi) {
    lines.push(
      "",
      "Notice: you can use search commands here, but `/lookup reload` and AI-backed options like `summary:true` are restricted.",
    );
  } else if (!canReload) {
    lines.push("", "Notice: you can use search commands here, but `/lookup reload` is admin-only.");
  } else {
    lines.push("", `Notice: ${currentCommand} is available here.`);
  }

  return lines.join("\n");
}

function formatCompactFileLabel(filePath, { preferShortPath = false } = {}) {
  const baseName = path.posix.basename(filePath);
  if (!preferShortPath) {
    return baseName;
  }

  const segments = filePath.split("/");
  const root = segments[0] ?? baseName;
  const informativeParents = segments.slice(1, -1).filter((segment) => !["Translations", "Settings"].includes(segment));

  if (informativeParents.length) {
    return `${root}/${informativeParents.join("/")}/${baseName}`;
  }

  return `${root}/${baseName}`;
}

function formatFileList(filePaths, { preferShortPath = false } = {}) {
  if (!filePaths.length) {
    return "";
  }

  const baseNameCounts = new Map();
  for (const filePath of filePaths) {
    const baseName = path.posix.basename(filePath);
    baseNameCounts.set(baseName, (baseNameCounts.get(baseName) ?? 0) + 1);
  }

  const fileLabels = filePaths.map((filePath) => {
    const baseName = path.posix.basename(filePath);
    if (preferShortPath) {
      return formatCompactFileLabel(filePath, { preferShortPath: true });
    }

    if ((baseNameCounts.get(baseName) ?? 0) <= 1) {
      return formatCompactFileLabel(filePath);
    }

    return formatCompactFileLabel(filePath, { preferShortPath: true });
  });

  if (fileLabels.length <= 3) {
    return ` (${fileLabels.join(" / ")})`;
  }

  const visible = fileLabels.slice(0, 3).join(" / ");
  return ` (${visible} +${fileLabels.length - 3} more)`;
}

function formatLanguageStatsMessage(languageCategories, pluginId, formatDisplayPath) {
  if (!languageCategories?.length) {
    return "";
  }

  const groupDefinitions =
    pluginId === "jobs"
      ? [
          {
            title: "Jobs language data:",
            matcher: (category) =>
              category.englishRelativePath.startsWith("JobsPlugin/locale/") ||
              category.englishRelativePath.startsWith("JobsPlugin/TranslatableWords/"),
          },
          {
            title: "Shared CMILib language data:",
            matcher: (category) => category.englishRelativePath.startsWith("CMILibPlugin/CMILib/"),
          },
        ]
      : pluginId === "svis"
        ? [
            {
              title: "SVIS language data:",
              matcher: (category) => category.englishRelativePath.startsWith("SVISPlugin/"),
            },
            {
              title: "Shared CMILib language data:",
              matcher: (category) => category.englishRelativePath.startsWith("CMILibPlugin/CMILib/"),
            },
          ]
        : pluginId === "mfm"
          ? [
              {
                title: "MFM language data:",
                matcher: (category) => category.englishRelativePath.startsWith("MFMPlugin/"),
              },
              {
                title: "Shared CMILib language data:",
                matcher: (category) => category.englishRelativePath.startsWith("CMILibPlugin/CMILib/"),
              },
            ]
          : pluginId === "tryme"
            ? [
                {
                  title: "TryMe language data:",
                  matcher: (category) => category.englishRelativePath.startsWith("TryMePlugin/"),
                },
                {
                  title: "Shared CMILib language data:",
                  matcher: (category) => category.englishRelativePath.startsWith("CMILibPlugin/CMILib/"),
                },
              ]
            : pluginId === "trademe"
              ? [
                  {
                    title: "TradeMe language data:",
                    matcher: (category) => category.englishRelativePath.startsWith("TradeMePlugin/"),
                  },
                  {
                    title: "Shared CMILib language data:",
                    matcher: (category) => category.englishRelativePath.startsWith("CMILibPlugin/CMILib/"),
                  },
                ]
              : pluginId === "residence"
                ? [
                    {
                      title: "Residence language data:",
                      matcher: (category) => category.englishRelativePath.startsWith("ResidencePlugin/"),
                    },
                    {
                      title: "Shared CMILib language data:",
                      matcher: (category) => category.englishRelativePath.startsWith("CMILibPlugin/CMILib/"),
                    },
                  ]
      : [
          {
            title: "CMI language data:",
            matcher: (category) => category.englishRelativePath.startsWith("CMIPlugin/CMI/"),
          },
          {
            title: "Shared CMILib language data:",
            matcher: (category) => category.englishRelativePath.startsWith("CMILibPlugin/CMILib/"),
          },
        ];

  const blocks = [];

  for (const groupDefinition of groupDefinitions) {
    const categories = languageCategories.filter(groupDefinition.matcher);
    if (!categories.length) {
      continue;
    }

    const lines = [groupDefinition.title];
    for (const category of categories) {
      const displayPath = formatDisplayPath(pluginId, category.englishRelativePath);
      const languageLabel = pluralize(category.languageCount, "language");
      const codes = category.languageCodes.map((code) => `\`${code}\``).join(", ");
      lines.push(`- \`${category.label}\` -> \`${displayPath}\`\n(${category.languageCount} ${languageLabel}: ${codes})`);
    }
    blocks.push(lines.join("\n\n"));
  }

  const groupedKeys = new Set(
    groupDefinitions.flatMap((groupDefinition) =>
      languageCategories.filter(groupDefinition.matcher).map((category) => category.key),
    ),
  );
  const ungroupedCategories = languageCategories.filter((category) => !groupedKeys.has(category.key));
  if (ungroupedCategories.length) {
    const lines = ["Other language data:"];
    for (const category of ungroupedCategories) {
      const displayPath = formatDisplayPath(pluginId, category.englishRelativePath);
      const languageLabel = pluralize(category.languageCount, "language");
      const codes = category.languageCodes.map((code) => `\`${code}\``).join(", ");
      lines.push(`- \`${category.label}\` -> \`${displayPath}\`\n(${category.languageCount} ${languageLabel}: ${codes})`);
    }
    blocks.push(lines.join("\n\n"));
  }

  return blocks.join("\n\n");
}

function formatLangStatsOnlyMessage(plugin, languageCategories, formatDisplayPath) {
  const statsBody = formatLanguageStatsMessage(languageCategories, plugin.id, formatDisplayPath);
  if (!statsBody) {
    return `Language stats are still being worked on for the ${plugin.label} context.`;
  }

  const count = languageCategories.length;
  return [
    "### Language Stats",
    `Current context: \`${plugin.label}\``,
    `Found [${count}] ${pluralize(count, "category")} for English locale coverage.`,
    "",
    statsBody,
  ]
    .filter(Boolean)
    .join("\n");
}

function extractUrlFromComments(comments = []) {
  for (const line of comments) {
    const match = line.match(/^\s*#\s*URL:\s*(https?:\/\/\S+)\s*$/i);
    if (match) {
      return match[1];
    }
  }

  return "";
}

function stripFaqSnippet(snippet, yamlPath) {
  const lines = snippet.split("\n");
  const filtered = lines.filter(
    (line) => !/^\s*#\s*URL:\s*/i.test(line) && !/^\s*#\s*Keywords:\s*/i.test(line),
  );

  if (filtered[filtered.length - 1]?.trim() === yamlPath.trim()) {
    filtered.pop();
  }

  return filtered.join("\n").trimEnd();
}

function linkedReferenceLabel(label, url) {
  return `[${label}](<${url}>)`;
}

function getReferenceLabel(profile) {
  if (!profile?.referenceLabel) {
    return "";
  }

  if (profile.referenceUrl) {
    return linkedReferenceLabel(profile.referenceLabel, profile.referenceUrl);
  }

  return `\`${profile.referenceLabel}\``;
}

function formatResultLead(result, options) {
  if (options.layout === "faq") {
    const url = extractUrlFromComments(result.comments);
    return url ? `[${sanitizeForDisplay(result.yamlPath)}](<${url}>)` : `\`${result.yamlPath}\``;
  }

  if (["permission", "command"].includes(options.layout)) {
    return "";
  }

  return `Look around line ${result.lineNumber} -> \`${result.yamlPath}\``;
}

function formatResultSnippet(result, options) {
  if (options.layout === "faq") {
    return stripFaqSnippet(result.snippet, result.yamlPath);
  }

  return result.snippet;
}

function formatMaterialResultsMessage(keyword, results, totalMentions) {
  const mentionLabel = pluralize(totalMentions, "mention");
  const safeKeyword = sanitizeForDisplay(keyword);
  const header = `### Found [${totalMentions}] ${mentionLabel} in the NMS material list for \`${safeKeyword}\``;
  const values = results.map((result) => result.yamlPath).join("\n");
  const footer = `_Showing ${results.length} ${pluralize(results.length, "result")}${totalMentions > results.length ? ", but there are more." : "."}_`;
  return [header, `\`\`\`text\n${values}\n\`\`\``, footer].filter(Boolean).join("\n");
}

function formatResultsMessage(
  keyword,
  results,
  totalMentions,
  fileCount,
  aiSummary,
  allMatchedFiles,
  options = {},
) {
  if (options.layout === "materialList") {
    return formatMaterialResultsMessage(keyword, results, totalMentions);
  }

  const mentionLabel = pluralize(totalMentions, "mention");
  const fileLabel = pluralize(fileCount, "file");
  const shownCount = results.length;
  const groupedResults = new Map();

  for (const result of results) {
    if (!groupedResults.has(result.displayPath)) {
      groupedResults.set(result.displayPath, []);
    }

    groupedResults.get(result.displayPath).push(result);
  }

  const blocks = [];
  const hideInternalHeading = ["faq", "placeholder", "tabcomplete", "command", "permission"].includes(options.layout);

  for (const [displayPath, fileResults] of groupedResults.entries()) {
    const heading = hideInternalHeading
      ? ""
      : fileResults[0]?.sourceType === "log"
        ? `From bot's: \`${displayPath}\``
        : `In \`${displayPath}\`:`;

    if (heading) {
      blocks.push(heading);
    }

    for (const result of fileResults) {
      const leadLine = formatResultLead(result, options);
      const snippet = formatResultSnippet(result, options);
      const relatedLine = result.related?.length
        ? `Related: ${result.related.map((entry) => `\`${entry.yamlPath}\` (line ${entry.lineNumber})`).join(", ")}\n`
        : "";
      blocks.push([leadLine, `${relatedLine}\`\`\`${result.codeLanguage}\n${snippet}\n\`\`\``].filter(Boolean).join("\n"));
    }
  }

  const safeKeyword = sanitizeForDisplay(keyword);
  const fileHint = options.showFileHints === false ? "" : formatFileList(allMatchedFiles, options);
  const profileReference = getReferenceLabel(options.profile);
  const header =
    options.layout === "faq" && profileReference
      ? `### Found [${totalMentions}] ${mentionLabel} in ${profileReference} for \`${safeKeyword}\``
      : options.layout === "faq"
        ? `### Found [${totalMentions}] ${mentionLabel} for \`${safeKeyword}\``
      : options.layout === "placeholder"
        ? `### Found [${totalMentions}] ${mentionLabel} for ${profileReference || "`placeholders`"} matching \`${safeKeyword}\``
        : options.layout === "tabcomplete"
          ? `### Found [${totalMentions}] ${mentionLabel} for tabcompletes matching \`${safeKeyword}\``
          : options.layout === "command"
            ? `### Found [${totalMentions}] ${mentionLabel} for ${profileReference || "`commands`"} matching \`${safeKeyword}\``
            : options.layout === "permission"
              ? `### Found [${totalMentions}] ${mentionLabel} for ${profileReference || "`permissions`"} matching \`${safeKeyword}\``
              : `### Found [${totalMentions}] ${mentionLabel} in [${fileCount}] ${fileLabel} for \`${safeKeyword}\`${fileHint}`;

  let footer = "";
  if (shownCount === totalMentions) {
    footer = `_Showing ${shownCount} ${pluralize(shownCount, "result")}._`;
  } else if (totalMentions > shownCount) {
    footer = `_Showing top ${shownCount} results, but there are more._`;
  }

  const summaryBlock = aiSummary ? `AI summary (generated): ${aiSummary}` : "";
  return [header, ...blocks, summaryBlock, footer].filter(Boolean).join("\n");
}

function truncateDiscordMessage(message) {
  if (message.length <= 2000) {
    return message;
  }

  return `${message.slice(0, 1900)}\n\n_(Trimmed to fit Discord message limits.)_`;
}

export async function registerCommands(config) {
  const rest = new REST({ version: "10" }).setToken(config.discord.token);
  const body = buildCommandData(config);

  await rest.put(Routes.applicationGuildCommands(config.discord.applicationId, config.discord.guildId), {
    body,
  });
}

export function createInteractionHandler(config, searchCache) {
  const reranker = new AiReranker(config.openai);
  const cooldowns = createCooldownManager();
  const testOverrides = new Map();

  function logEvent(interaction, payload) {
    return writeAuditLog(config.workspaceRoot, config.security.auditLogPath, {
      timestamp: new Date().toISOString(),
      guildId: interaction.guildId,
      channelId: interaction.channelId,
      userId: interaction.user.id,
      userTag: interaction.user.tag,
      commandName: interaction.commandName,
      ...payload,
    });
  }

  function validationMessage(reason) {
    if (config.security.queryDebugErrors) {
      return reason;
    }

    return "That search was rejected by input validation. Please use a short, specific keyword or phrase.";
  }

  return async function handleInteraction(interaction) {
    if (!interaction.isChatInputCommand() || !SUPPORTED_COMMAND_NAMES.has(interaction.commandName)) {
      return;
    }

    if (interaction.guildId !== config.discord.guildId) {
      await interaction.reply({
        content: "This bot is locked to a different Discord server.",
        flags: MessageFlags.Ephemeral,
        allowedMentions: NO_MENTIONS,
      });
      return;
    }

    if (!config.discord.allowedChannelIds.includes(interaction.channelId)) {
      await interaction.reply({
        content: "This command can only be used in a configured support or test channel.",
        flags: MessageFlags.Ephemeral,
        allowedMentions: NO_MENTIONS,
      });
      return;
    }

    const subcommand = interaction.options.getSubcommand();
    const canonicalSubcommand = resolveCanonicalSubcommand(subcommand);
    let context = resolveChannelContext(interaction.channelId, config, testOverrides);

    if (canonicalSubcommand === "debug") {
      const requestedContext = interaction.options.getString("context") ?? "";

      if (requestedContext) {
        if (!context.isTestChannel) {
          await interaction.reply({
            content: "Context overrides can only be changed from a configured test channel.",
            flags: MessageFlags.Ephemeral,
            allowedMentions: NO_MENTIONS,
          });
          return;
        }

        if (!hasRole(interaction.member, { roleIds: config.discord.adminRoleIds })) {
          await interaction.reply({
            content: "Only the configured admin role can change the active test-channel context.",
            flags: MessageFlags.Ephemeral,
            allowedMentions: NO_MENTIONS,
          });
          return;
        }

        if (requestedContext === "auto") {
          testOverrides.delete(interaction.channelId);
        } else {
          testOverrides.set(interaction.channelId, requestedContext);
        }

        context = resolveChannelContext(interaction.channelId, config, testOverrides);
      }

      await logEvent(interaction, {
        subcommand,
        outcome: "success",
        detectedContext: context.pluginId || "unknown",
        channelType: context.channelType,
        override: context.overridePluginId || "auto",
      });
      await interaction.reply({
        content: truncateDiscordMessage(await formatDebugMessage(interaction, context, config, searchCache, testOverrides)),
        flags: MessageFlags.Ephemeral,
        allowedMentions: NO_MENTIONS,
      });
      return;
    }

    if (canonicalSubcommand === "help") {
      await logEvent(interaction, {
        subcommand,
        outcome: "help",
        detectedContext: context.pluginId || "unknown",
      });
      await interaction.reply({
        content: truncateDiscordMessage(formatHelpMessage(config, interaction.member, context, interaction.commandName)),
        flags: MessageFlags.Ephemeral,
        allowedMentions: NO_MENTIONS,
      });
      return;
    }

    if (!context.plugin) {
      await interaction.reply({
        content: "This allowed channel does not map to a plugin context yet.",
        flags: MessageFlags.Ephemeral,
        allowedMentions: NO_MENTIONS,
      });
      return;
    }

    if (canonicalSubcommand === "reload") {
      if (!hasRole(interaction.member, { roleIds: config.discord.adminRoleIds })) {
        await logEvent(interaction, {
          subcommand,
          outcome: "denied",
          reason: "reload-role",
          detectedContext: context.pluginId,
        });
        await interaction.reply({
          content: "Only the configured admin role can use the reload command.",
          flags: MessageFlags.Ephemeral,
          allowedMentions: NO_MENTIONS,
        });
        return;
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      try {
        const summary = await searchCache.reloadAll();
        await logEvent(interaction, {
          subcommand,
          outcome: "success",
          totalEntries: summary.totalEntries,
          totalFiles: summary.totalFiles,
        });
        console.log(
          `[LookupBot] Cache reloaded by ${interaction.user.tag} in channel ${interaction.channelId}.\n${formatCacheSummary(summary, { verb: "Reloaded" })}`,
        );
        await interaction.editReply({
          content: formatReloadMessage(summary),
          allowedMentions: NO_MENTIONS,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        await logEvent(interaction, {
          subcommand,
          outcome: "error",
          reason: message,
        });
        await interaction.editReply({
          content: `The bot failed to reload the search cache: ${message}`,
          allowedMentions: NO_MENTIONS,
        });
      }
      return;
    }

    if (!hasRole(interaction.member, { roleIds: config.discord.allowedRoleIds })) {
      await logEvent(interaction, {
        subcommand,
        outcome: "denied",
        reason: "lookup-role",
        detectedContext: context.pluginId,
      });
      await interaction.reply({
        content: "You do not have one of the allowed support roles for this command.",
        flags: MessageFlags.Ephemeral,
        allowedMentions: NO_MENTIONS,
      });
      return;
    }

    if (canonicalSubcommand === "stats") {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      try {
        const summary = searchCache.getPluginSummary(context.plugin.id) ?? {
          pluginId: context.plugin.id,
          pluginLabel: context.plugin.label,
          totalEntries: 0,
          totalFiles: 0,
          profileSummaries: [],
        };

        await logEvent(interaction, {
          subcommand,
          outcome: "success",
          detectedContext: context.pluginId,
          totalEntries: summary.totalEntries,
          totalFiles: summary.totalFiles,
        });
        await interaction.editReply({
          content: truncateDiscordMessage(formatStatsMessage(context.plugin, summary)),
          allowedMentions: NO_MENTIONS,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        await logEvent(interaction, {
          subcommand,
          outcome: "error",
          reason: message,
          detectedContext: context.pluginId,
        });
        await interaction.editReply({
          content: `The bot hit an error while loading stats: ${message}`,
          allowedMentions: NO_MENTIONS,
        });
      }
      return;
    }

    if (canonicalSubcommand === "langstats") {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      try {
        const snapshot = searchCache.getSnapshot(context.plugin.id, "language");
        const languageCategories = snapshot?.languageCategories ?? [];
        const message = formatLangStatsOnlyMessage(context.plugin, languageCategories, config.formatDisplayPath);

        await logEvent(interaction, {
          subcommand,
          outcome: "success",
          detectedContext: context.pluginId,
          categoryCount: languageCategories.length,
        });
        await interaction.editReply({
          content: truncateDiscordMessage(message),
          allowedMentions: NO_MENTIONS,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        await logEvent(interaction, {
          subcommand,
          outcome: "error",
          reason: message,
          detectedContext: context.pluginId,
        });
        await interaction.editReply({
          content: `The bot hit an error while loading language stats: ${message}`,
          allowedMentions: NO_MENTIONS,
        });
      }
      return;
    }

    const availability = getCommandAvailability(context.plugin, canonicalSubcommand);
    if (availability !== "ready") {
      await logEvent(interaction, {
        subcommand,
        outcome: "blocked",
        reason: availability,
        detectedContext: context.pluginId,
      });
      await interaction.reply({
        content: formatCommandUnavailableMessage(context.plugin, canonicalSubcommand, PRIMARY_COMMAND_NAME, availability),
        flags: MessageFlags.Ephemeral,
        allowedMentions: NO_MENTIONS,
      });
      return;
    }

    const keywordInput = interaction.options.getString("keyword", true);
    const fileInput = interaction.options.getString("file") ?? "";
    const mode = interaction.options.getString("mode") ?? "exact";
    const profile = context.plugin.profiles[canonicalSubcommand];
    const profileDefaultLimit = profile.defaultResultLimit ?? config.search.defaultResultLimit;
    const profileMaxResultLimit = profile.maxResultLimit ?? config.search.maxResultLimit;
    const limit = Math.min(interaction.options.getInteger("limit") ?? profileDefaultLimit, profileMaxResultLimit);
    const related = interaction.options.getBoolean("related") ?? false;
    const summary = interaction.options.getBoolean("summary") ?? false;
    const canUseAi = hasRole(interaction.member, { roleIds: config.discord.aiRoleIds });
    const validation = validateQuery(keywordInput, config.security);
    const keyword = validation.normalizedQuery;

    if (!validation.ok) {
      await logEvent(interaction, {
        subcommand,
        keyword,
        mode,
        related,
        summary,
        outcome: "rejected",
        reason: validation.reason,
        detectedContext: context.pluginId,
      });
      await interaction.reply({
        content: validationMessage(validation.reason),
        flags: MessageFlags.Ephemeral,
        allowedMentions: NO_MENTIONS,
      });
      return;
    }

    const allProfileEntries = searchCache.getEntries(context.plugin.id, canonicalSubcommand);
    const fileFilter = resolveFileFilter(fileInput, allProfileEntries, {
      profileLabel: canonicalSubcommand === "config" ? `${context.plugin.label} config` : `${context.plugin.label} ${canonicalSubcommand}`,
    });

    if (!fileFilter.ok) {
      await logEvent(interaction, {
        subcommand,
        keyword,
        file: fileInput,
        mode,
        related,
        summary,
        outcome: "rejected",
        reason: fileFilter.reason,
        detectedContext: context.pluginId,
      });
      await interaction.reply({
        content: fileFilter.reason,
        flags: MessageFlags.Ephemeral,
        allowedMentions: NO_MENTIONS,
      });
      return;
    }

    const lookupCooldown = cooldowns.check(
      interaction.user.id,
      `${context.plugin.id}:${canonicalSubcommand}:lookup`,
      config.security.lookupCooldownSeconds,
    );
    if (!lookupCooldown.allowed) {
      await logEvent(interaction, {
        subcommand,
        keyword,
        mode,
        related,
        summary,
        outcome: "rejected",
        reason: `lookup-cooldown:${lookupCooldown.retryAfterSeconds}`,
        detectedContext: context.pluginId,
      });
      await interaction.reply({
        content: `Please wait ${lookupCooldown.retryAfterSeconds}s before running another lookup.`,
        flags: MessageFlags.Ephemeral,
        allowedMentions: NO_MENTIONS,
      });
      return;
    }

    if (summary && !canUseAi) {
      await logEvent(interaction, {
        subcommand,
        keyword,
        mode,
        related,
        summary,
        outcome: "denied",
        reason: "ai-role",
        detectedContext: context.pluginId,
      });
      await interaction.reply({
        content: config.openai.enabled
          ? "AI-backed options like `summary:true` are currently limited to the configured admin-only group."
          : "AI-backed options are currently disabled in bot config.",
        flags: MessageFlags.Ephemeral,
        allowedMentions: NO_MENTIONS,
      });
      return;
    }

    if (summary) {
      const summaryCooldown = cooldowns.check(
        interaction.user.id,
        `${context.plugin.id}:${canonicalSubcommand}:summary`,
        config.security.summaryCooldownSeconds,
      );
      if (!summaryCooldown.allowed) {
        await logEvent(interaction, {
          subcommand,
          keyword,
          mode,
          related,
          summary,
          outcome: "rejected",
          reason: `summary-cooldown:${summaryCooldown.retryAfterSeconds}`,
          detectedContext: context.pluginId,
        });
        await interaction.reply({
          content: `Please wait ${summaryCooldown.retryAfterSeconds}s before requesting another AI summary.`,
          flags: MessageFlags.Ephemeral,
          allowedMentions: NO_MENTIONS,
        });
        return;
      }
    }

    await interaction.deferReply();

    try {
      const entries = fileFilter.filteredEntries;
      const lexicalMatches = lexicalSearch(keyword, entries, { limit: 25, mode });
      const rerankedMatches =
        config.openai.enabled && canUseAi ? await reranker.rerank(keyword, lexicalMatches) : lexicalMatches;
      const orderedMatches = orderMatchesForDisplay(rerankedMatches);
      const finalMatches = orderedMatches.slice(0, limit);

      if (!finalMatches.length) {
        await logEvent(interaction, {
          subcommand,
          keyword,
          file: fileFilter.normalizedFilter,
          mode,
          related,
          summary,
          outcome: "empty",
          detectedContext: context.pluginId,
        });
        await interaction.editReply({
          content: `No ${profile.entryLabel ?? "entries"} matched \`${sanitizeForDisplay(keyword)}\` in the \`${context.plugin.label}\` \`${canonicalSubcommand}\` profile${fileFilter.normalizedFilter ? ` with file filter \`${sanitizeForDisplay(fileFilter.normalizedFilter)}\`` : ""}.`,
          allowedMentions: NO_MENTIONS,
        });
        return;
      }

      const visibleResults = finalMatches.map((item) => ({
        ...makeDisplayContext(item.entry, context.plugin.id, config.formatDisplayPath),
        related: related ? findRelatedEntries(item.entry, entries) : [],
      }));
      const totalMentions = orderedMatches.length;
      const fileCount = new Set(orderedMatches.map((item) => item.entry.relativePath)).size;
      let aiSummary = "";
      if (summary && config.openai.enabled && canUseAi) {
        aiSummary = (await reranker.summarize(keyword, finalMatches, { profileName: `${context.plugin.id}:${canonicalSubcommand}` })) || "";
      }
      const allMatchedFiles = [...new Set(orderedMatches.map((item) => item.entry.relativePath))];
      const message = formatResultsMessage(keyword, visibleResults, totalMentions, fileCount, aiSummary, allMatchedFiles, {
        profile,
        preferShortPath: canonicalSubcommand === "language",
        showFileHints: canonicalSubcommand === "config",
        layout:
          canonicalSubcommand === "material"
            ? "materialList"
            : canonicalSubcommand === "faq"
              ? "faq"
              : canonicalSubcommand === "placeholder"
                ? "placeholder"
                : canonicalSubcommand === "tabcomplete"
                  ? "tabcomplete"
                  : canonicalSubcommand === "permission"
                    ? "permission"
                    : canonicalSubcommand === "command"
                      ? "command"
                      : "default",
      });

      await logEvent(interaction, {
        subcommand,
        keyword,
        file: fileFilter.normalizedFilter,
        mode,
        related,
        summary,
        aiEnabled: canUseAi,
        outcome: "success",
        detectedContext: context.pluginId,
        resultCount: finalMatches.length,
        totalMentions,
        fileCount,
      });
      await interaction.editReply({
        content: truncateDiscordMessage(message),
        allowedMentions: NO_MENTIONS,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      await logEvent(interaction, {
        subcommand,
        keyword,
        mode,
        related,
        summary,
        outcome: "error",
        reason: message,
        detectedContext: context.pluginId,
      });
      await interaction.editReply({
        content: `The bot hit an error while searching: ${message}`,
        allowedMentions: NO_MENTIONS,
      });
    }
  };
}
