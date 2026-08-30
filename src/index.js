import "./loadEnvironment.js";
import { performance } from "node:perf_hooks";
import { Client, GatewayIntentBits } from "discord.js";
import { createAttentionMonitor } from "./attentionMonitor.js";
import { createSearchCache } from "./cache.js";
import { loadConfig, validateBotConfig } from "./config.js";
import { createInteractionHandler, registerCommands } from "./discordBot.js";
import { serviceLogger } from "./logger.js";
import { createMetricsRegistry } from "./metrics.js";
import { installGracefulShutdown } from "./processLifecycle.js";
import { createRuntimeInfo } from "./runtimeInfo.js";
import { getActiveServiceLogManager } from "./serviceLog.js";
import { validateStartupState } from "./startupValidation.js";
import { createVersionService } from "./versionCatalog.js";

const activeResources = {
  attentionMonitor: null,
  client: null,
  metrics: null,
  serviceLogs: null,
  versionService: null,
};
let stopPromise = null;

async function stopLookupBot() {
  if (stopPromise) {
    return stopPromise;
  }

  stopPromise = (async () => {
    activeResources.attentionMonitor?.stop();
    activeResources.versionService?.stop();
    activeResources.metrics?.stop();
    activeResources.client?.destroy();
    await activeResources.versionService?.flushPersistence();
  })();
  return stopPromise;
}

async function main() {
  const serviceLogs = getActiveServiceLogManager();
  if (serviceLogs) {
    activeResources.serviceLogs = serviceLogs;
    serviceLogger.configure({ stdout: serviceLogs.stdout, stderr: serviceLogs.stderr });
  }
  const config = loadConfig();
  const metrics = createMetricsRegistry();
  activeResources.serviceLogs = serviceLogs;
  activeResources.metrics = metrics;
  serviceLogger.configure({
    ...(serviceLogs ? { stdout: serviceLogs.stdout, stderr: serviceLogs.stderr } : {}),
    observer: (record) => metrics.observeLogRecord(record),
  });
  validateBotConfig(config);
  metrics.start(serviceLogger, config.metrics.logIntervalMs);
  const runtimeInfo = await createRuntimeInfo(config.workspaceRoot);
  const searchCache = createSearchCache(config);
  const warmStartedAt = performance.now();
  let warmSummary;
  try {
    warmSummary = await searchCache.warm();
    metrics.recordReload({
      durationMs: performance.now() - warmStartedAt,
      outcome: "success",
      scope: "startup",
    });
  } catch (error) {
    metrics.recordReload({
      durationMs: performance.now() - warmStartedAt,
      outcome: "error",
      scope: "startup",
    });
    throw error;
  }
  serviceLogger.info("cache.startup_loaded", {
    totalEntries: warmSummary.totalEntries,
    totalFiles: warmSummary.totalFiles,
    pluginCount: warmSummary.pluginSummaries.length,
    derivedIndexHits: warmSummary.derivedIndexActivity?.hits ?? 0,
    derivedIndexRebuilds: warmSummary.derivedIndexActivity?.rebuilds ?? 0,
    derivedIndexWriteFailures: warmSummary.derivedIndexActivity?.writeFailures ?? 0,
  });
  const versionService = createVersionService(config, { logger: serviceLogger, metrics });
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
  const attentionMonitor = createAttentionMonitor(config, versionService, {
    client,
    logger: serviceLogger,
  });
  activeResources.attentionMonitor = attentionMonitor;

  client.once("clientReady", () => {
    serviceLogger.info("discord.connected", { ready: true });
    attentionMonitor.start();
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
      metrics,
      runtimeInfo,
      serviceLogs,
      startupState,
      attentionMonitor,
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
