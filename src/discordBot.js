import { MessageFlags, REST, Routes, SlashCommandBuilder } from "discord.js";
import path from "node:path";
import { writeAuditLog } from "./auditLog.js";
import { formatCacheSummary } from "./cache.js";
import { formatLanguageCategoryStats } from "./langStats.js";
import { createCooldownManager, resolveFileFilter, sanitizeForDisplay, validateQuery } from "./security.js";
import { AiReranker, lexicalSearch, orderMatchesForDisplay } from "./search.js";
import { findRelatedEntries, makeDisplayContext } from "./yamlIndex.js";

const COMMAND_NAME = "cmibot";
const MAX_RESULT_LIMIT = 15;
const MATERIAL_MAX_RESULT_LIMIT = 25;
const NO_MENTIONS = { parse: [] };

function pluralize(count, singular, plural = `${singular}s`) {
  return count === 1 ? singular : plural;
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
        .setDescription("Optional indexed config file filter, like Chat.yml or CMI/Settings/Chat.yml."),
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

function buildCommandData(config) {
  const defaultResultLimit = config.search.defaultResultLimit;
  const materialDefaultLimit = config.search.profiles.material.defaultResultLimit ?? MATERIAL_MAX_RESULT_LIMIT;

  return [
    new SlashCommandBuilder()
      .setName(COMMAND_NAME)
      .setDescription("Look up CMI or CMILib config, locale, or exported data entries by keyword.")
      .addSubcommand((subcommand) =>
        subcommand.setName("help").setDescription("Show available CMIBot commands and usage notes."),
      )
      .addSubcommand((subcommand) =>
        addCommonLookupOptions(
          subcommand
            .setName("config")
            .setDescription("Search regular CMI and CMILib config files."),
          defaultResultLimit,
          { includeRelated: true, includeFileFilter: true },
        ),
      )
      .addSubcommand((subcommand) =>
        addCommonLookupOptions(
          subcommand
            .setName("language")
            .setDescription("Search English locale and translation YAML files."),
          defaultResultLimit,
          { includeRelated: true },
        ),
      )
      .addSubcommand((subcommand) =>
        addCommonLookupOptions(
          subcommand
            .setName("lang")
            .setDescription("Alias for the English locale and translation search."),
          defaultResultLimit,
          { includeRelated: true },
        ),
      )
      .addSubcommand((subcommand) =>
        addCommonLookupOptions(
          subcommand
            .setName("placeholder")
            .setDescription("Search exported CMI placeholder entries."),
          defaultResultLimit,
        ),
      )
      .addSubcommand((subcommand) =>
        addCommonLookupOptions(
          subcommand
            .setName("material")
            .setDescription("Search exported material names."),
          materialDefaultLimit,
          { maxResultLimit: MATERIAL_MAX_RESULT_LIMIT },
        ),
      )
      .addSubcommand((subcommand) =>
        addCommonLookupOptions(
          subcommand
            .setName("command")
            .setDescription("Search exported CMI command usage entries."),
          defaultResultLimit,
        ),
      )
      .addSubcommand((subcommand) =>
        addCommonLookupOptions(
          subcommand
            .setName("cmd")
            .setDescription("Alias for the exported CMI command usage search."),
          defaultResultLimit,
        ),
      )
      .addSubcommand((subcommand) =>
        addCommonLookupOptions(
          subcommand
            .setName("permission")
            .setDescription("Search exported permission nodes and command permissions."),
          defaultResultLimit,
        ),
      )
      .addSubcommand((subcommand) =>
        addCommonLookupOptions(
          subcommand
            .setName("perm")
            .setDescription("Alias for the exported permission search."),
          defaultResultLimit,
        ),
      )
      .addSubcommand((subcommand) =>
        addCommonLookupOptions(
          subcommand
            .setName("faq")
            .setDescription("Search curated CMI FAQ titles, links, and pre-sales answers."),
          defaultResultLimit,
        ),
      )
      .addSubcommand((subcommand) =>
        addCommonLookupOptions(
          subcommand
            .setName("tabcomplete")
            .setDescription("Search exported tab-complete token entries."),
          defaultResultLimit,
        ),
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName("langstats")
          .setDescription("Show English locale categories, English file paths, and available language codes."),
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName("stats")
          .setDescription("Show cache totals and per-profile entry/file counts."),
      )
      .addSubcommand((subcommand) =>
        subcommand.setName("reload").setDescription("Reload the in-memory search cache."),
      )
      .toJSON(),
  ];
}

function hasRole(member, { roleIds = [] } = {}) {
  const roles = member.roles?.cache;
  if (!roles) {
    return false;
  }

  return roleIds.length > 0 && roles.some((role) => roleIds.includes(role.id));
}

function formatReloadMessage(summary) {
  return formatCacheSummary(summary, { verb: "Reloaded" }).replace(/- (\w+):/g, "- `$1`:");
}

function formatHelpMessage(config, member) {
  const canLookup = hasRole(member, { roleIds: config.discord.allowedRoleIds });
  const canReload = hasRole(member, { roleIds: config.discord.adminRoleIds });
  const canUseAi = hasRole(member, { roleIds: config.discord.aiRoleIds });
  const aiEnabled = config.openai.enabled;

  const lines = [
    "### CMIBot Help",
    "Commands available through this bot:",
    "- `/cmibot help` shows this help message",
    "- `/cmibot config <keyword>` searches regular CMI and CMILib config files",
    "- `/cmibot language|lang <keyword>` searches English locale and translation files",
    "- `/cmibot placeholder <keyword>` searches exported placeholder entries",
    "- `/cmibot material <keyword>` searches exported material names",
    "- `/cmibot command|cmd <keyword>` searches exported command entries",
    "- `/cmibot permission|perm <keyword>` searches exported permission entries",
    "- `/cmibot faq <keyword>` searches curated FAQ titles and links",
    "- `/cmibot tabcomplete <keyword>` searches exported tab-complete entries",
    "- `/cmibot langstats` shows English locale categories and language codes",
    "- `/cmibot stats` shows cache totals and per-profile counts",
    "- `/cmibot reload` refreshes the in-memory search cache from disk",
    "",
    "Options:",
    "- `mode: exact|whole|broad` controls how strict the search is",
    "- `file: <name>` narrows `config` to a matching indexed file like `Chat.yml` or `CMI/Settings/Chat.yml`",
    `- \`limit: 1-${MAX_RESULT_LIMIT}\` is used by most commands, with \`${config.search.defaultResultLimit}\` as the default`,
    `- \`material\` uses \`limit: 1-${MATERIAL_MAX_RESULT_LIMIT}\` and defaults to \`${config.search.profiles.material.defaultResultLimit ?? MATERIAL_MAX_RESULT_LIMIT}\``,
    "- `related: true|false` adds nearby YAML entries for `config`, `language`, and `lang`",
    aiEnabled
      ? "- `summary: true|false` adds an optional AI-generated summary (admin-only for now)"
      : "- `summary: true|false` is currently disabled in bot config",
    "",
    "Examples:",
    "- `/cmibot config dynmap`",
    "- `/cmibot config chat file:Chat.yml`",
    "- `/cmibot config \"mini message\" mode:whole`",
    "- `/cmibot config bluemap related:true`",
    "- `/cmibot language home`",
    "- `/cmibot lang \"was fireballed by\"`",
    "- `/cmibot placeholder balance`",
    "- `/cmibot material shulker`",
    "- `/cmibot cmd balance`",
    "- `/cmibot perm cmi.command.balance`",
    "- `/cmibot faq refund`",
    "- `/cmibot tabcomplete [playername] mode:whole`",
    "- `/cmibot stats`",
  ];

  if (!canLookup) {
    lines.push(
      "",
      "Notice: config, language, lang, placeholder, material, command, permission, faq, tabcomplete, langstats, stats, and reload are limited to certain support/admin groups.",
    );
  } else if (aiEnabled && !canReload && !canUseAi) {
    lines.push(
      "",
      "Notice: you can use search commands here, but `/cmibot reload` and AI-backed options like `summary:true` are restricted.",
    );
  } else if (!canReload) {
    lines.push("", "Notice: you can use search commands here, but `/cmibot reload` is admin-only.");
  } else {
    lines.push(
      "",
      "Notice: you can use config, language, lang, placeholder, material, command, permission, faq, tabcomplete, langstats, stats, and reload in this channel.",
    );
  }

  return lines.join("\n");
}

function formatStatsMessage(summary) {
  return [`### CMIBot Stats`, formatCacheSummary(summary)].join("\n");
}

function resolveProfileName(subcommand) {
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

function formatLanguageStatsMessage(languageCategories, formatDisplayPath) {
  if (!languageCategories?.length) {
    return "";
  }

  const blocks = ["Language categories:"];

  for (const category of languageCategories) {
    const displayPath = formatDisplayPath(category.englishRelativePath);
    const languageLabel = pluralize(category.languageCount, "language");
    const codes = category.languageCodes.map((code) => `\`${code}\``).join(", ");
    blocks.push(`- \`${category.label}\` -> \`${displayPath}\`\n(${category.languageCount} ${languageLabel}: ${codes})`);
  }

  return blocks.join("\n\n");
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
  const filtered = lines.filter((line) => !/^\s*#\s*URL:\s*/i.test(line));

  if (filtered[filtered.length - 1]?.trim() === yamlPath.trim()) {
    filtered.pop();
  }

  return filtered.join("\n").trimEnd();
}

function formatResultLead(result, options) {
  if (options.layout === "faq") {
    const url = extractUrlFromComments(result.comments);
    return url ? `[${sanitizeForDisplay(result.yamlPath)}](<${url}>)` : `\`${result.yamlPath}\``;
  }

  if (options.layout === "permission" || options.layout === "command") {
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

function formatLangStatsOnlyMessage(languageCategories, formatDisplayPath) {
  const statsBody = formatLanguageStatsMessage(languageCategories, formatDisplayPath);
  if (!statsBody) {
    return "No language category stats are available right now.";
  }

  const count = languageCategories.length;
  return [`### Language Stats`, `Found [${count}] ${pluralize(count, "category")} for English locale coverage.`, "", statsBody]
    .filter(Boolean)
    .join("\n");
}

function formatResultsMessage(
  keyword,
  results,
  totalMentions,
  fileCount,
  limit,
  aiSummary,
  allMatchedFiles,
  options = {},
  extras = [],
) {
  if (options.layout === "materialList") {
    return formatMaterialResultsMessage(keyword, results, totalMentions, fileCount, allMatchedFiles);
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

  for (const [displayPath, fileResults] of groupedResults.entries()) {
    const heading =
      options.layout === "faq"
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
        ? `Related: ${result.related
            .map((entry) => `\`${entry.yamlPath}\` (line ${entry.lineNumber})`)
            .join(", ")}\n`
        : "";
      blocks.push([leadLine, `${relatedLine}\`\`\`${result.codeLanguage}\n${snippet}\n\`\`\``].filter(Boolean).join("\n"));
    }
  }

  const safeKeyword = sanitizeForDisplay(keyword);
  const fileHint = options.showFileHints === false ? "" : formatFileList(allMatchedFiles, options);
  const header =
    options.layout === "faq"
      ? `### Found [${totalMentions}] ${mentionLabel} for \`${safeKeyword}\``
      : `### Found [${totalMentions}] ${mentionLabel} in [${fileCount}] ${fileLabel} for \`${safeKeyword}\`${fileHint}`;

  let footer = "";
  if (shownCount === totalMentions) {
    footer = `_Showing ${shownCount} ${pluralize(shownCount, "result")}._`;
  } else if (totalMentions > shownCount) {
    footer = `_Showing top ${shownCount} results, but there are more._`;
  }

  const summaryBlock = aiSummary ? `AI summary (generated): ${aiSummary}` : "";

  return [header, ...blocks, summaryBlock, ...extras.filter(Boolean), footer].filter(Boolean).join("\n");
}

function formatMaterialResultsMessage(keyword, results, totalMentions, fileCount, allMatchedFiles) {
  const mentionLabel = pluralize(totalMentions, "mention");
  const fileLabel = pluralize(fileCount, "file");
  const safeKeyword = sanitizeForDisplay(keyword);
  const header = `### Found [${totalMentions}] ${mentionLabel} in [${fileCount}] ${fileLabel} for \`${safeKeyword}\``;
  const groups = new Map();

  for (const result of results) {
    if (!groups.has(result.displayPath)) {
      groups.set(result.displayPath, []);
    }

    groups.get(result.displayPath).push(result);
  }

  const blocks = [];
  for (const [displayPath, fileResults] of groups.entries()) {
    const lines = fileResults.map((result) => result.lineNumber).join(", ");
    const values = fileResults.map((result) => result.yamlPath).join("\n");
    blocks.push(`From bot's: \`${displayPath}\`\nLines: ${lines}\n\`\`\`text\n${values}\n\`\`\``);
  }

  const footer = `_Showing ${results.length} ${pluralize(results.length, "result")}${totalMentions > results.length ? ", but there are more." : "."}_`;
  return [header, ...blocks, footer].filter(Boolean).join("\n");
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
        content: truncateDiscordMessage(formatHelpMessage(config, interaction.member)),
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

    if (!hasRole(interaction.member, { roleIds: config.discord.allowedRoleIds })) {
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

    if (subcommand === "stats") {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      try {
        const profiles = Object.values(config.search.profiles);
        const profileSummaries = profiles
          .map((profile) => {
            const snapshot = searchCache.getSnapshot(profile.name);
            return {
              profileName: profile.name,
              profileDisplayName: profile.displayName ?? profile.name,
              statsFileLabel: profile.statsFileLabel ?? "",
              entryCount: snapshot?.entryCount ?? 0,
              fileCount: snapshot?.fileCount ?? 0,
            };
          });
        const totalEntries = profileSummaries.reduce((sum, item) => sum + item.entryCount, 0);
        const totalFiles = profileSummaries.reduce((sum, item) => sum + item.fileCount, 0);
        const summary = {
          totalEntries,
          totalFiles,
          profileSummaries,
        };

        await logEvent(interaction, {
          subcommand,
          outcome: "success",
          totalEntries,
          totalFiles,
        });
        await interaction.editReply({
          content: truncateDiscordMessage(formatStatsMessage(summary)),
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
          content: `CMIBot hit an error while loading stats: ${message}`,
          allowedMentions: NO_MENTIONS,
        });
      }
      return;
    }

    if (subcommand === "langstats") {
      await interaction.deferReply();

      try {
        const snapshot = searchCache.getSnapshot("language");
        const languageCategories = snapshot?.languageCategories ?? [];
        const message = formatLangStatsOnlyMessage(languageCategories, config.formatDisplayPath);

        await logEvent(interaction, {
          subcommand,
          outcome: "success",
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
        });
        await interaction.editReply({
          content: `CMIBot hit an error while loading language stats: ${message}`,
          allowedMentions: NO_MENTIONS,
        });
      }
      return;
    }

    const keywordInput = interaction.options.getString("keyword", true);
    const fileInput = interaction.options.getString("file") ?? "";
    const mode = interaction.options.getString("mode") ?? "exact";
    const profile = config.search.profiles[resolveProfileName(subcommand)];
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
      });
      await interaction.reply({
        content: validationMessage(validation.reason),
        flags: MessageFlags.Ephemeral,
        allowedMentions: NO_MENTIONS,
      });
      return;
    }

    const allProfileEntries = searchCache.getEntries(profile.name);
    const fileFilter = resolveFileFilter(fileInput, allProfileEntries, {
      profileLabel: profile.name === "config" ? "config" : profile.name,
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
      `${profile.name}:lookup`,
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
        `${profile.name}:summary`,
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
      const entries = fileFilter.filteredEntries;
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
          file: fileFilter.normalizedFilter,
          mode,
          related,
          summary,
          outcome: "empty",
        });
        await interaction.editReply({
          content: `No ${profile.entryLabel ?? "entries"} matched \`${sanitizeForDisplay(keyword)}\` in the \`${subcommand}\` profile${fileFilter.normalizedFilter ? ` with file filter \`${sanitizeForDisplay(fileFilter.normalizedFilter)}\`` : ""}.`,
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
        {
          preferShortPath: profile.name === "language",
          showFileHints: profile.name === "config",
          layout:
            profile.name === "material"
              ? "materialList"
              : profile.name === "faq"
                ? "faq"
                : profile.name === "permission"
                  ? "permission"
                  : profile.name === "command"
                    ? "command"
                    : "default",
        },
      );

      await logEvent(interaction, {
        subcommand,
        keyword,
        file: fileFilter.normalizedFilter,
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
