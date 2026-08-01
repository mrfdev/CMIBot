import assert from "node:assert/strict";
import test from "node:test";
import { extractEntriesFromTokenListText } from "../src/logIndex.js";
import { lexicalSearchWithStats } from "../src/search.js";
import { extractEntriesFromText } from "../src/yamlIndex.js";

test("log source paths do not count as material matches", () => {
  const entries = extractEntriesFromTokenListText(
    ["STICK", "STONE_BRICKS", "OAK_LOG", "STRIPPED_OAK_LOG"].join("\n"),
    "CMIPlugin/data/materials.log",
  );

  const result = lexicalSearchWithStats("log", entries, { limit: 25 });

  assert.equal(entries[0].searchText.includes("materials.log"), false);
  assert.equal(result.totalMatches, 2);
  assert.deepEqual(result.matches.map((item) => item.entry.key), ["OAK_LOG", "STRIPPED_OAK_LOG"]);
});

test("YAML source filenames do not count as configuration matches", () => {
  const entries = extractEntriesFromText(
    ["UsePaperType: true", "Enabled: false"].join("\n"),
    "CMIPlugin/CMI/Settings/Chat.yml",
  );

  const result = lexicalSearchWithStats("chat", entries, { limit: 25 });

  assert.equal(entries[0].searchText.includes("chat.yml"), false);
  assert.equal(result.totalMatches, 0);
  assert.deepEqual(result.matches, []);
});

test("real YAML key paths remain searchable", () => {
  const entries = extractEntriesFromText(["Chat:", "  UsePaperType: true"].join("\n"), "config.yml");

  const result = lexicalSearchWithStats("chat", entries, { limit: 25 });

  assert.equal(result.totalMatches, 2);
  assert.deepEqual(result.matches.map((item) => item.entry.yamlPath), ["Chat", "Chat.UsePaperType"]);
});

test("match totals and files are calculated before the candidate limit", () => {
  const firstFileEntries = extractEntriesFromTokenListText(
    Array.from({ length: 20 }, (_, index) => `OAK_LOG_${index + 1}`).join("\n"),
    "CMIPlugin/data/materials.log",
  );
  const secondFileEntries = extractEntriesFromTokenListText(
    Array.from({ length: 10 }, (_, index) => `BIRCH_LOG_${index + 1}`).join("\n"),
    "CMIPlugin/data/extra-materials.log",
  );

  const result = lexicalSearchWithStats("log", [...firstFileEntries, ...secondFileEntries], { limit: 5 });

  assert.equal(result.matches.length, 5);
  assert.equal(result.totalMatches, 30);
  assert.deepEqual(
    [...result.matchedFiles].sort(),
    ["CMIPlugin/data/materials.log", "CMIPlugin/data/extra-materials.log"].sort(),
  );
});
