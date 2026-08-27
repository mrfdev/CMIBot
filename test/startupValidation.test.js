import assert from "node:assert/strict";
import test from "node:test";
import {
  validateStartupState,
  validateVersionCatalog,
} from "../src/startupValidation.js";

function makeFixture() {
  const config = {
    versions: {
      paperVersion: "26.2",
    },
    plugins: {
      cmi: {
        id: "cmi",
        profiles: {
          config: {},
          language: {},
        },
      },
    },
  };
  const cacheSummary = {
    totalEntries: 5,
    totalFiles: 2,
    pluginSummaries: [
      {
        pluginId: "cmi",
        pluginLabel: "CMI",
        totalEntries: 5,
        totalFiles: 2,
        profileSummaries: [
          { profileName: "config", entryCount: 2, fileCount: 1 },
          { profileName: "language", entryCount: 3, fileCount: 1 },
        ],
      },
    ],
    sharedCmilibSummary: null,
    lastReloadedAt: new Date("2026-08-27T08:00:00.000Z"),
  };
  const catalog = {
    schemaVersion: 1,
    generatedAt: "2026-08-27T07:00:00.000Z",
    paper: {
      id: "paper",
      label: "Paper",
      version: "26.2",
      build: 112,
    },
    plugins: [
      {
        id: "cmi",
        label: "CMI",
        version: "9.8.9.9",
        contextId: "cmi",
      },
    ],
    companions: [],
  };
  const versionSnapshot = {
    catalog,
    paper: null,
    plugins: new Map(),
    companions: new Map(),
    checkedAt: null,
    errorCount: 0,
    retainedCount: 0,
    checkEnabled: false,
  };
  return { config, cacheSummary, catalog, versionSnapshot };
}

test("complete startup data passes fail-closed validation", () => {
  const fixture = makeFixture();
  const result = validateStartupState(
    fixture.config,
    fixture.cacheSummary,
    fixture.versionSnapshot,
  );

  assert.equal(result.ready, true);
  assert.equal(result.pluginCount, 1);
  assert.equal(result.profileCount, 2);
});

test("missing cache profiles stop startup", () => {
  const fixture = makeFixture();
  fixture.cacheSummary.pluginSummaries[0].profileSummaries.pop();
  fixture.cacheSummary.pluginSummaries[0].totalEntries = 2;
  fixture.cacheSummary.pluginSummaries[0].totalFiles = 1;
  fixture.cacheSummary.totalEntries = 2;
  fixture.cacheSummary.totalFiles = 1;

  assert.throws(
    () => validateStartupState(fixture.config, fixture.cacheSummary, fixture.versionSnapshot),
    /missing the language profile summary/i,
  );
});

test("duplicate version routes stop startup", () => {
  const fixture = makeFixture();
  fixture.catalog.plugins.push({
    id: "duplicate-context",
    label: "Duplicate",
    version: "1.0.0",
    contextId: "cmi",
  });

  assert.throws(
    () => validateStartupState(fixture.config, fixture.cacheSummary, fixture.versionSnapshot),
    /duplicate plugin context/i,
  );
});

test("network-backed catalog sources must use credential-free HTTPS URLs", () => {
  const fixture = makeFixture();
  fixture.catalog.plugins[0].versionSource = {
    type: "luckperms-metadata",
    url: "file:///private/data",
  };

  assert.throws(
    () => validateVersionCatalog(fixture.catalog, fixture.config),
    (error) => {
      assert.match(error.message, /credential-free HTTPS URL/i);
      assert.doesNotMatch(error.message, /private\/data/);
      return true;
    },
  );
});
