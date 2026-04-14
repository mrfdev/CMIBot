import { MessageFlags, REST, Routes, SlashCommandBuilder } from "discord.js";
import path from "node:path";
import { writeAuditLog } from "./auditLog.js";
import { formatCacheSummary } from "./cache.js";
import { createCooldownManager, sanitizeForDisplay, validateQuery } from "./security.js";
import { AiReranker, lexicalSearch, orderMatchesForDisplay } from "./search.js";
import { findRelatedEntries, makeDisplayContext } from "./yamlIndex.js";

const COMMAND_NAME = "cmibot";
const MAX_RESULT_LIMIT = 10;
const NO_MENTIONS = { parse: [] };

function pluralize(count, singular, plural = `${singular}s`) {
  return count === 1 ? singular : plural;
}

function buildCommandData(defaultResultLimit) {
  return [
    new SlashCommandBuilder()
      .setName(COMMAND_NAME)
      .setDescription("Look up CMI or CMILib YAML entries by keyword.")
      .addSubcommand((subcommand) =>
        subcommand.setName("help").setDescription("Show available CMIBot commands and usage notes."),
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName("lookup")
          .setDescription("Search regular CMI and CMILib config files.")
          .addStringOption((option) =>
            option.setName("keyword").setDescription("Keyword or phrase to search for.").setRequired(true),
          )
          .addStringOption((option) =>
            option
              .setName("mode")
              .setDescription("Search mode. Defaults to exact.")
              .addChoices(
                { name: "exact", value: "exact" },
                { name: "broad", value: "broad" },
              ),
          )
          .addIntegerOption((option) =>
            option
              .setName("limit")
              .setDescription(`How many results to show. Default ${defaultResultLimit}.`)
              .setMinValue(1)
              .setMaxValue(MAX_RESULT_LIMIT),
          )
          .addBooleanOption((option) =>
            option
              .setName("related")
              .setDescription("Include up to two nearby related YAML entries. Defaults to false."),
          )
          .addBooleanOption((option) =>
            option.setName("summary").setDescription("Include an optional AI-generated summary. Defaults to false."),
          ),
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName("langlookup")
          .setDescription("Search locale and translation YAML files.")
          .addStringOption((option) =>
            option.setName("keyword").setDescription("Keyword or phrase to search for.").setRequired(true),
          )
          .addStringOption((option) =>
            option
              .setName("mode")
              .setDescription("Search mode. Defaults to exact.")
              .addChoices(
                { name: "exact", value: "exact" },
                { name: "broad", value: "broad" },
              ),
          )
          .addIntegerOption((option) =>
            option
              .setName("limit")
              .setDescription(`How many results to show. Default ${defaultResultLimit}.`)
              .setMinValue(1)
              .setMaxValue(MAX_RESULT_LIMIT),
          )
          .addBooleanOption((option) =>
            option
              .setName("related")
              .setDescription("Include up to two nearby related YAML entries. Defaults to false."),
          )
          .addBooleanOption((option) =>
            option.setName("summary").setDescription("Include an optional AI-generated summary. Defaults to false."),
          ),
      )
      .addSubcommand((subcommand) =>
        subcommand.setName("reload").setDescription("Reload the in-memory YAML search cache."),
      )
      .toJSON(),
  ];
}

function hasRole(member, { roleIds = [], roleNames = [] } = {}) {
  const roles = member.roles?.cache;
  if (!roles) {
    return false;
  }

  const hasAllowedId = roleIds.length > 0 && roles.some((role) => roleIds.includes(role.id));
  const hasAllowedName = roleNames.length > 0 && roles.some((role) => roleNames.includes(role.name));

  return hasAllowedName || hasAllowedId;
}

function formatReloadMessage(summary) {
  return formatCacheSummary(summary, { verb: "Reloaded" }).replace(/- (\w+):/g, "- `$1`:");
}

function formatHelpMessage(config, member) {
  const canLookup = hasRole(member, {
    roleIds: config.discord.allowedRoleIds,
    roleNames: config.discord.allowedRoleNames,
  });
  const canReload = hasRole(member, { roleIds: config.discord.adminRoleIds });
  const canUseAi = hasRole(member, { roleIds: config.discord.aiRoleIds });
  const aiEnabled = config.openai.enabled;

  const lines = [
    "### CMIBot Help",
    "Commands available through this bot in this channel:",
    "- `/cmibot help` shows this help message",
    "- `/cmibot lookup <keyword>` searches regular CMI and CMILib config files",
    "- `/cmibot langlookup <keyword>` searches locale and translation files",
    "- `/cmibot reload` refreshes the in-memory YAML cache from disk",
    "",
    "Optional lookup options:",
    "- `mode: exact|broad` controls how strict the search is",
    `- \`limit: 1-${MAX_RESULT_LIMIT}\` changes how many results are shown, with \`${config.search.defaultResultLimit}\` as the default`,
    "- `related: true|false` adds nearby YAML entries for context",
    aiEnabled
      ? "- `summary: true|false` adds an optional AI-generated summary (admin-only for now)"
      : "- `summary: true|false` is currently disabled in bot config",
    "",
    "Examples:",
    "- `/cmibot lookup dynmap`",
    "- `/cmibot lookup \"mini message\" mode:broad`",
    "- `/cmibot lookup bluemap related:true`",
    "- `/cmibot lookup dynmap summary:true`",
    "- `/cmibot langlookup home`",
  ];

  if (!canLookup) {
    lines.push("", "Notice: lookup, langlookup, and reload are limited to certain support/admin groups.");
  } else if (aiEnabled && !canReload && !canUseAi) {
    lines.push(
      "",
      "Notice: you can use lookup commands here, but `/cmibot reload` and AI-backed options like `summary:true` are restricted.",
    );
  } else if (!canReload) {
    lines.push("", "Notice: you can use lookup commands here, but `/cmibot reload` is admin-only.");
  } else {
    lines.push("", "Notice: you can use lookup, langlookup, and reload in this channel.");
  }

  lines.push(
    "",
    `Safety note: lookups are rate-limited per user, broad filler words can be rejected, and \`summary:true\` is currently limited to configured AI role IDs.`,
    "",
    "Cache note: when YAML files are added, removed, renamed, or edited on disk, use `/cmibot reload` or restart the bot to refresh the in-memory cache.",
  );

  return lines.join("\n");
}

function formatFileList(filePaths) {
  const fileNames = filePaths.map((filePath) => path.posix.basename(filePath));
  if (!fileNames.length) {
    return "";
  }

  if (fileNames.length <= 3) {
    return ` (${fileNames.join(" / ")})`;
  }

  const visible = fileNames.slice(0, 3).join(" / ");
  return ` (${visible} +${fileNames.length - 3} more)`;
}

function formatResultsMessage(keyword, results, totalMentions, fileCount, limit, aiSummary, allMatchedFiles) {
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

  for (const [displayPath, fileResults] of groupedResults.entries()) {
    blocks.push(`In \`${displayPath}\`:`);

    for (const result of fileResults) {
      const relatedLine = result.related?.length
        ? `Related: ${result.related
            .map((entry) => `\`${entry.yamlPath}\` (line ${entry.lineNumber})`)
            .join(", ")}\n`
        : "";

      blocks.push(
        `Look around line ${result.lineNumber} -> \`${result.yamlPath}\`\n${relatedLine}\`\`\`yml\n${result.snippet}\n\`\`\``,
      );
    }
  }

  const safeKeyword = sanitizeForDisplay(keyword);
  const header = `### Found [${totalMentions}] ${mentionLabel} in [${fileCount}] ${fileLabel} for \`${safeKeyword}\`${formatFileList(allMatchedFiles)}`;

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
  const body = buildCommandData(config.search.defaultResultLimit);

  await rest.put(Routes.applicationGuildCommands(config.discord.applicationId, config.discord.guildId), {
    body,
  });
}

export function createInteractionHandler(config, searchCache) {
  const reranker = new AiReranker(config.openai);
  const cooldowns = createCooldownManager();

  function logEvent(interaction, payload) {
    return writeAuditLog(config.workspaceRoot, config.security.auditLogPath, {
      timestamp: new Date().toISOString(),
      guildId: interaction.guildId,
      channelId: interaction.channelId,
      userId: interaction.user.id,
      userTag: interaction.user.tag,
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
    if (!interaction.isChatInputCommand() || interaction.commandName !== COMMAND_NAME) {
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
        content: "This command can only be used in the configured support channel.",
        flags: MessageFlags.Ephemeral,
        allowedMentions: NO_MENTIONS,
      });
      return;
    }

    const subcommand = interaction.options.getSubcommand();

    if (subcommand === "help") {
      await logEvent(interaction, {
        subcommand,
        outcome: "help",
      });
      await interaction.reply({
        content: formatHelpMessage(config, interaction.member),
        flags: MessageFlags.Ephemeral,
        allowedMentions: NO_MENTIONS,
      });
      return;
    }

    if (subcommand === "reload") {
      if (!hasRole(interaction.member, { roleIds: config.discord.adminRoleIds })) {
        await logEvent(interaction, {
          subcommand,
          outcome: "denied",
          reason: "reload-role",
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
          `[CMIBot] Cache reloaded by ${interaction.user.tag} in channel ${interaction.channelId}.\n${formatCacheSummary(summary, { verb: "Reloaded" })}`,
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
          content: `CMIBot failed to reload the search cache: ${message}`,
          allowedMentions: NO_MENTIONS,
        });
      }
      return;
    }

    if (
      !hasRole(interaction.member, {
        roleIds: config.discord.allowedRoleIds,
        roleNames: config.discord.allowedRoleNames,
      })
    ) {
      await logEvent(interaction, {
        subcommand,
        outcome: "denied",
        reason: "lookup-role",
      });
      await interaction.reply({
        content: "You do not have one of the allowed support roles for this command.",
        flags: MessageFlags.Ephemeral,
        allowedMentions: NO_MENTIONS,
      });
      return;
    }

    const keywordInput = interaction.options.getString("keyword", true);
    const mode = interaction.options.getString("mode") ?? "exact";
    const limit = interaction.options.getInteger("limit") ?? config.search.defaultResultLimit;
    const related = interaction.options.getBoolean("related") ?? false;
    const summary = interaction.options.getBoolean("summary") ?? false;
    const profile = config.search.profiles[subcommand];
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
      });
      await interaction.reply({
        content: validationMessage(validation.reason),
        flags: MessageFlags.Ephemeral,
        allowedMentions: NO_MENTIONS,
      });
      return;
    }

    const lookupCooldown = cooldowns.check(interaction.user.id, `${subcommand}:lookup`, config.security.lookupCooldownSeconds);
    if (!lookupCooldown.allowed) {
      await logEvent(interaction, {
        subcommand,
        keyword,
        mode,
        related,
        summary,
        outcome: "rejected",
        reason: `lookup-cooldown:${lookupCooldown.retryAfterSeconds}`,
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
        `${subcommand}:summary`,
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
      const entries = searchCache.getEntries(profile.name);
      const lexicalMatches = lexicalSearch(keyword, entries, { limit: 25, mode });
      const rerankedMatches = config.openai.enabled && canUseAi
        ? await reranker.rerank(keyword, lexicalMatches)
        : lexicalMatches;
      const orderedMatches = orderMatchesForDisplay(rerankedMatches);
      const finalMatches = orderedMatches.slice(0, limit);

      if (!finalMatches.length) {
        await logEvent(interaction, {
          subcommand,
          keyword,
          mode,
          related,
          summary,
          outcome: "empty",
        });
        await interaction.editReply({
          content: `No YAML entries matched \`${sanitizeForDisplay(keyword)}\` in the \`${subcommand}\` profile.`,
          allowedMentions: NO_MENTIONS,
        });
        return;
      }

      const visibleResults = finalMatches.map((item) => ({
        ...makeDisplayContext(item.entry, config.formatDisplayPath),
        related: related ? findRelatedEntries(item.entry, entries) : [],
      }));
      const totalMentions = orderedMatches.length;
      const fileCount = new Set(orderedMatches.map((item) => item.entry.relativePath)).size;
      let aiSummary = "";
      if (summary && config.openai.enabled && canUseAi) {
        aiSummary = (await reranker.summarize(keyword, finalMatches, { profileName: profile.name })) || "";
      }
      const allMatchedFiles = [...new Set(orderedMatches.map((item) => item.entry.relativePath))];
      const message = formatResultsMessage(
        keyword,
        visibleResults,
        totalMentions,
        fileCount,
        limit,
        aiSummary,
        allMatchedFiles,
      );

      await logEvent(interaction, {
        subcommand,
        keyword,
        mode,
        related,
        summary,
        aiEnabled: canUseAi,
        outcome: "success",
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
      });
      await interaction.editReply({
        content: `CMIBot hit an error while searching: ${message}`,
        allowedMentions: NO_MENTIONS,
      });
    }
  };
}
