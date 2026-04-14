import "dotenv/config";
import { loadConfig } from "./config.js";
import { AiReranker, lexicalSearch, orderMatchesForDisplay } from "./search.js";
import { findRelatedEntries, loadEntriesForProfile, makeDisplayContext } from "./yamlIndex.js";

async function main() {
  const config = loadConfig();
  const args = process.argv.slice(2);
  const subcommand = args.shift();
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
    console.error("Usage: npm run lookup -- <lookup|langlookup> [--mode exact|broad] [--related] [--summary] <keyword>");
    process.exitCode = 1;
    return;
  }

  if (!keyword) {
    console.error("Provide a keyword to search for.");
    process.exitCode = 1;
    return;
  }

  if (!["exact", "broad"].includes(mode)) {
    console.error('Mode must be "exact" or "broad".');
    process.exitCode = 1;
    return;
  }

  const entries = await loadEntriesForProfile(config.search.profiles[subcommand], config.workspaceRoot);
  const lexicalMatches = lexicalSearch(keyword, entries, { limit: 25, mode });
  const reranker = new AiReranker(config.openai);
  const rerankedMatches = await reranker.rerank(keyword, lexicalMatches);
  const matches = orderMatchesForDisplay(rerankedMatches);

  if (!matches.length) {
    console.log(`No YAML entries matched "${keyword}" in profile "${subcommand}".`);
    return;
  }

  for (const item of matches.slice(0, config.search.defaultResultLimit)) {
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
      (await reranker.summarize(keyword, matches.slice(0, config.search.defaultResultLimit), { profileName: subcommand })) ||
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
