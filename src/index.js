import "dotenv/config";
import { Client, GatewayIntentBits } from "discord.js";
import { createSearchCache, formatCacheSummary } from "./cache.js";
import { loadConfig, validateBotConfig } from "./config.js";
import { createInteractionHandler, registerCommands } from "./discordBot.js";

async function main() {
  const config = loadConfig();
  validateBotConfig(config);
  const searchCache = createSearchCache(config);
  const warmSummary = await searchCache.warm();
  console.log(formatCacheSummary(warmSummary, { verb: "Loaded", suffix: " into the search cache." }));
  await registerCommands(config);

  const client = new Client({
    intents: [GatewayIntentBits.Guilds],
  });

  client.once("clientReady", () => {
    console.log(`CMIBot connected as ${client.user?.tag ?? "unknown-user"}.`);
  });

  client.on("interactionCreate", createInteractionHandler(config, searchCache));

  await client.login(config.discord.token);
}

main().catch((error) => {
  console.error("Failed to start CMIBot.");
  console.error(error);
  process.exitCode = 1;
});
