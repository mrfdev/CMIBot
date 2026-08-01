import assert from "node:assert/strict";
import test from "node:test";
import { createSearchCache } from "../src/cache.js";

function makeConfig() {
  return {
    workspaceRoot: "/unused",
    plugins: {
      example: {
        id: "example",
        label: "Example",
        profiles: {
          config: {
            name: "config",
            displayName: "config",
            statsFileLabel: "YAML configuration files",
          },
          language: {
            name: "language",
            displayName: "language",
            statsFileLabel: "YAML locale files",
            include: [],
          },
        },
      },
    },
  };
}

function makeEntry(generation, profileName) {
  return {
    relativePath: `${generation}/${profileName}.yml`,
    lineNumber: 1,
    yamlPath: `${generation}.${profileName}`,
  };
}

test("a failed cache reload leaves every active profile unchanged", async () => {
  let generation = "old";
  let failingProfile = "";
  const cache = createSearchCache(makeConfig(), {
    async loadEntriesForProfile(profile) {
      if (profile.name === failingProfile) {
        throw new Error(`failed to load ${profile.name}`);
      }
      return [makeEntry(generation, profile.name)];
    },
    async buildLanguageCategoryStats() {
      return [];
    },
  });

  await cache.warm();
  const oldConfigEntries = cache.getEntries("example", "config");
  const oldLanguageEntries = cache.getEntries("example", "language");
  const oldPluginSummary = cache.getPluginSummary("example");
  const oldReloadedAt = cache.getGlobalSummary().lastReloadedAt;

  generation = "new";
  failingProfile = "language";
  await assert.rejects(() => cache.reloadAll(), /failed to load language/);

  assert.strictEqual(cache.getEntries("example", "config"), oldConfigEntries);
  assert.strictEqual(cache.getEntries("example", "language"), oldLanguageEntries);
  assert.strictEqual(cache.getPluginSummary("example"), oldPluginSummary);
  assert.strictEqual(cache.getGlobalSummary().lastReloadedAt, oldReloadedAt);
});

test("prepared cache data stays invisible until its transaction commits", async () => {
  let generation = "old";
  const cache = createSearchCache(makeConfig(), {
    async loadEntriesForProfile(profile) {
      return [makeEntry(generation, profile.name)];
    },
    async buildLanguageCategoryStats() {
      return [];
    },
  });

  await cache.warm();
  generation = "new";
  const transaction = await cache.prepareReload();

  assert.equal(cache.getEntries("example", "config")[0].relativePath, "old/config.yml");
  assert.equal(transaction.summary.pluginSummaries[0].profileSummaries[0].entryCount, 1);

  transaction.commit();
  assert.equal(cache.getEntries("example", "config")[0].relativePath, "new/config.yml");
  assert.equal(cache.getEntries("example", "language")[0].relativePath, "new/language.yml");
});

function makeSharedConfig() {
  const makeProfile = (name, include, sharedProfileName = "") => ({
    name,
    displayName: name,
    statsFileLabel: name === "language" ? "YAML locale files" : "YAML configuration files",
    include,
    exclude: [],
    sharedProfileName,
  });

  return {
    workspaceRoot: "/unused",
    sharedCmilib: {
      id: "cmilib",
      label: "Shared CMILib data",
      profiles: {
        config: makeProfile("config", ["CMILibPlugin/CMILib/config.yml"]),
        language: makeProfile("language", ["CMILibPlugin/CMILib/Translations/Locale_EN.yml"]),
      },
    },
    plugins: {
      alpha: {
        id: "alpha",
        label: "Alpha",
        profiles: {
          config: makeProfile(
            "config",
            ["AlphaPlugin/config.yml", "CMILibPlugin/CMILib/config.yml"],
            "config",
          ),
          language: makeProfile(
            "language",
            ["AlphaPlugin/Locale_EN.yml", "CMILibPlugin/CMILib/Translations/Locale_EN.yml"],
            "language",
          ),
        },
      },
      beta: {
        id: "beta",
        label: "Beta",
        profiles: {
          config: makeProfile(
            "config",
            ["BetaPlugin/config.yml", "CMILibPlugin/CMILib/config.yml"],
            "config",
          ),
          language: makeProfile(
            "language",
            ["BetaPlugin/Locale_EN.yml", "CMILibPlugin/CMILib/Translations/Locale_EN.yml"],
            "language",
          ),
        },
      },
    },
  };
}

test("CMILib profiles load once and are composed into every plugin context", async () => {
  const loadCounts = new Map();
  const localProfiles = [];
  const sharedEntries = new Map();
  const cache = createSearchCache(makeSharedConfig(), {
    async loadEntriesForProfile(profile) {
      const source = profile.include[0];
      loadCounts.set(source, (loadCounts.get(source) ?? 0) + 1);
      if (source.startsWith("CMILibPlugin/")) {
        const entry = {
          relativePath: source,
          lineNumber: 1,
          yamlPath: `shared.${profile.name}`,
        };
        sharedEntries.set(profile.name, entry);
        return [entry];
      }

      localProfiles.push(profile);
      return [
        {
          relativePath: source,
          lineNumber: 1,
          yamlPath: `local.${profile.name}`,
        },
      ];
    },
    async buildLanguageCategoryStats(_workspaceRoot, include) {
      return [{ key: include[0], englishRelativePath: include[0] }];
    },
  });

  const summary = await cache.warm();
  const alphaConfig = cache.getEntries("alpha", "config");
  const betaConfig = cache.getEntries("beta", "config");
  const alphaLanguage = cache.getSnapshot("alpha", "language");

  assert.equal(loadCounts.get("CMILibPlugin/CMILib/config.yml"), 1);
  assert.equal(loadCounts.get("CMILibPlugin/CMILib/Translations/Locale_EN.yml"), 1);
  assert.equal(alphaConfig.length, 2);
  assert.equal(betaConfig.length, 2);
  assert.strictEqual(alphaConfig[1], sharedEntries.get("config"));
  assert.strictEqual(betaConfig[1], sharedEntries.get("config"));
  assert.equal(alphaLanguage.entries.length, 2);
  assert.equal(alphaLanguage.languageCategories.length, 2);
  assert.ok(localProfiles.every((profile) => profile.exclude.includes("CMILibPlugin/**")));
  assert.ok(localProfiles.every((profile) => profile.include.every((glob) => !glob.startsWith("CMILibPlugin/"))));

  assert.equal(cache.getPluginSummary("alpha").totalEntries, 4);
  assert.equal(cache.getPluginSummary("beta").totalEntries, 4);
  assert.equal(summary.totalEntries, 6);
  assert.equal(summary.totalFiles, 6);
  assert.equal(summary.sharedCmilibSummary.profileSummaries.length, 2);
  assert.deepEqual(cache.getGlobalSummary(), summary);
});

test("a failed shared CMILib reload leaves local and shared snapshots unchanged", async () => {
  let generation = "old";
  let failSharedReload = false;
  const cache = createSearchCache(makeSharedConfig(), {
    async loadEntriesForProfile(profile) {
      if (failSharedReload && profile.include[0].startsWith("CMILibPlugin/")) {
        throw new Error("shared CMILib failed");
      }
      return [
        {
          relativePath: `${generation}/${profile.include[0]}`,
          lineNumber: 1,
          yamlPath: `${generation}.${profile.name}`,
        },
      ];
    },
    async buildLanguageCategoryStats() {
      return [];
    },
  });

  await cache.warm();
  const oldEntries = cache.getEntries("alpha", "config");
  const oldSummary = cache.getGlobalSummary();

  generation = "new";
  failSharedReload = true;
  await assert.rejects(() => cache.reloadAll(), /shared CMILib failed/);

  assert.deepEqual(cache.getEntries("alpha", "config"), oldEntries);
  assert.strictEqual(cache.getGlobalSummary().lastReloadedAt, oldSummary.lastReloadedAt);
  assert.equal(cache.getEntries("alpha", "config")[1].relativePath.startsWith("old/"), true);
});
