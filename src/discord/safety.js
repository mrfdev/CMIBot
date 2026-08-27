import { MessageFlags } from "discord.js";
import { serviceLogger } from "../logger.js";
import { NO_MENTIONS } from "./constants.js";

const UNEXPECTED_ERROR_MESSAGE =
  "The bot could not complete this command because of an unexpected error. The failure was logged and the bot is still running.";

function getErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

export function createSafeInteractionListener(handleInteraction, handleError, logger = serviceLogger) {
  return function handleInteractionSafely(interaction) {
    return Promise.resolve()
      .then(() => handleInteraction(interaction))
      .catch(async (error) => {
        try {
          await handleError(interaction, error);
        } catch (recoveryError) {
          logger.error("discord.command.recovery_failed", { error: recoveryError });
        }
      });
  };
}

export function resolveReloadScope(config, currentPluginId, pluginOption = "", profileOption = "") {
  if (!pluginOption && !profileOption) {
    return {};
  }

  const pluginId = !pluginOption || pluginOption === "current" ? currentPluginId : pluginOption;
  const plugin = config.plugins[pluginId];
  if (!plugin) {
    throw new Error("The requested plugin reload scope is not configured.");
  }
  if (profileOption && !plugin.profiles?.[profileOption]) {
    throw new Error(`${plugin.label} does not provide the requested profile.`);
  }

  return {
    pluginId,
    profileName: profileOption,
  };
}

export async function reloadServicesAtomically(searchCache, versionService, scope = {}) {
  if (scope.pluginId) {
    const cacheTransaction = await searchCache.prepareReload(scope);
    return {
      summary: cacheTransaction.commit(),
      versionSnapshot: versionService.getSnapshot(),
      scope: cacheTransaction.scope,
    };
  }

  const [cacheResult, versionResult] = await Promise.allSettled([
    searchCache.prepareReload(),
    versionService.prepareReload(),
  ]);
  const failures = [];

  if (cacheResult.status === "rejected") {
    failures.push(`search cache: ${getErrorMessage(cacheResult.reason)}`);
  }
  if (versionResult.status === "rejected") {
    failures.push(`version catalog: ${getErrorMessage(versionResult.reason)}`);
  }

  if (failures.length) {
    if (cacheResult.status === "fulfilled") {
      cacheResult.value.discard();
    }
    if (versionResult.status === "fulfilled") {
      versionResult.value.discard();
    }
    throw new Error(`Reload preparation failed (${failures.join("; ")}).`);
  }

  const summary = cacheResult.value.commit();
  const versionSnapshot = versionResult.value.commit();
  return { summary, versionSnapshot, scope: cacheResult.value.scope ?? { type: "all" } };
}

export async function reportUnexpectedInteractionError(
  interaction,
  error,
  logEvent,
  { logger = serviceLogger, requestId = "untracked" } = {},
) {
  const errorMessage = getErrorMessage(error);
  const commandName = interaction.commandName || "unknown-command";
  logger.error("discord.command.unexpected_error", {
    requestId,
    commandName,
    error,
  });

  try {
    await logEvent(interaction, {
      subcommand: "unknown",
      outcome: "unexpected-error",
      reason: errorMessage.slice(0, 1000),
    });
  } catch (auditError) {
    logger.error("discord.command.audit_failed", {
      requestId,
      commandName,
      error: auditError,
    });
  }

  if (typeof interaction.isRepliable === "function" && !interaction.isRepliable()) {
    return;
  }

  try {
    if (interaction.replied) {
      await interaction.followUp({
        content: UNEXPECTED_ERROR_MESSAGE,
        flags: MessageFlags.Ephemeral,
        allowedMentions: NO_MENTIONS,
      });
      return;
    }

    if (interaction.deferred) {
      await interaction.editReply({
        content: UNEXPECTED_ERROR_MESSAGE,
        allowedMentions: NO_MENTIONS,
      });
      return;
    }

    await interaction.reply({
      content: UNEXPECTED_ERROR_MESSAGE,
      flags: MessageFlags.Ephemeral,
      allowedMentions: NO_MENTIONS,
    });
  } catch (responseError) {
    logger.error("discord.command.fallback_failed", {
      requestId,
      commandName,
      error: responseError,
    });
  }
}
