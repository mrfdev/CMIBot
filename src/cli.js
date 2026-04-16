import "dotenv/config";
import { createSearchCache, formatCacheSummary } from "./cache.js";
import { loadConfig } from "./config.js";
import { formatLanguageCategoryStats } from "./langStats.js";
import { AiReranker, lexicalSearch, orderMatchesForDisplay } from "./search.js";
import { resolveFileFilter } from "./security.js";
import { findRelatedEntries, makeDisplayContext } from "./yamlIndex.js";

async function main() {
  const config = loadConfig();
  const args = process.argv.slice(2);
  const requestedPlugin = args[0] && config.plugins[args[0]] ? args.shift() : "cmi";
  const plugin = config.plugins[requestedPlugin];
  const rawSubcommand = args.shift();
  const subcommand = rawSubcommand === "lang" ? "language" : rawSubcommand === "cmd" ? "command" : rawSubcommand === "perm" ? "permission" : rawSubcommand;
  const searchCache = createSearchCache(config);
  await searchCache.warm();

  if (subcommand === "stats") {
    const summary = searchCache.getPluginSummary(plugin.id) ?? {
      pluginId: plugin.id,
      pluginLabel: plugin.label,
      totalEntries: 0,
      totalFiles: 0,
      profileSummaries: [],
    };
    console.log(`Current context: ${plugin.label}`);
    console.log(formatCacheSummary(summary));
    return;
  }

  if (subcommand === "langstats") {
    const snapshot = searchCache.getSnapshot(plugin.id, "language");
    const categories = snapshot?.languageCategories ?? [];
    if (!categories.length) {
      console.log(`Language stats are still being worked on for ${plugin.label}.`);
      return;
    }
    console.log(`Current context: ${plugin.label}`);
    console.log(formatLanguageCategoryStats(categories, config.formatDisplayPath, plugin.id));
    return;
  }

  let mode = "exact";
  let related = false;
  let summary = false;
  let file = "";

  while (args.length > 0) {
    if (args[0] === "--mode") {
      mode = args[1] ?? mode;
      args.splice(0, 2);
      continue;
    }

    if (args[0] === "--file") {
      file = args[1] ?? file;
      args.splice(0, 2);
      continue;
    }

    if (args[0] === "--related") {
      related = true;
      args.splice(0, 1);
      continue;
    }

    if (args[0] === "--summary") {
      summary = true;
      args.splice(0, 1);
      continue;
    }

    break;
  }

  const keyword = args.join(" ").trim();

  if (!subcommand || !plugin.profiles[subcommand]) {
    const pluginList = Object.keys(config.plugins).join("|");
    console.error(
      `Usage: npm run lookup -- [${pluginList}] <config|language|lang|placeholder|material|command|cmd|permission|perm|faq|tabcomplete|langstats|stats> [--mode exact|whole|broad] [--file Chat.yml] [--related] [--summary] <keyword>`,
    );
    process.exitCode = 1;
    return;
  }

  if (!keyword) {
    console.error("Provide a keyword to search for.");
    process.exitCode = 1;
    return;
  }

  if (!["exact", "whole", "broad"].includes(mode)) {
    console.error('Mode must be "exact", "whole", or "broad".');
    process.exitCode = 1;
    return;
  }

  const allEntries = searchCache.getEntries(plugin.id, subcommand);
  const fileFilter = resolveFileFilter(file, allEntries, {
    profileLabel: subcommand === "config" ? `${plugin.label} config` : `${plugin.label} ${subcommand}`,
  });

  if (!fileFilter.ok) {
    console.error(fileFilter.reason);
    process.exitCode = 1;
    return;
  }

  const entries = fileFilter.filteredEntries;
  const lexicalMatches = lexicalSearch(keyword, entries, { limit: 25, mode });
  const reranker = new AiReranker(config.openai);
  const rerankedMatches = await reranker.rerank(keyword, lexicalMatches);
  const matches = orderMatchesForDisplay(rerankedMatches);
  const profile = plugin.profiles[subcommand];
  const visibleLimit = profile.defaultResultLimit ?? config.search.defaultResultLimit;

  if (!matches.length) {
    const entryLabel = profile.entryLabel ?? "entries";
    console.log(`No ${entryLabel} matched "${keyword}" in profile "${subcommand}".`);
    return;
  }

  for (const item of matches.slice(0, visibleLimit)) {
    const result = makeDisplayContext(item.entry, plugin.id, config.formatDisplayPath);
    console.log(`${result.displayPath}:${result.lineNumber}`);
    if (related) {
      const relatedEntries = findRelatedEntries(item.entry, entries);
      if (relatedEntries.length) {
        console.log(
          `Related: ${relatedEntries.map((entry) => `${entry.yamlPath} (line ${entry.lineNumber})`).join(", ")}`,
        );
      }
    }
    console.log(result.snippet);
    console.log("");
  }

  if (summary) {
    const aiSummary =
      (await reranker.summarize(keyword, matches.slice(0, visibleLimit), { profileName: `${plugin.id}:${subcommand}` })) ||
      "";
    if (aiSummary) {
      console.log(`AI summary (generated): ${aiSummary}`);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
