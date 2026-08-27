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
    searchText: `${generation} ${profileName}`,
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

test("an empty or malformed index cannot replace active cache data", async () => {
  let mode = "valid";
  const cache = createSearchCache(makeConfig(), {
    async loadEntriesForProfile(profile) {
      if (mode === "empty" && profile.name === "language") {
        return [];
      }
      if (mode === "malformed" && profile.name === "language") {
        return [{ ...makeEntry("bad", profile.name), relativePath: "../private-file" }];
      }
      return [makeEntry("old", profile.name)];
    },
    async buildLanguageCategoryStats() {
      return [];
    },
  });

  await cache.warm();
  const activeEntries = cache.getEntries("example", "config");

  mode = "empty";
  await assert.rejects(() => cache.reloadAll(), /index is empty/i);
  assert.strictEqual(cache.getEntries("example", "config"), activeEntries);

  mode = "malformed";
  await assert.rejects(
    () => cache.reloadAll(),
    (error) => {
      assert.match(error.message, /malformed entry/i);
      assert.doesNotMatch(error.message, /private-file/);
      return true;
    },
  );
  assert.strictEqual(cache.getEntries("example", "config"), activeEntries);
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
          searchText: `shared ${profile.name}`,
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
          searchText: `local ${profile.name}`,
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

test("full cache warming uses one bounded concurrency limit across profile loaders", async () => {
  const config = makeSharedConfig();
  config.search = { cacheLoadConcurrency: 2 };
  let activeLoads = 0;
  let maximumActiveLoads = 0;
  let completedLoads = 0;
  const cache = createSearchCache(config, {
    async loadEntriesForProfile(profile) {
      activeLoads += 1;
      maximumActiveLoads = Math.max(maximumActiveLoads, activeLoads);
      await new Promise((resolve) => setTimeout(resolve, 5));
      activeLoads -= 1;
      completedLoads += 1;
      return [
        {
          relativePath: profile.include[0],
          lineNumber: 1,
          yamlPath: profile.name,
          searchText: profile.name,
        },
      ];
    },
    async buildLanguageCategoryStats() {
      return [];
    },
  });

  assert.equal(cache.getGeneration(), 0);
  await cache.warm();

  assert.equal(completedLoads, 6);
  assert.equal(maximumActiveLoads, 2);
  assert.equal(cache.getGeneration(), 1);
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
          searchText: `${generation} ${profile.name}`,
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

test("a selective profile reload atomically replaces only the requested profile", async () => {
  let generation = "old";
  const cache = createSearchCache(makeSharedConfig(), {
    async loadEntriesForProfile(profile) {
      return [
        {
          relativePath: `${generation}/${profile.include[0]}`,
          lineNumber: 1,
          yamlPath: `${generation}.${profile.name}`,
          searchText: `${generation} ${profile.name}`,
        },
      ];
    },
    async buildLanguageCategoryStats() {
      return [];
    },
  });

  await cache.warm();
  const oldAlphaLanguage = cache.getEntries("alpha", "language");
  const oldBetaConfig = cache.getEntries("beta", "config");
  generation = "new";

  const transaction = await cache.prepareReload({ pluginId: "alpha", profileName: "config" });
  assert.deepEqual(transaction.scope, {
    type: "profile",
    pluginId: "alpha",
    profileName: "config",
  });
  assert.equal(transaction.summary.pluginSummaries[0].profileSummaries.length, 1);
  assert.equal(cache.getEntries("alpha", "config")[0].relativePath.startsWith("old/"), true);

  transaction.commit();
  assert.equal(cache.getEntries("alpha", "config")[0].relativePath.startsWith("new/"), true);
  assert.deepEqual(cache.getEntries("alpha", "language"), oldAlphaLanguage);
  assert.deepEqual(cache.getEntries("beta", "config"), oldBetaConfig);
});

test("repeated searches use a bounded LRU and successful reloads invalidate it", async () => {
  const config = makeConfig();
  config.search = {
    cacheLoadConcurrency: 2,
    resultCacheMaxEntries: 2,
  };
  let loadGeneration = "old";
  let failReload = false;
  let searchCalls = 0;
  const cache = createSearchCache(config, {
    async loadEntriesForProfile(profile) {
      if (failReload && profile.name === "language") {
        throw new Error("reload failed");
      }
      return [makeEntry(loadGeneration, profile.name)];
    },
    async buildLanguageCategoryStats() {
      return [];
    },
    lexicalSearchWithStats(query, entries) {
      searchCalls += 1;
      return {
        matches: [{ entry: entries[0], score: query.length }],
        totalMatches: 1,
        matchedFiles: [entries[0].relativePath],
        synonymApplied: false,
        queryVariantCount: 1,
      };
    },
  });

  await cache.warm();
  const search = (query) => cache.search("example", "config", query, { limit: 20 });

  assert.equal(search("alpha").cacheStatus, "miss");
  assert.equal(search("  ALPHA  ").cacheStatus, "hit");
  assert.equal(search("bravo").cacheStatus, "miss");
  assert.equal(search("alpha").cacheStatus, "hit");
  assert.equal(search("charlie").cacheEvicted, true);
  assert.equal(search("bravo").cacheStatus, "miss");
  assert.equal(searchCalls, 4);
  assert.deepEqual(cache.getResultCacheSummary(), {
    entries: 2,
    maxEntries: 2,
    hits: 2,
    misses: 4,
    evictions: 2,
    invalidations: 1,
    invalidatedEntries: 0,
  });

  failReload = true;
  await assert.rejects(() => cache.reloadAll(), /reload failed/);
  assert.equal(search("bravo").cacheStatus, "hit");
  assert.equal(searchCalls, 4);

  failReload = false;
  loadGeneration = "new";
  await cache.reloadAll();
  assert.equal(cache.getResultCacheSummary().entries, 0);
  assert.equal(cache.getResultCacheSummary().invalidatedEntries, 2);
  assert.equal(search("bravo").cacheStatus, "miss");
  assert.equal(searchCalls, 5);
  assert.equal(search("bravo").result.matches[0].entry.relativePath, "new/config.yml");
});
