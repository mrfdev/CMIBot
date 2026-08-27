import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  expandSearchQueries,
  loadSearchSynonyms,
  parseSearchSynonymDocument,
} from "../src/searchSynonyms.js";

test("synonym documents normalize aliases and keep plugin scopes separate", () => {
  const synonyms = parseSearchSynonymDocument({
    schemaVersion: 1,
    plugins: {
      cmi: {
        TP: ["Teleport", "Teleportation"],
      },
      jobs: {
        xp: ["Experience Points"],
      },
    },
  });

  assert.deepEqual(synonyms.cmi.tp, ["teleport", "teleportation"]);
  assert.deepEqual(synonyms.jobs.xp, ["experience points"]);
  assert.equal(synonyms.jobs.tp, undefined);
});

test("synonym documents reject ambiguous, recursive, and unsafe terms", () => {
  assert.throws(
    () =>
      parseSearchSynonymDocument({
        schemaVersion: 1,
        plugins: {
          cmi: {
            TP: ["teleport"],
            tp: ["teleportation"],
          },
        },
      }),
    /normalize to the same term/i,
  );

  assert.throws(
    () =>
      parseSearchSynonymDocument({
        schemaVersion: 1,
        plugins: {
          cmi: {
            tp: ["tp"],
          },
        },
      }),
    /cannot expand to itself/i,
  );

  assert.throws(
    () =>
      parseSearchSynonymDocument({
        schemaVersion: 1,
        plugins: {
          cmi: {
            tp: ["../../private"],
          },
        },
      }),
    /only letters, numbers/i,
  );
});

test("query expansion supports phrases and token combinations without recursion", () => {
  const variants = expandSearchQueries("tp xp", {
    tp: ["teleport"],
    xp: ["experience", "experience points"],
    teleport: ["warp"],
  });

  assert.deepEqual(variants, [
    "tp xp",
    "tp experience",
    "tp experience points",
    "teleport xp",
    "teleport experience",
    "teleport experience points",
  ]);
  assert.equal(variants.includes("warp xp"), false);
});

test("special placeholder tokens are never synonym-expanded", () => {
  assert.deepEqual(expandSearchQueries("%player_name%", { player_name: ["player"] }), ["%player_name%"]);
});

test("object prototype names are not treated as configured aliases", () => {
  assert.deepEqual(expandSearchQueries("constructor", {}), ["constructor"]);
  assert.deepEqual(expandSearchQueries("toString", {}), ["toString"]);
});

test("synonym file paths reject traversal without disclosing the attempted target", () => {
  assert.throws(
    () => loadSearchSynonyms(process.cwd(), "../sensitive.txt"),
    (error) => {
      assert.match(error.message, /safe project-relative JSON file/i);
      assert.doesNotMatch(error.message, /sensitive\.txt/);
      return true;
    },
  );
});

test("the tracked synonym file loads through the safe file boundary", () => {
  const synonyms = loadSearchSynonyms(process.cwd(), "data/search-synonyms.json");

  assert.deepEqual(synonyms.cmi.tp, ["teleport", "teleportation"]);
  assert.equal(synonyms.jobs.tp, undefined);
});

test("symlinked synonym files fail closed", (context) => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cmibot-synonyms-"));
  context.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(temporaryRoot, "source.json"),
    JSON.stringify({ schemaVersion: 1, plugins: {} }),
  );
  fs.symlinkSync("source.json", path.join(temporaryRoot, "linked.json"));

  assert.throws(() => loadSearchSynonyms(temporaryRoot, "linked.json"), /could not be read safely/i);
});
