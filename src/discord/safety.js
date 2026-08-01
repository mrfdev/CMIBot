import { MessageFlags } from "discord.js";
import { NO_MENTIONS } from "./constants.js";

const UNEXPECTED_ERROR_MESSAGE =
  "The bot could not complete this command because of an unexpected error. The failure was logged and the bot is still running.";

function getErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

export function createSafeInteractionListener(handleInteraction, handleError) {
  return function handleInteractionSafely(interaction) {
    return Promise.resolve()
      .then(() => handleInteraction(interaction))
      .catch(async (error) => {
        try {
          await handleError(interaction, error);
        } catch (recoveryError) {
          console.error("[LookupBot] Interaction error recovery also failed.", recoveryError);
        }
      });
  };
}

export async function reloadServicesAtomically(searchCache, versionService) {
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
  return { summary, versionSnapshot };
}

export async function reportUnexpectedInteractionError(interaction, error, logEvent) {
  const errorMessage = getErrorMessage(error);
  const commandName = interaction.commandName || "unknown-command";
  const channelId = interaction.channelId || "unknown-channel";
  const userId = interaction.user?.id || "unknown-user";

  console.error(
    `[LookupBot] Unexpected interaction error for /${commandName} in channel ${channelId} from user ${userId}.`,
    error,
  );

  try {
    await logEvent(interaction, {
      subcommand: "unknown",
      outcome: "unexpected-error",
      reason: errorMessage.slice(0, 1000),
    });
  } catch (auditError) {
    console.error("[LookupBot] Failed to audit an unexpected interaction error.", auditError);
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
    console.error(
      `[LookupBot] Could not send the fallback response for /${commandName} in channel ${channelId}.`,
      responseError,
    );
  }
}
