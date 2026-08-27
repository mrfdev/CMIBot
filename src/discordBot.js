import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { MessageFlags } from "discord.js";
import { createLazyAiResolver, isAiEnabled } from "./aiLoader.js";
import { writeAuditLog } from "./auditLog.js";
import { registerCommands } from "./discord/commands.js";
import {
  buildAutocompleteIndex,
  selectAutocompleteChoices,
} from "./discord/autocomplete.js";
import {
  NO_MENTIONS,
  PRIMARY_COMMAND_NAME,
  SUPPORTED_COMMAND_NAMES,
} from "./discord/constants.js";
import {
  getCommandAvailability,
  hasRole,
  resolveCanonicalSubcommand,
  resolveChannelContext,
} from "./discord/context.js";
import { formatDebugMessage } from "./discord/debug.js";
import {
  formatIndexedCategoriesMessage,
  formatIndexedFilesMessage,
  listSafeIndexedFiles,
} from "./discord/browse.js";
import { formatHelpMessage } from "./discord/help.js";
import { formatHealthMessage } from "./discord/health.js";
import { createExpandedYamlContextPayload } from "./discord/expandedContext.js";
import { createResultPagination } from "./discord/pagination.js";
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
  resolveReloadScope,
} from "./discord/safety.js";
import {
  createCooldownManager,
  createSlidingWindowRateLimiter,
} from "./security.js";
import { sanitizeLogText, serviceLogger } from "./logger.js";
import { createRelatedReferenceIndex } from "./relatedReferences.js";
import {
  formatLatestVersionMessages,
  formatPublicLatestVersions,
} from "./versionCatalog.js";

export { registerCommands } from "./discord/commands.js";
export { formatHelpMessage } from "./discord/help.js";
export { splitDiscordMessages } from "./discord/results.js";
export {
  createSafeInteractionListener,
  reloadServicesAtomically,
  resolveReloadScope,
} from "./discord/safety.js";

export function createInteractionHandler(config, searchCache, versionService, dependencies = {}) {
  const logger = dependencies.logger ?? serviceLogger;
  const metrics = dependencies.metrics;
  const createRequestId = dependencies.createRequestId ?? randomUUID;
  const monotonicNow = dependencies.monotonicNow ?? (() => performance.now());
  const aiEnabled = isAiEnabled(config.openai);
  const resolveAiReranker = createLazyAiResolver(config.openai, {
    loadAiModule: dependencies.loadAiModule,
    logger,
    metrics,
  });
  const cooldowns = createCooldownManager();
  const rateLimiter = createSlidingWindowRateLimiter();
  const testOverrides = new Map();
  const requestMetadata = new WeakMap();
  const pagination = dependencies.pagination ?? createResultPagination(config.search);
  const autocompleteIndexes = new Map();
  const relatedReferenceIndexes = new Map();
  let autocompleteGeneration = -1;
  let relatedReferenceGeneration = -1;
  let reloadInProgress = false;

  function getAutocompleteIndex(context, profileName) {
    const generation = searchCache.getGeneration?.() ?? 0;
    if (generation !== autocompleteGeneration) {
      autocompleteIndexes.clear();
      autocompleteGeneration = generation;
    }

    const cacheKey = `${context.plugin.id}:${profileName}`;
    let index = autocompleteIndexes.get(cacheKey);
    if (!index) {
      const entries = searchCache.getEntries(context.plugin.id, profileName);
      const allowedRoots = [
        ...(context.plugin.debugRoots ?? []),
        ...(config.sharedDebugRoots ?? []).flatMap((root) => root.directories ?? []),
      ];
      index = buildAutocompleteIndex(entries, {
        allowedRoots,
        maximumKeywordLength: config.security.queryMaxLength,
      });
      autocompleteIndexes.set(cacheKey, index);
    }
    return index;
  }

  function getRelatedReferenceIndex(context) {
    const generation = searchCache.getGeneration?.() ?? 0;
    if (generation !== relatedReferenceGeneration) {
      relatedReferenceIndexes.clear();
      relatedReferenceGeneration = generation;
    }

    const cacheKey = context.plugin.id;
    let index = relatedReferenceIndexes.get(cacheKey);
    if (!index) {
      const entriesByProfile = Object.fromEntries(
        Object.keys(context.plugin.profiles).map((profileName) => [
          profileName,
          searchCache.getEntries(context.plugin.id, profileName),
        ]),
      );
      index = createRelatedReferenceIndex(entriesByProfile);
      relatedReferenceIndexes.set(cacheKey, index);
    }
    return index;
  }

  async function handleAutocompleteInteraction(interaction) {
    let choices = [];
    try {
      const allowedRequest =
        SUPPORTED_COMMAND_NAMES.has(interaction.commandName) &&
        interaction.guildId === config.discord.guildId &&
        config.discord.allowedChannelIds.includes(interaction.channelId) &&
        hasRole(interaction.member, { roleIds: config.discord.allowedRoleIds });

      if (allowedRequest) {
        const subcommand = interaction.options.getSubcommand();
        const canonicalSubcommand = resolveCanonicalSubcommand(subcommand);
        const context = resolveChannelContext(interaction.channelId, config, testOverrides);
        const focused = interaction.options.getFocused(true);
        const optionName = focused?.name;
        const optionIsSupported =
          optionName === "keyword" ||
          (optionName === "file" && canonicalSubcommand === "config");

        if (
          context.plugin &&
          optionIsSupported &&
          context.plugin.profiles?.[canonicalSubcommand] &&
          getCommandAvailability(context.plugin, canonicalSubcommand) === "ready"
        ) {
          const index = getAutocompleteIndex(context, canonicalSubcommand);
          choices = selectAutocompleteChoices(index, optionName, focused.value);
        }
      }
    } catch {
      logger.warn("discord.autocomplete_unavailable", { resolved: false });
      choices = [];
    }

    try {
      await interaction.respond(choices);
    } catch {
      logger.warn("discord.autocomplete_response_failed", { responded: false });
    }
  }

  function logEvent(interaction, payload) {
    const request = requestMetadata.get(interaction);
    if (request && payload.outcome) {
      request.outcome = payload.outcome;
    }
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
        requestId: request?.requestId ?? "untracked",
        elapsedMs: request ? Math.max(0, Math.round(monotonicNow() - request.startedAt)) : 0,
        ...payload,
        ...(payload.reason ? { reason: sanitizeLogText(payload.reason) } : {}),
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
    if (interaction.isAutocomplete?.()) {
      await handleAutocompleteInteraction(interaction);
      return;
    }

    if (pagination.isPaginationButton(interaction)) {
      const context = resolveChannelContext(interaction.channelId, config, testOverrides);
      const result = pagination.resolveButton(interaction.customId, {
        userId: interaction.user?.id,
        guildId: interaction.guildId,
        channelId: interaction.channelId,
        pluginId: context.pluginId,
        cacheGeneration: searchCache.getGeneration?.() ?? 0,
        hasAccess:
          config.discord.allowedChannelIds.includes(interaction.channelId) &&
          hasRole(interaction.member, { roleIds: config.discord.allowedRoleIds }),
      });
      logger.info("discord.pagination_action", {
        status: result.status,
        action: result.action ?? "none",
        pageNumber: result.pageNumber ?? 0,
      });

      if (result.status === "ok") {
        await interaction.update(result.payload);
        return;
      }

      const content =
        result.status === "unauthorized"
          ? "These result controls belong to the support member who ran the lookup."
          : result.status === "stale"
            ? "The lookup cache changed after these results were created. Run the lookup again."
            : result.status === "invalid-context"
              ? "These result controls are not valid in this channel or plugin context."
              : "These result controls expired. Run the lookup again for fresh results.";
      await interaction.reply({
        content,
        flags: MessageFlags.Ephemeral,
        allowedMentions: NO_MENTIONS,
      });
      return;
    }

    if (pagination.isContextSelect(interaction)) {
      const context = resolveChannelContext(interaction.channelId, config, testOverrides);
      const result = pagination.resolveContextSelection(
        interaction.customId,
        interaction.values?.[0],
        {
          userId: interaction.user?.id,
          guildId: interaction.guildId,
          channelId: interaction.channelId,
          pluginId: context.pluginId,
          cacheGeneration: searchCache.getGeneration?.() ?? 0,
          hasAccess:
            config.discord.allowedChannelIds.includes(interaction.channelId) &&
            hasRole(interaction.member, { roleIds: config.discord.allowedRoleIds }),
        },
      );
      logger.info("discord.context_expansion", {
        status: result.status,
        resultNumber: result.resultNumber ?? 0,
      });

      if (result.status === "ok") {
        const payload = createExpandedYamlContextPayload(result.result, {
          attachmentSizeLimit: interaction.attachmentSizeLimit,
        });
        if (payload) {
          await interaction.reply({
            ...payload,
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
      }

      const content =
        result.status === "unauthorized"
          ? "These context controls belong to the support member who ran the lookup."
          : result.status === "stale"
            ? "The lookup cache changed after these results were created. Run the lookup again."
            : result.status === "invalid-context"
              ? "These context controls are not valid in this channel or plugin context."
              : "These context controls expired or are no longer valid. Run the lookup again for fresh results.";
      await interaction.reply({
        content,
        flags: MessageFlags.Ephemeral,
        allowedMentions: NO_MENTIONS,
      });
      return;
    }

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

    if (canonicalSubcommand === "health") {
      if (!hasRole(interaction.member, { roleIds: config.discord.adminRoleIds })) {
        await logEvent(interaction, {
          subcommand,
          outcome: "denied",
          reason: "health-role",
          detectedContext: context.pluginId || "unknown",
        });
        await interaction.reply({
          content: "Only the configured admin role can use the health command.",
          flags: MessageFlags.Ephemeral,
          allowedMentions: NO_MENTIONS,
        });
        return;
      }

      await logEvent(interaction, {
        subcommand,
        outcome: "success",
        detectedContext: context.pluginId || "unknown",
      });
      await interaction.reply({
        content: truncateDiscordMessage(
          formatHealthMessage({
            config,
            searchCache,
            versionService,
            client: dependencies.client ?? interaction.client,
            metrics,
            runtimeInfo: dependencies.runtimeInfo,
            serviceLogs: dependencies.serviceLogs,
            startupState: dependencies.startupState,
          }),
        ),
        flags: MessageFlags.Ephemeral,
        allowedMentions: NO_MENTIONS,
      });
      return;
    }

    if (canonicalSubcommand === "alerts-test") {
      if (!hasRole(interaction.member, { roleIds: config.discord.adminRoleIds })) {
        await logEvent(interaction, {
          subcommand,
          outcome: "denied",
          reason: "alerts-test-role",
          detectedContext: context.pluginId || "unknown",
        });
        await interaction.reply({
          content: "Only the configured admin role can use the alert test command.",
          flags: MessageFlags.Ephemeral,
          allowedMentions: NO_MENTIONS,
        });
        return;
      }

      const testCooldown = cooldowns.check(
        "global",
        "admin:alerts-test",
        config.security.debugCooldownSeconds ?? 30,
      );
      if (!testCooldown.allowed) {
        await logRateLimitEvent(interaction, "admin:alerts-test", {
          subcommand,
          outcome: "rejected",
          reason: `alerts-test-cooldown:${testCooldown.retryAfterSeconds}`,
          detectedContext: context.pluginId || "unknown",
        });
        await interaction.reply({
          content: `An alert test was just requested. Try again in ${testCooldown.retryAfterSeconds}s.`,
          flags: MessageFlags.Ephemeral,
          allowedMentions: NO_MENTIONS,
        });
        return;
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      let result;
      try {
        result =
          typeof dependencies.attentionMonitor?.sendTestAlert === "function"
            ? await dependencies.attentionMonitor.sendTestAlert()
            : { status: "unavailable" };
      } catch (error) {
        logger.warn("attention.test_command_failed", { errorName: error?.name || "Error" });
        result = { status: "error" };
      }

      await logEvent(interaction, {
        subcommand,
        outcome:
          result.status === "sent" ? "success" : result.status === "disabled" ? "rejected" : "error",
        reason: result.status === "sent" ? undefined : `alerts-test-${result.status}`,
        detectedContext: context.pluginId || "unknown",
      });
      const content =
        result.status === "sent"
          ? "Test alert delivered to the configured private admin alert channel."
          : result.status === "disabled"
            ? "Admin alerts are not configured, so no test message was sent."
            : "The test alert could not be delivered. Check the configured channel and the bot's permissions.";
      await interaction.editReply({ content, allowedMentions: NO_MENTIONS });
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
          content: "A cache reload is already in progress. Please wait for it to finish.",
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
          content: `The cache was reloaded recently. Try again in ${reloadCooldown.retryAfterSeconds}s.`,
          flags: MessageFlags.Ephemeral,
          allowedMentions: NO_MENTIONS,
        });
        return;
      }

      reloadInProgress = true;
      try {
        let reloadScope;
        try {
          reloadScope = resolveReloadScope(
            config,
            context.pluginId,
            interaction.options.getString?.("plugin") ?? "",
            interaction.options.getString?.("profile") ?? "",
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : "The requested reload scope is invalid.";
          await logEvent(interaction, {
            subcommand,
            outcome: "rejected",
            reason: "invalid-reload-scope",
            detectedContext: context.pluginId,
          });
          await interaction.reply({
            content: message,
            flags: MessageFlags.Ephemeral,
            allowedMentions: NO_MENTIONS,
          });
          return;
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        let reloadResult;
        const reloadStartedAt = monotonicNow();
        const reloadScopeType = reloadScope.pluginId
          ? reloadScope.profileName
            ? "profile"
            : "plugin"
          : "all";
        try {
          reloadResult = await reloadServicesAtomically(searchCache, versionService, reloadScope);
        } catch (error) {
          metrics?.recordReload({
            durationMs: monotonicNow() - reloadStartedAt,
            outcome: "error",
            scope: reloadScopeType,
          });
          const message = error instanceof Error ? error.message : "Unknown error";
          const requestId = requestMetadata.get(interaction)?.requestId ?? "untracked";
          await logEvent(interaction, {
            subcommand,
            outcome: "error",
            reason: message,
          });
          logger.error("cache.reload.failed", {
            requestId,
            scope: reloadScope.pluginId ? (reloadScope.profileName ? "profile" : "plugin") : "all",
            pluginId: reloadScope.pluginId ?? "all",
            profileName: reloadScope.profileName || "all",
            error,
          });
          await interaction.editReply({
            content: `The reload failed safely, so the existing cache and version snapshots remain active. Request ID: \`${requestId}\`.`,
            allowedMentions: NO_MENTIONS,
          });
          return;
        }

        const { summary, versionSnapshot, scope } = reloadResult;
        metrics?.recordReload({
          durationMs: monotonicNow() - reloadStartedAt,
          outcome: "success",
          scope: scope.type,
        });
        await logEvent(interaction, {
          subcommand,
          outcome: "success",
          reloadScope: scope.type,
          pluginId: scope.pluginId ?? "all",
          profileName: scope.profileName || "all",
          totalEntries: summary.totalEntries,
          totalFiles: summary.totalFiles,
        });
        logger.info("cache.reload.completed", {
          requestId: requestMetadata.get(interaction)?.requestId,
          scope: scope.type,
          pluginId: scope.pluginId ?? "all",
          profileName: scope.profileName || "all",
          totalEntries: summary.totalEntries,
          totalFiles: summary.totalFiles,
          versionChecksRefreshed: scope.type === "all",
          versionCheckErrors: versionSnapshot.errorCount ?? 0,
        });
        const scopeMessage =
          scope.type === "all"
            ? "Version catalog and upstream checks refreshed."
            : scope.type === "profile"
              ? `Only the ${config.plugins[scope.pluginId].label} ${scope.profileName} profile was refreshed; version data was left unchanged.`
              : `Only the ${config.plugins[scope.pluginId].label} context was refreshed; version data was left unchanged.`;
        const reloadMessages = splitDiscordMessages(
          `${formatReloadMessage(summary)}\n${scopeMessage}`,
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
        void dependencies.attentionMonitor?.checkNow();
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

    if (canonicalSubcommand === "categories") {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const summary = searchCache.getPluginSummary(context.plugin.id);
      await logEvent(interaction, {
        subcommand,
        outcome: "success",
        detectedContext: context.pluginId,
        categoryCount: summary?.profileSummaries?.length ?? 0,
      });
      await interaction.editReply({
        content: truncateDiscordMessage(formatIndexedCategoriesMessage(context.plugin, summary)),
        allowedMentions: NO_MENTIONS,
      });
      return;
    }

    if (canonicalSubcommand === "files") {
      const profileName = interaction.options.getString("profile") ?? "";
      if (profileName && !context.plugin.profiles[profileName]) {
        await logEvent(interaction, {
          subcommand,
          outcome: "rejected",
          reason: "invalid-file-profile",
          detectedContext: context.pluginId,
        });
        await interaction.reply({
          content: "That fixed cache profile is not available for the current plugin context.",
          flags: MessageFlags.Ephemeral,
          allowedMentions: NO_MENTIONS,
        });
        return;
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      try {
        const profileNames = profileName ? [profileName] : Object.keys(context.plugin.profiles);
        const entries = profileNames.flatMap((name) => searchCache.getEntries(context.plugin.id, name));
        const allowedRoots = [
          ...(context.plugin.debugRoots ?? []),
          ...(config.sharedDebugRoots ?? []).flatMap((root) => root.directories ?? []),
        ];
        const listing = listSafeIndexedFiles(entries, { allowedRoots });
        const messages = splitDiscordMessages(
          formatIndexedFilesMessage(context.plugin, listing, profileName),
        );
        await logEvent(interaction, {
          subcommand,
          outcome: "success",
          detectedContext: context.pluginId,
          profileName: profileName || "all",
          visibleFileCount: listing.totalFileCount,
          rejectedEntryCount: listing.rejectedCount,
        });
        await interaction.editReply({
          content: messages[0],
          allowedMentions: NO_MENTIONS,
        });
        for (const message of messages.slice(1)) {
          await interaction.followUp({
            content: message,
            flags: MessageFlags.Ephemeral,
            allowedMentions: NO_MENTIONS,
          });
        }
      } catch {
        await logEvent(interaction, {
          subcommand,
          outcome: "error",
          reason: "file-browser-unavailable",
          detectedContext: context.pluginId,
        });
        await interaction.editReply({
          content: "The safe indexed-file list is temporarily unavailable.",
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
      metrics,
      runtimeInfo: dependencies.runtimeInfo,
      pagination,
      resolveRelatedReferences({ context: relatedContext, ...options }) {
        return getRelatedReferenceIndex(relatedContext).find(options);
      },
    });
  }

  function getSubcommandSafely(interaction) {
    try {
      return interaction.options?.getSubcommand?.(false) || "unknown";
    } catch {
      return "unknown";
    }
  }

  async function handleInteractionWithTelemetry(interaction) {
    if (interaction.isAutocomplete?.()) {
      await handleInteraction(interaction);
      return;
    }

    if (pagination.isPaginationButton(interaction) || pagination.isContextSelect(interaction)) {
      await handleInteraction(interaction);
      return;
    }
    if (!interaction.isChatInputCommand() || !SUPPORTED_COMMAND_NAMES.has(interaction.commandName)) {
      return;
    }

    const metadata = {
      requestId: createRequestId(),
      startedAt: monotonicNow(),
      subcommand: getSubcommandSafely(interaction),
      outcome: "completed",
    };
    requestMetadata.set(interaction, metadata);
    logger.info("discord.command.started", {
      requestId: metadata.requestId,
      commandName: interaction.commandName,
      subcommand: metadata.subcommand,
    });

    try {
      if (typeof logger.withContext === "function") {
        await logger.withContext({ requestId: metadata.requestId }, () => handleInteraction(interaction));
      } else {
        await handleInteraction(interaction);
      }
    } catch (error) {
      metadata.outcome = "unexpected-error";
      throw error;
    } finally {
      const durationMs = Math.max(0, Math.round(monotonicNow() - metadata.startedAt));
      metrics?.recordCommand({ durationMs, outcome: metadata.outcome });
      logger.info("discord.command.completed", {
        requestId: metadata.requestId,
        commandName: interaction.commandName,
        subcommand: metadata.subcommand,
        outcome: metadata.outcome,
        durationMs,
      });
    }
  }

  return createSafeInteractionListener(
    handleInteractionWithTelemetry,
    (interaction, error) =>
      reportUnexpectedInteractionError(interaction, error, logEvent, {
        logger,
        requestId: requestMetadata.get(interaction)?.requestId,
      }),
    logger,
  );
}
