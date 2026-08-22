import "dotenv/config";
import { Client, GatewayIntentBits } from "discord.js";
import { createSearchCache, formatCacheSummary } from "./cache.js";
import { loadConfig, validateBotConfig } from "./config.js";
import { createInteractionHandler, registerCommands } from "./discordBot.js";
import { installGracefulShutdown } from "./processLifecycle.js";
import { createVersionService, formatVersionServiceSummary } from "./versionCatalog.js";

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
  const searchCache = createSearchCache(config);
  const warmSummary = await searchCache.warm();
  console.log(formatCacheSummary(warmSummary, { verb: "Loaded", suffix: " into the search cache." }));
  const versionService = createVersionService(config);
  activeResources.versionService = versionService;
  const versionSnapshot = await versionService.start();
  console.log(formatVersionServiceSummary(versionSnapshot));
  await registerCommands(config);

  const client = new Client({
    intents: [GatewayIntentBits.Guilds],
  });
  activeResources.client = client;

  client.once("clientReady", () => {
    console.log(`LookupBot connected as ${client.user?.tag ?? "unknown-user"}.`);
  });

  client.on("error", (error) => {
    console.error("[LookupBot] Discord client error.", error);
  });

  client.on("shardError", (error) => {
    console.error("[LookupBot] Discord shard error.", error);
  });

  client.on("interactionCreate", createInteractionHandler(config, searchCache, versionService));

  await client.login(config.discord.token);
}

installGracefulShutdown({ stop: stopLookupBot });

main().catch((error) => {
  console.error("Failed to start LookupBot.");
  console.error(error);
  void stopLookupBot()
    .catch((shutdownError) => {
      console.error("Failed to clean up LookupBot after its startup error.");
      console.error(shutdownError);
    })
    .finally(() => {
      process.exitCode = 1;
    });
});
