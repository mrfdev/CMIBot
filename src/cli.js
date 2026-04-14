import "dotenv/config";
import { loadConfig } from "./config.js";
import { buildLanguageCategoryStats, formatLanguageCategoryStats } from "./langStats.js";
import { loadEntriesForProfile } from "./profileIndex.js";
import { AiReranker, lexicalSearch, orderMatchesForDisplay } from "./search.js";
import { findRelatedEntries, makeDisplayContext } from "./yamlIndex.js";

async function main() {
  const config = loadConfig();
  const args = process.argv.slice(2);
  const subcommand = args.shift();

  if (subcommand === "langstats") {
    const categories = await buildLanguageCategoryStats(config.workspaceRoot, config.search.profiles.langlookup.include);
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

  if (args[0] === "--mode") {
    mode = args[1] ?? mode;
    args.splice(0, 2);
  }

  if (args[0] === "--related") {
    related = true;
    args.splice(0, 1);
  }

  if (args[0] === "--summary") {
    summary = true;
    args.splice(0, 1);
  }

  const keyword = args.join(" ").trim();

  if (!subcommand || !config.search.profiles[subcommand]) {
    console.error(
      "Usage: npm run lookup -- <lookup|langlookup|placeholder|material|command|permission|tabcomplete|langstats> [--mode exact|whole|broad] [--related] [--summary] <keyword>",
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

  const entries = await loadEntriesForProfile(config.search.profiles[subcommand], config.workspaceRoot);
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
