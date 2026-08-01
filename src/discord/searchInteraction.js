import { MessageFlags } from "discord.js";
import { lexicalSearchWithStats, orderMatchesForDisplay } from "../search.js";
import { resolveFileFilter, sanitizeForDisplay, validateQuery } from "../security.js";
import { findRelatedEntries, makeDisplayContext } from "../yamlIndex.js";
import { NO_MENTIONS, PRIMARY_COMMAND_NAME } from "./constants.js";
import {
  formatCommandUnavailableMessage,
  getCommandAvailability,
  hasRole,
} from "./context.js";
import { formatResultsMessage, truncateDiscordMessage } from "./results.js";

function validationMessage(reason, queryDebugErrors) {
  if (queryDebugErrors) {
    return reason;
  }

  return "That search was rejected by input validation. Please use a short, specific keyword or phrase.";
}

function getResultLayout(canonicalSubcommand) {
  switch (canonicalSubcommand) {
    case "material":
      return "materialList";
    case "faq":
    case "placeholder":
    case "tabcomplete":
    case "permission":
    case "command":
      return canonicalSubcommand;
    default:
      return "default";
  }
}

export async function handleSearchInteraction({
  interaction,
  subcommand,
  canonicalSubcommand,
  context,
  config,
  searchCache,
  aiEnabled,
  resolveAiReranker,
  cooldowns,
  logEvent,
  logRateLimitEvent,
}) {
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
      content: validationMessage(validation.reason, config.security.queryDebugErrors),
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
    await logRateLimitEvent(interaction, `lookup:${interaction.user.id}:${context.plugin.id}:${canonicalSubcommand}`, {
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

  const allProfileEntries = searchCache.getEntries(context.plugin.id, canonicalSubcommand);
  const fileFilter = resolveFileFilter(fileInput, allProfileEntries, {
    profileLabel:
      canonicalSubcommand === "config"
        ? `${context.plugin.label} config`
        : `${context.plugin.label} ${canonicalSubcommand}`,
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
      content: aiEnabled
        ? "AI-backed options like `summary:true` are currently limited to the configured admin-only group."
        : "AI-backed options are currently disabled in bot config.",
      flags: MessageFlags.Ephemeral,
      allowedMentions: NO_MENTIONS,
    });
    return;
  }

  if (summary && aiEnabled) {
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
    const searchResult = lexicalSearchWithStats(keyword, entries, { limit: 25, mode });
    const lexicalMatches = searchResult.matches;
    const reranker = aiEnabled && canUseAi ? await resolveAiReranker() : null;
    const rerankedMatches = reranker ? await reranker.rerank(keyword, lexicalMatches) : lexicalMatches;
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
    const totalMentions = searchResult.totalMatches;
    const fileCount = searchResult.matchedFiles.length;
    let aiSummary = "";
    if (summary && reranker && canUseAi) {
      aiSummary =
        (await reranker.summarize(keyword, finalMatches, {
          profileName: `${context.plugin.id}:${canonicalSubcommand}`,
        })) || "";
    }
    const allMatchedFiles = searchResult.matchedFiles;
    const message = formatResultsMessage(
      keyword,
      visibleResults,
      totalMentions,
      fileCount,
      aiSummary,
      allMatchedFiles,
      {
        profile,
        preferShortPath: canonicalSubcommand === "language",
        showFileHints: canonicalSubcommand === "config",
        layout: getResultLayout(canonicalSubcommand),
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
}
