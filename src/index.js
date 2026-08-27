import "dotenv/config";
import { Client, GatewayIntentBits } from "discord.js";
import { createSearchCache } from "./cache.js";
import { loadConfig, validateBotConfig } from "./config.js";
import { createInteractionHandler, registerCommands } from "./discordBot.js";
import { serviceLogger } from "./logger.js";
import { installGracefulShutdown } from "./processLifecycle.js";
import { createRuntimeInfo } from "./runtimeInfo.js";
import { validateStartupState } from "./startupValidation.js";
import { createVersionService } from "./versionCatalog.js";

const activeResources = {
  client: null,
  versionService: null,
};
let stopPromise = null;

async function stopLookupBot() {
  if (stopPromise) {
    return stopPromise;
  }

  stopPromise = (async () => {
    activeResources.versionService?.stop();
    activeResources.client?.destroy();
    await activeResources.versionService?.flushPersistence();
  })();
  return stopPromise;
}

async function main() {
  const config = loadConfig();
  validateBotConfig(config);
  const runtimeInfo = await createRuntimeInfo(config.workspaceRoot);
  const searchCache = createSearchCache(config);
  const warmSummary = await searchCache.warm();
  serviceLogger.info("cache.startup_loaded", {
    totalEntries: warmSummary.totalEntries,
    totalFiles: warmSummary.totalFiles,
    pluginCount: warmSummary.pluginSummaries.length,
  });
  const versionService = createVersionService(config, { logger: serviceLogger });
  activeResources.versionService = versionService;
  const versionSnapshot = await versionService.start();
  serviceLogger.info("versions.startup_loaded", {
    resourceCount:
      (versionSnapshot.catalog?.plugins.length ?? 0) +
      (versionSnapshot.catalog?.companions.length ?? 0) +
      (versionSnapshot.catalog?.paper ? 1 : 0),
    checkedAt: versionSnapshot.checkedAt,
    errorCount: versionSnapshot.errorCount,
    retainedCount: versionSnapshot.retainedCount,
    checkEnabled: versionSnapshot.checkEnabled,
  });
  const startupState = validateStartupState(config, warmSummary, versionSnapshot);
  serviceLogger.info("startup.validation_passed", {
    release: runtimeInfo.release,
    pluginCount: startupState.pluginCount,
    profileCount: startupState.profileCount,
  });
  await registerCommands(config);

  const client = new Client({
    intents: [GatewayIntentBits.Guilds],
  });
  activeResources.client = client;

  client.once("clientReady", () => {
    serviceLogger.info("discord.connected", { ready: true });
  });

  client.on("error", (error) => {
    serviceLogger.error("discord.client_error", { error });
  });

  client.on("shardError", (error) => {
    serviceLogger.error("discord.shard_error", { error });
  });

  client.on(
    "interactionCreate",
    createInteractionHandler(config, searchCache, versionService, {
      client,
      runtimeInfo,
      startupState,
    }),
  );

  await client.login(config.discord.token);
}

installGracefulShutdown({
  stop: stopLookupBot,
  log(message) {
    serviceLogger.info("process.lifecycle", { message });
  },
  logError(message, error) {
    serviceLogger.error("process.lifecycle_failed", { message, error });
  },
});

main().catch((error) => {
  serviceLogger.error("startup.failed", { error });
  void stopLookupBot()
    .catch((shutdownError) => {
      serviceLogger.error("startup.cleanup_failed", { error: shutdownError });
    })
    .finally(() => {
      process.exitCode = 1;
    });
});
