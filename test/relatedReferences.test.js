import assert from "node:assert/strict";
import test from "node:test";
import {
  extractEntriesFromCommentLogText,
  extractEntriesFromDelimitedText,
  extractEntriesFromPermissionListText,
} from "../src/logIndex.js";
import { createRelatedReferenceIndex } from "../src/relatedReferences.js";
import { extractEntriesFromText } from "../src/yamlIndex.js";

function makeFixture() {
  const command = extractEntriesFromDelimitedText(
    [
      "/cmi balance (playerName) - Check money balance",
      "/cmi heal [playerName] - Heal a player",
    ].join("\n"),
    "CMIPlugin/data/commands.log",
  );
  const permission = extractEntriesFromPermissionListText(
    [
      "cmi.command.balance - Check money balance",
      "cmi.command.balance.others - Check another player's balance",
      "cmi.command.heal - Heal a player",
    ].join("\n"),
    "CMIPlugin/data/permissions.log",
  );
  const config = extractEntriesFromText(
    [
      "Economy:",
      "  BalanceFormat: '#,##0.00'",
      "  StartingMoney: 100",
      "Healing:",
      "  Enabled: true",
    ].join("\n"),
    "CMIPlugin/CMI/config.yml",
  );
  const placeholder = extractEntriesFromCommentLogText(
    [
      "# Formatted users balance",
      "%cmi_user_balance_formatted%",
      "",
      "# Current player health",
      "%cmi_user_health%",
    ].join("\n"),
    "CMIPlugin/data/placeholders.log",
  );
  const faq = extractEntriesFromCommentLogText(
    [
      "# Category: Support FAQ",
      "# Keywords: economy, money, balance, vault",
      "CMI Economy Manager",
      "",
      "# Category: Support FAQ",
      "# Keywords: health, healing",
      "Healing players",
    ].join("\n"),
    "CMIPlugin/data/faq.log",
  );
  return {
    entriesByProfile: { command, permission, config, placeholder, faq },
    command,
    permission,
  };
}

test("a command deterministically links complementary profiles within a bounded result", () => {
  const fixture = makeFixture();
  const index = createRelatedReferenceIndex(fixture.entriesByProfile);
  const references = index.find({
    sourceProfileName: "command",
    sourceEntry: fixture.command[0],
    query: "balance",
  });

  assert.equal(index.getProfileCount(), 5);
  assert.deepEqual(
    [...new Set(references.map((reference) => reference.profileName))],
    ["permission", "config", "placeholder", "faq"],
  );
  assert.equal(references[0].entry.yamlPath, "cmi.command.balance");
  assert.ok(references.length <= 6);
  assert.ok(references.every((reference) => reference.profileName !== "command"));
  assert.ok(references.some((reference) => reference.entry.yamlPath === "Economy.BalanceFormat"));
  assert.ok(references.some((reference) => reference.entry.yamlPath === "%cmi_user_balance_formatted%"));
  assert.ok(references.some((reference) => reference.entry.yamlPath === "CMI Economy Manager"));
  assert.ok(references.every((reference) => !/heal/i.test(reference.entry.yamlPath)));
});

test("permission relationships resolve back to the canonical command", () => {
  const fixture = makeFixture();
  const index = createRelatedReferenceIndex(fixture.entriesByProfile);
  const references = index.find({
    sourceProfileName: "permission",
    sourceEntry: fixture.permission[1],
    query: "balance others",
  });

  assert.equal(references[0].profileName, "command");
  assert.match(references[0].entry.yamlPath, /^\/cmi balance/);
});

test("cross-profile references honor the eligibility filter and hard bound", () => {
  const fixture = makeFixture();
  fixture.entriesByProfile.config.push(
    ...extractEntriesFromText(
      "BalanceSecret: hidden",
      "CMIPlugin/private/credentials.yml",
    ),
  );
  const index = createRelatedReferenceIndex(fixture.entriesByProfile);
  const references = index.find({
    sourceProfileName: "command",
    sourceEntry: fixture.command[0],
    query: "balance",
    maxReferences: 3,
    isEntryAllowed(entry) {
      return !entry.relativePath.includes("credentials");
    },
  });

  assert.equal(references.length, 3);
  assert.ok(references.every((reference) => !reference.entry.relativePath.includes("credentials")));
});

test("config descriptions do not create unrelated cross-profile matches", () => {
  const config = extractEntriesFromText(
    [
      "Economy:",
      "  # Player needs to confirm a money payment through chat",
      "  Confirmation: false",
    ].join("\n"),
    "CMIPlugin/CMI/config.yml",
  );
  const permission = extractEntriesFromPermissionListText(
    "cmi.command.tpa - Ask another player to confirm a teleport request",
    "CMIPlugin/data/permissions.log",
  );
  const index = createRelatedReferenceIndex({ config, permission });
  const references = index.find({
    sourceProfileName: "config",
    sourceEntry: config.at(-1),
    query: "economy",
  });

  assert.ok(references.every((reference) => reference.profileName !== "permission"));
});

test("material references require a shared identity instead of a generic suffix", () => {
  const material = extractEntriesFromDelimitedText(
    ["STONE", "OAK_LOG"].join("\n"),
    "CMIPlugin/data/materials.log",
  );
  const language = extractEntriesFromText(
    ["STONE: Stone", "OAK_LOG: Oak Log"].join("\n"),
    "CMIPlugin/Translations/materials.yml",
  );
  const config = extractEntriesFromText(
    "Economy:\n  log: true",
    "CMIPlugin/CMI/config.yml",
  );
  const index = createRelatedReferenceIndex({ material, language, config });

  const stoneReferences = index.find({
    sourceProfileName: "material",
    sourceEntry: material[0],
    query: "stone",
  });
  assert.deepEqual(
    stoneReferences.map((reference) => [reference.profileName, reference.entry.yamlPath]),
    [["language", "STONE"]],
  );

  const oakReferences = index.find({
    sourceProfileName: "material",
    sourceEntry: material[1],
    query: "oak_log",
  });
  assert.ok(oakReferences.some((reference) => reference.entry.yamlPath === "OAK_LOG"));
  assert.ok(oakReferences.every((reference) => reference.entry.yamlPath !== "Economy.log"));
});
