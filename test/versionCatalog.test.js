import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createVersionService,
  formatLatestVersions,
  formatPublicLatestVersions,
  formatVersionServiceSummary,
} from "../src/versionCatalog.js";

function makeConfig(workspaceRoot) {
  return {
    workspaceRoot,
    versions: {
      catalogPath: "versions.json",
      statePath: "logs/upstream-versions.json",
      checkEnabled: false,
      checkIntervalMs: 60_000,
      paperVersion: "26.2",
      paperChannels: ["STABLE"],
      requestTimeoutMs: 1_000,
    },
  };
}

function makeCatalog(generatedAt) {
  return {
    schemaVersion: 1,
    generatedAt,
    paper: {
      id: "paper",
      label: "Paper",
      version: "26.2",
      build: 87,
    },
    plugins: [],
    companions: [],
  };
}

function makeTrackedCatalog(generatedAt = "generated") {
  return {
    schemaVersion: 1,
    generatedAt,
    paper: {
      id: "paper",
      label: "Paper",
      version: "26.2",
      build: 80,
      channel: "STABLE",
      projectUrl: "https://papermc.io/",
    },
    plugins: [
      {
        id: "cmi",
        label: "CMI",
        version: "0.9.0",
        contextId: "cmi",
        tracked: true,
        resourceId: 3742,
        resourceUrl: "https://example.test/cmi",
      },
      {
        id: "cmilib",
        label: "CMILib",
        version: "0.9.0",
        contextId: null,
        shared: true,
        tracked: true,
        resourceId: 87610,
        resourceUrl: "https://example.test/cmilib",
      },
    ],
    companions: [
      {
        id: "cmi-bungee",
        label: "CMI-Bungee",
        version: "1.0.0",
        resourceUrl: "https://example.test/cmi-bungee",
        versionSource: {
          type: "zrips-listing",
          url: "https://example.test/companions",
          filePrefix: "CMIB",
        },
      },
    ],
  };
}

function makeNetworkConfig(workspaceRoot) {
  const config = makeConfig(workspaceRoot);
  config.versions.checkEnabled = true;
  return config;
}

function createFetchFixture(t) {
  const state = {
    paperBuild: 87,
    cmiVersion: "1.0.0",
    cmilibVersion: "1.0.0",
    companionVersion: "1.0.0",
    failures: new Set(),
  };

  t.mock.method(globalThis, "fetch", async (input) => {
    const url = String(input);
    let key;
    let body;

    if (url.includes("fill.papermc.io")) {
      key = "paper";
      body = [{ id: state.paperBuild, channel: "STABLE" }];
    } else if (url.includes("/resources/3742/")) {
      key = "cmi";
      body = { name: state.cmiVersion };
    } else if (url.includes("/resources/87610/")) {
      key = "cmilib";
      body = { name: state.cmilibVersion };
    } else if (url === "https://example.test/companions") {
      key = "companion";
      body = `file=CMIB${state.companionVersion}.jar`;
    } else {
      throw new Error(`Unexpected test URL: ${url}`);
    }

    if (state.failures.has(key)) {
      throw new Error(`${key} temporarily unavailable`);
    }

    return {
      ok: true,
      status: 200,
      statusText: "OK",
      async json() {
        return body;
      },
      async text() {
        return String(body);
      },
    };
  });

  return state;
}

test("a version catalog reload stays staged until commit", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lookupbot-version-"));
  const catalogPath = path.join(workspaceRoot, "versions.json");
  const service = createVersionService(makeConfig(workspaceRoot));

  try {
    await fs.writeFile(catalogPath, JSON.stringify(makeCatalog("old")), "utf8");
    await service.start();

    await fs.writeFile(catalogPath, JSON.stringify(makeCatalog("new")), "utf8");
    const transaction = await service.prepareReload();
    assert.equal(service.getSnapshot().catalog.generatedAt, "old");
    assert.equal(transaction.snapshot.catalog.generatedAt, "new");

    transaction.commit();
    assert.equal(service.getSnapshot().catalog.generatedAt, "new");

    await fs.writeFile(catalogPath, "{}", "utf8");
    await assert.rejects(() => service.prepareReload(), /Unsupported version catalog format/);
    assert.equal(service.getSnapshot().catalog.generatedAt, "new");
  } finally {
    service.stop();
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("a partial upstream failure retains only the affected last-known result", async (t) => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lookupbot-version-fallback-"));
  const catalogPath = path.join(workspaceRoot, "versions.json");
  const service = createVersionService(makeNetworkConfig(workspaceRoot));
  const upstream = createFetchFixture(t);

  try {
    await fs.writeFile(catalogPath, JSON.stringify(makeTrackedCatalog()), "utf8");
    const initial = await service.start();
    assert.equal(initial.plugins.get("cmi").version, "1.0.0");
    assert.equal(initial.plugins.get("cmi").stale, false);

    upstream.paperBuild = 88;
    upstream.cmilibVersion = "1.1.0";
    upstream.companionVersion = "1.1.0";
    upstream.failures.add("cmi");

    const partial = await service.refreshUpstream();
    assert.equal(partial.paper.build, 88);
    assert.equal(partial.plugins.get("cmilib").version, "1.1.0");
    assert.equal(partial.companions.get("cmi-bungee").version, "1.1.0");
    assert.equal(partial.plugins.get("cmi").version, "1.0.0");
    assert.equal(partial.plugins.get("cmi").stale, true);
    assert.equal(partial.errorCount, 1);
    assert.equal(partial.retainedCount, 1);

    const privateOutput = formatLatestVersions(partial, { id: "cmi", label: "CMI" });
    const publicOutput = formatPublicLatestVersions(partial, { id: "cmi", label: "CMI" });
    assert.match(privateOutput, /last known, refresh unavailable/i);
    assert.match(publicOutput, /last known; live refresh unavailable/i);
    assert.match(formatVersionServiceSummary(partial), /1 last-known result retained/i);

    upstream.failures.clear();
    upstream.cmiVersion = "1.2.0";
    const recovered = await service.refreshUpstream();
    assert.equal(recovered.plugins.get("cmi").version, "1.2.0");
    assert.equal(recovered.plugins.get("cmi").stale, false);
    assert.equal(recovered.errorCount, 0);
    assert.equal(recovered.retainedCount, 0);
  } finally {
    service.stop();
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("a reload transaction retains all matching last-known values during an outage", async (t) => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lookupbot-version-reload-fallback-"));
  const catalogPath = path.join(workspaceRoot, "versions.json");
  const service = createVersionService(makeNetworkConfig(workspaceRoot));
  const upstream = createFetchFixture(t);

  try {
    await fs.writeFile(catalogPath, JSON.stringify(makeTrackedCatalog("old")), "utf8");
    await service.start();
    upstream.failures = new Set(["paper", "cmi", "cmilib", "companion"]);
    await fs.writeFile(catalogPath, JSON.stringify(makeTrackedCatalog("new")), "utf8");

    const transaction = await service.prepareReload();
    assert.equal(service.getSnapshot().catalog.generatedAt, "old");
    assert.equal(service.getSnapshot().plugins.get("cmi").stale, false);
    assert.equal(transaction.snapshot.catalog.generatedAt, "new");
    assert.equal(transaction.snapshot.paper.build, 87);
    assert.equal(transaction.snapshot.plugins.get("cmi").version, "1.0.0");
    assert.equal(transaction.snapshot.plugins.get("cmilib").version, "1.0.0");
    assert.equal(transaction.snapshot.companions.get("cmi-bungee").version, "1.0.0");
    assert.equal(transaction.snapshot.plugins.get("cmi").stale, true);
    assert.equal(transaction.snapshot.errorCount, 4);
    assert.equal(transaction.snapshot.retainedCount, 4);

    const committed = transaction.commit();
    assert.equal(committed.catalog.generatedAt, "new");
    assert.equal(committed.retainedCount, 4);
    await service.flushPersistence();
  } finally {
    service.stop();
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("last-known upstream values survive a cold restart", async (t) => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lookupbot-version-persisted-"));
  const catalogPath = path.join(workspaceRoot, "versions.json");
  const statePath = path.join(workspaceRoot, "logs/upstream-versions.json");
  const config = makeNetworkConfig(workspaceRoot);
  const upstream = createFetchFixture(t);
  const firstService = createVersionService(config);
  let secondService = null;

  try {
    await fs.writeFile(catalogPath, JSON.stringify(makeTrackedCatalog()), "utf8");
    const initial = await firstService.start();
    assert.equal(initial.retainedCount, 0);
    await firstService.flushPersistence();
    firstService.stop();

    const persisted = JSON.parse(await fs.readFile(statePath, "utf8"));
    assert.equal(persisted.schemaVersion, 1);
    assert.equal(persisted.paper.build, 87);
    assert.equal(persisted.plugins.cmi.version, "1.0.0");
    assert.equal(persisted.companions["cmi-bungee"].version, "1.0.0");
    assert.equal("stale" in persisted.plugins.cmi, false);
    assert.doesNotMatch(JSON.stringify(persisted), /resourceUrl|discord|token/i);

    upstream.failures = new Set(["paper", "cmi", "cmilib", "companion"]);
    secondService = createVersionService(config);
    const restarted = await secondService.start();

    assert.equal(restarted.paper.build, 87);
    assert.equal(restarted.plugins.get("cmi").version, "1.0.0");
    assert.equal(restarted.plugins.get("cmilib").version, "1.0.0");
    assert.equal(restarted.companions.get("cmi-bungee").version, "1.0.0");
    assert.equal(restarted.errorCount, 4);
    assert.equal(restarted.retainedCount, 4);
    assert.equal(restarted.plugins.get("cmi").stale, true);
    await secondService.flushPersistence();
  } finally {
    firstService.stop();
    secondService?.stop();
    await firstService.flushPersistence();
    if (secondService) {
      await secondService.flushPersistence();
    }
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});
