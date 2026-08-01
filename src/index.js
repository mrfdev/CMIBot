import "dotenv/config";
import { Client, GatewayIntentBits } from "discord.js";
import { createSearchCache, formatCacheSummary } from "./cache.js";
import { loadConfig, validateBotConfig } from "./config.js";
import { createInteractionHandler, registerCommands } from "./discordBot.js";
import { createVersionService, formatVersionServiceSummary } from "./versionCatalog.js";

async function main() {
  const config = loadConfig();
  validateBotConfig(config);
  const searchCache = createSearchCache(config);
  const warmSummary = await searchCache.warm();
  console.log(formatCacheSummary(warmSummary, { verb: "Loaded", suffix: " into the search cache." }));
  const versionService = createVersionService(config);
  const versionSnapshot = await versionService.start();
  console.log(formatVersionServiceSummary(versionSnapshot));
  await registerCommands(config);

  const client = new Client({
    intents: [GatewayIntentBits.Guilds],
  });

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

main().catch((error) => {
  console.error("Failed to start LookupBot.");
  console.error(error);
  process.exitCode = 1;
});
