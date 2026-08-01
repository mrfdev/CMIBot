import { MessageFlags } from "discord.js";
import { createLazyAiResolver, isAiEnabled } from "./aiLoader.js";
import { writeAuditLog } from "./auditLog.js";
import { formatCacheSummary } from "./cache.js";
import { registerCommands } from "./discord/commands.js";
import {
  NO_MENTIONS,
  PRIMARY_COMMAND_NAME,
  SUPPORTED_COMMAND_NAMES,
} from "./discord/constants.js";
import {
  hasRole,
  resolveCanonicalSubcommand,
  resolveChannelContext,
} from "./discord/context.js";
import { formatDebugMessage } from "./discord/debug.js";
import { formatHelpMessage } from "./discord/help.js";
import {
  formatLangStatsOnlyMessage,
  formatReloadMessage,
  formatStatsMessage,
  splitDiscordMessages,
  truncateDiscordMessage,
} from "./discord/results.js";
import { handleSearchInteraction } from "./discord/searchInteraction.js";
import {
  createSafeInteractionListener,
  reloadServicesAtomically,
  reportUnexpectedInteractionError,
} from "./discord/safety.js";
import {
  createCooldownManager,
  createSlidingWindowRateLimiter,
} from "./security.js";
import {
  formatLatestVersionMessages,
  formatPublicLatestVersions,
  formatVersionServiceSummary,
} from "./versionCatalog.js";

export { registerCommands } from "./discord/commands.js";
export { formatHelpMessage } from "./discord/help.js";
export { splitDiscordMessages } from "./discord/results.js";
export { createSafeInteractionListener, reloadServicesAtomically } from "./discord/safety.js";

export function createInteractionHandler(config, searchCache, versionService, dependencies = {}) {
  const aiEnabled = isAiEnabled(config.openai);
  const resolveAiReranker = createLazyAiResolver(config.openai, {
    loadAiModule: dependencies.loadAiModule,
  });
  const cooldowns = createCooldownManager();
  const rateLimiter = createSlidingWindowRateLimiter();
  const testOverrides = new Map();
  let reloadInProgress = false;

  function logEvent(interaction, payload) {
    return writeAuditLog(
      config.workspaceRoot,
      config.security.auditLogPath,
      {
        timestamp: new Date().toISOString(),
        guildId: interaction.guildId,
        channelId: interaction.channelId,
        userId: interaction.user.id,
        userTag: interaction.user.tag,
        commandName: interaction.commandName,
        ...payload,
      },
      {
        maxBytes: config.security.auditLogMaxBytes,
        maxFiles: config.security.auditLogMaxFiles,
      },
    );
  }

  async function logRateLimitEvent(interaction, auditKey, payload) {
    const auditCooldown = cooldowns.check(
      "rate-limit-audit",
      auditKey,
      config.security.rateLimitAuditCooldownSeconds ?? 30,
    );
    if (auditCooldown.allowed) {
      await logEvent(interaction, payload);
    }
  }

  async function handleInteraction(interaction) {
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

    const subcommand = interaction.options.getSubcommand();
    const canonicalSubcommand = resolveCanonicalSubcommand(subcommand);
    let context = resolveChannelContext(interaction.channelId, config, testOverrides);

    const userRateLimit = rateLimiter.check(
      `user:${interaction.user.id}`,
      config.security.commandUserRateLimit,
      config.security.commandRateWindowSeconds,
      "user",
    );
    if (!userRateLimit.allowed) {
      await logRateLimitEvent(interaction, `user:${interaction.user.id}`, {
        subcommand,
        outcome: "rejected",
        reason: `user-rate-limit:${userRateLimit.retryAfterSeconds}`,
        detectedContext: context.pluginId || "unknown",
      });
      await interaction.reply({
        content: `You are sending bot commands too quickly. Try again in ${userRateLimit.retryAfterSeconds}s.`,
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

    if (canonicalSubcommand === "debug") {
      if (!hasRole(interaction.member, { roleIds: config.discord.adminRoleIds })) {
        await logEvent(interaction, {
          subcommand,
          outcome: "denied",
          reason: "debug-role",
          detectedContext: context.pluginId || "unknown",
        });
        await interaction.reply({
          content: "Only the configured admin role can use the debug command.",
          flags: MessageFlags.Ephemeral,
          allowedMentions: NO_MENTIONS,
        });
        return;
      }

      const debugCooldown = cooldowns.check("global", "admin:debug", config.security.debugCooldownSeconds);
      if (!debugCooldown.allowed) {
        await logRateLimitEvent(interaction, "admin:debug", {
          subcommand,
          outcome: "rejected",
          reason: `debug-cooldown:${debugCooldown.retryAfterSeconds}`,
          detectedContext: context.pluginId || "unknown",
        });
        await interaction.reply({
          content: `Debug diagnostics were just generated. Try again in ${debugCooldown.retryAfterSeconds}s.`,
          flags: MessageFlags.Ephemeral,
          allowedMentions: NO_MENTIONS,
        });
        return;
      }

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
        content: truncateDiscordMessage(
          await formatDebugMessage(interaction, context, config, searchCache, versionService, testOverrides),
        ),
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

      if (reloadInProgress) {
        await logRateLimitEvent(interaction, "admin:reload-in-progress", {
          subcommand,
          outcome: "rejected",
          reason: "reload-in-progress",
          detectedContext: context.pluginId,
        });
        await interaction.reply({
          content: "A global cache reload is already in progress. Please wait for it to finish.",
          flags: MessageFlags.Ephemeral,
          allowedMentions: NO_MENTIONS,
        });
        return;
      }

      const reloadCooldown = cooldowns.check(
        "global",
        "admin:reload",
        config.security.reloadCooldownSeconds,
      );
      if (!reloadCooldown.allowed) {
        await logRateLimitEvent(interaction, "admin:reload", {
          subcommand,
          outcome: "rejected",
          reason: `reload-cooldown:${reloadCooldown.retryAfterSeconds}`,
          detectedContext: context.pluginId,
        });
        await interaction.reply({
          content: `The global cache was reloaded recently. Try again in ${reloadCooldown.retryAfterSeconds}s.`,
          flags: MessageFlags.Ephemeral,
          allowedMentions: NO_MENTIONS,
        });
        return;
      }

      reloadInProgress = true;
      try {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        let reloadResult;
        try {
          reloadResult = await reloadServicesAtomically(searchCache, versionService);
        } catch (error) {
          const message = error instanceof Error ? error.message : "Unknown error";
          await logEvent(interaction, {
            subcommand,
            outcome: "error",
            reason: message,
          });
          await interaction.editReply({
            content: `The bot failed to prepare a complete reload, so the existing cache and version snapshots remain active: ${message}`,
            allowedMentions: NO_MENTIONS,
          });
          return;
        }

        const { summary, versionSnapshot } = reloadResult;
        await logEvent(interaction, {
          subcommand,
          outcome: "success",
          totalEntries: summary.totalEntries,
          totalFiles: summary.totalFiles,
        });
        console.log(
          `[LookupBot] Cache reloaded by ${interaction.user.tag} in channel ${interaction.channelId}.\n${formatCacheSummary(summary, { verb: "Reloaded" })}\n${formatVersionServiceSummary(versionSnapshot)}`,
        );
        const reloadMessages = splitDiscordMessages(
          `${formatReloadMessage(summary)}\nVersion catalog and upstream checks refreshed.`,
        );
        await interaction.editReply({
          content: reloadMessages[0],
          allowedMentions: NO_MENTIONS,
        });
        for (const message of reloadMessages.slice(1)) {
          await interaction.followUp({
            content: message,
            flags: MessageFlags.Ephemeral,
            allowedMentions: NO_MENTIONS,
          });
        }
      } finally {
        reloadInProgress = false;
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

    const sharedRateLimit = rateLimiter.checkMany([
      {
        key: `channel:${interaction.channelId}`,
        scope: "channel",
        maxRequests: config.security.commandChannelRateLimit,
        windowSeconds: config.security.commandRateWindowSeconds,
      },
      {
        key: "global",
        scope: "global",
        maxRequests: config.security.commandGlobalRateLimit,
        windowSeconds: config.security.commandRateWindowSeconds,
      },
    ]);
    if (!sharedRateLimit.allowed) {
      const isChannelLimit = sharedRateLimit.scope === "channel";
      await logRateLimitEvent(
        interaction,
        isChannelLimit ? `channel:${interaction.channelId}` : "global",
        {
          subcommand,
          outcome: "rejected",
          reason: `${sharedRateLimit.scope}-rate-limit:${sharedRateLimit.retryAfterSeconds}`,
          detectedContext: context.pluginId,
        },
      );
      await interaction.reply({
        content: isChannelLimit
          ? `This channel is receiving too many bot requests. Try again in ${sharedRateLimit.retryAfterSeconds}s.`
          : `The bot is temporarily handling too many requests. Try again in ${sharedRateLimit.retryAfterSeconds}s.`,
        flags: MessageFlags.Ephemeral,
        allowedMentions: NO_MENTIONS,
      });
      return;
    }

    if (canonicalSubcommand === "latest") {
      const scope = interaction.options.getString("scope") ?? "context";
      const publicResponse = interaction.options.getBoolean("public") ?? false;

      if (publicResponse && scope !== "context") {
        await logEvent(interaction, {
          subcommand,
          scope,
          visibility: "public",
          outcome: "denied",
          reason: "public-all-scope",
          detectedContext: context.pluginId,
        });
        await interaction.reply({
          content: "Public version posts are limited to the current channel context. Remove `scope:all` and try again.",
          flags: MessageFlags.Ephemeral,
          allowedMentions: NO_MENTIONS,
        });
        return;
      }

      const snapshot = versionService.getSnapshot();
      let versionMessages;
      try {
        versionMessages = publicResponse
          ? splitDiscordMessages(formatPublicLatestVersions(snapshot, context.plugin))
          : formatLatestVersionMessages(snapshot, context.plugin, scope).flatMap((message) =>
              splitDiscordMessages(message),
            );
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        await logEvent(interaction, {
          subcommand,
          scope,
          visibility: publicResponse ? "public" : "private",
          outcome: "error",
          reason: message,
          detectedContext: context.pluginId,
        });
        await interaction.reply({
          content: publicResponse
            ? `No public version result was posted: ${message}`
            : `The bot hit an error while loading version information: ${message}`,
          flags: MessageFlags.Ephemeral,
          allowedMentions: NO_MENTIONS,
        });
        return;
      }

      if (publicResponse) {
        await interaction.deferReply();
      } else {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      }

      try {
        await logEvent(interaction, {
          subcommand,
          scope,
          visibility: publicResponse ? "public" : "private",
          outcome: "success",
          detectedContext: context.pluginId,
          versionCheckErrors: snapshot.errorCount,
        });
        await interaction.editReply({
          content: versionMessages[0],
          allowedMentions: NO_MENTIONS,
        });
        for (const message of versionMessages.slice(1)) {
          const followUp = {
            content: message,
            allowedMentions: NO_MENTIONS,
          };
          if (!publicResponse) {
            followUp.flags = MessageFlags.Ephemeral;
          }
          await interaction.followUp(followUp);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        await logEvent(interaction, {
          subcommand,
          outcome: "error",
          reason: message,
          detectedContext: context.pluginId,
        });
        const content = `The bot hit an error while loading version information: ${message}`;
        if (publicResponse) {
          await interaction.deleteReply().catch(() => {});
          await interaction.followUp({
            content,
            flags: MessageFlags.Ephemeral,
            allowedMentions: NO_MENTIONS,
          });
        } else {
          await interaction.editReply({ content, allowedMentions: NO_MENTIONS });
        }
      }
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

    await handleSearchInteraction({
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
    });
  }

  return createSafeInteractionListener(handleInteraction, (interaction, error) =>
    reportUnexpectedInteractionError(interaction, error, logEvent),
  );
}
