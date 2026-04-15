import "dotenv/config";
import { createSearchCache, formatCacheSummary } from "./cache.js";
import { loadConfig } from "./config.js";
import { buildLanguageCategoryStats, formatLanguageCategoryStats } from "./langStats.js";
import { loadEntriesForProfile } from "./profileIndex.js";
import { AiReranker, lexicalSearch, orderMatchesForDisplay } from "./search.js";
import { resolveFileFilter } from "./security.js";
import { findRelatedEntries, makeDisplayContext } from "./yamlIndex.js";

async function main() {
  const config = loadConfig();
  const args = process.argv.slice(2);
  const rawSubcommand = args.shift();
  const subcommand =
    rawSubcommand === "lang"
      ? "language"
      : rawSubcommand === "cmd"
        ? "command"
        : rawSubcommand === "perm"
          ? "permission"
          : rawSubcommand;

  if (subcommand === "stats") {
    const searchCache = createSearchCache(config);
    const summary = await searchCache.warm();
    console.log(formatCacheSummary(summary));
    return;
  }

  if (subcommand === "langstats") {
    const categories = await buildLanguageCategoryStats(config.workspaceRoot, config.search.profiles.language.include);
    const statsBlock = formatLanguageCategoryStats(categories, config.formatDisplayPath);
    if (!statsBlock) {
      console.log("No language category stats are available right now.");
      return;
    }

    console.log(statsBlock);
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

  if (!subcommand || !config.search.profiles[subcommand]) {
    console.error(
      "Usage: npm run lookup -- <config|language|lang|placeholder|material|command|cmd|permission|perm|faq|tabcomplete|langstats|stats> [--mode exact|whole|broad] [--file Chat.yml] [--related] [--summary] <keyword>",
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

  const allEntries = await loadEntriesForProfile(config.search.profiles[subcommand], config.workspaceRoot);
  const fileFilter = resolveFileFilter(file, allEntries, {
    profileLabel: subcommand === "config" ? "config" : subcommand,
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
  const profile = config.search.profiles[subcommand];
  const visibleLimit = profile.defaultResultLimit ?? config.search.defaultResultLimit;

  if (!matches.length) {
    const entryLabel = profile.entryLabel ?? "entries";
    console.log(`No ${entryLabel} matched "${keyword}" in profile "${subcommand}".`);
    return;
  }

  for (const item of matches.slice(0, visibleLimit)) {
    const result = makeDisplayContext(item.entry, config.formatDisplayPath);
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
      (await reranker.summarize(keyword, matches.slice(0, visibleLimit), { profileName: subcommand })) ||
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
