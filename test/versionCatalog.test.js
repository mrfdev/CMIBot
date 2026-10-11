import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createVersionService,
  formatLatestVersionMessages,
  formatLatestVersions,
  formatPublicLatestVersions,
  formatVersionServiceSummary,
  getVersionAttentionSummary,
} from "../src/versionCatalog.js";
import { evaluateAttention } from "../src/attentionMonitor.js";

const PAPER_API_ROOT = "https://fill.papermc.io/v3/projects/paper";
const SILENT_LOGGER = { info() {}, warn() {}, error() {} };

function makePaperBuild(version, id, channel, checksumCharacter = "a") {
  const name = `paper-${version}-${id}.jar`;
  const sha256 = checksumCharacter.repeat(64);
  return {
    id,
    channel,
    downloads: {
      "server:default": {
        name,
        checksums: { sha256 },
        url: `https://fill-data.papermc.io/v1/objects/${sha256}/${name}`,
      },
    },
  };
}

function makeConfig(workspaceRoot) {
  return {
    workspaceRoot,
    versions: {
      catalogPath: "versions.json",
      statePath: "logs/upstream-versions.json",
      checkEnabled: false,
      checkIntervalMs: 60_000,
      paperVersion: "26.3",
      paperChannels: ["STABLE"],
      requestTimeoutMs: 1_000,
      retryMaxAttempts: 1,
      retryBaseDelayMs: 0,
      retryMaxDelayMs: 0,
      circuitFailureThreshold: 3,
      circuitCooldownMs: 60_000,
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
      version: "26.3",
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
      version: "26.3",
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
    paperBuildsByVersion: {},
    cmiVersion: "1.0.0",
    cmilibVersion: "1.0.0",
    residenceVersion: "6.0.3.0",
    companionVersion: "1.0.0",
    failures: new Set(),
    requests: [],
  };

  t.mock.method(globalThis, "fetch", async (input) => {
    const url = String(input);
    state.requests.push(url);
    let key;
    let body;

    if (url.startsWith(`${PAPER_API_ROOT}/versions/`)) {
      const version = decodeURIComponent(url.slice(`${PAPER_API_ROOT}/versions/`.length).split("/")[0]);
      key = "paper";
      body = state.paperBuildsByVersion[version] ?? [{ id: state.paperBuild, channel: "STABLE" }];
    } else if (url.includes("/resources/3742/")) {
      key = "cmi";
      body = { name: state.cmiVersion };
    } else if (url.includes("/resources/87610/")) {
      key = "cmilib";
      body = { name: state.cmilibVersion };
    } else if (url.startsWith("https://example.test/residence?")) {
      key = "residence";
      body = [
        '<a href="download.php?file=Residence6.0.1.0.jar">Residence 6.0.1.0</a>',
        `<a href="download.php?file=Residence${state.residenceVersion}.jar">Residence ${state.residenceVersion}</a>`,
      ].join("\n");
    } else if (url.startsWith("https://example.test/companions?")) {
      key = "companion";
      body = `file=CMIB${state.companionVersion}.jar`;
    } else {
      throw new Error(`Unexpected test URL: ${url}`);
    }

    if (state.failures.has(key) || state.failures.has(url)) {
      throw new Error(`${key} temporarily unavailable`);
    }

    return new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status: 200,
      headers: {
        "content-type": typeof body === "string" ? "text/plain" : "application/json",
      },
    });
  });

  return state;
}

test("version attention summary reports only privacy-safe resource keys", () => {
  const catalog = makeTrackedCatalog();
  const snapshot = {
    catalog,
    checkEnabled: true,
    paper: { version: "26.3", build: 87, stale: false },
    plugins: new Map([
      ["cmi", { version: "1.0.0", stale: true }],
      ["cmilib", { version: "1.0.0", stale: false }],
    ]),
    companions: new Map(),
  };

  assert.deepEqual(getVersionAttentionSummary(snapshot), {
    updateKeys: ["paper", "plugin:cmi", "plugin:cmilib"],
    unavailableKeys: ["companion:cmi-bungee"],
    staleKeys: ["plugin:cmi"],
  });
});

test("version attention summary is empty when live checks are disabled", () => {
  assert.deepEqual(
    getVersionAttentionSummary({
      catalog: makeTrackedCatalog(),
      checkEnabled: false,
      plugins: new Map(),
      companions: new Map(),
    }),
    {
      updateKeys: [],
      unavailableKeys: [],
      staleKeys: [],
    },
  );
});

test("version checks recover from temporary HTTP failures through the resilience layer", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lookupbot-version-retry-"));
  const catalogPath = path.join(workspaceRoot, "versions.json");
  const config = makeNetworkConfig(workspaceRoot);
  config.versions.retryMaxAttempts = 3;
  config.versions.retryBaseDelayMs = 10;
  config.versions.retryMaxDelayMs = 20;
  const delays = [];
  let attempts = 0;
  const service = createVersionService(config, {
    random: () => 0.5,
    sleep: async (delayMs) => delays.push(delayMs),
    logger: { info() {}, warn() {}, error() {} },
    async fetch(input) {
      attempts += 1;
      if (attempts < 3) {
        return new Response("unavailable", { status: 503 });
      }
      return Response.json([{ id: 91, channel: "STABLE" }]);
    },
  });

  try {
    await fs.writeFile(catalogPath, JSON.stringify(makeCatalog("generated")), "utf8");
    const snapshot = await service.start();

    assert.equal(snapshot.paper.build, 91);
    assert.equal(snapshot.errorCount, 0);
    assert.equal(attempts, 3);
    assert.deepEqual(delays, [10, 20]);
  } finally {
    service.stop();
    await service.flushPersistence();
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("Spiget requests bypass stale CDN entries on every refresh", async (t) => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lookupbot-version-cache-bust-"));
  const catalogPath = path.join(workspaceRoot, "versions.json");
  const service = createVersionService(makeNetworkConfig(workspaceRoot));
  const upstream = createFetchFixture(t);

  try {
    await fs.writeFile(catalogPath, JSON.stringify(makeTrackedCatalog()), "utf8");
    await service.start();
    await service.refreshUpstream();

    const cmiRequests = upstream.requests.filter((url) => url.includes("/resources/3742/versions/latest"));
    const cmilibRequests = upstream.requests.filter((url) => url.includes("/resources/87610/versions/latest"));
    assert.equal(cmiRequests.length, 2);
    assert.equal(cmilibRequests.length, 2);
    assert.match(cmiRequests[0], /[?&]cacheBust=\d+-\d+$/);
    assert.match(cmilibRequests[0], /[?&]cacheBust=\d+-\d+$/);
    assert.notEqual(cmiRequests[0], cmiRequests[1]);
    assert.notEqual(cmilibRequests[0], cmilibRequests[1]);
  } finally {
    service.stop();
    await service.flushPersistence();
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("Residence uses the free Zrips listing and appears in latest context output", async (t) => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lookupbot-version-residence-"));
  const catalogPath = path.join(workspaceRoot, "versions.json");
  const service = createVersionService(makeNetworkConfig(workspaceRoot));
  const upstream = createFetchFixture(t);
  const catalog = makeTrackedCatalog();
  catalog.plugins.push({
    id: "residence",
    label: "Residence",
    version: "6.0.2.4",
    contextId: "residence",
    tracked: true,
    resourceId: 11480,
    resourceUrl: "https://zrips.net/Residence/",
    versionSource: {
      type: "zrips-listing",
      url: "https://example.test/residence",
      filePrefix: "Residence",
    },
  });

  try {
    await fs.writeFile(catalogPath, JSON.stringify(catalog), "utf8");
    const snapshot = await service.start();

    assert.equal(snapshot.plugins.get("residence").version, "6.0.3.0");
    const residenceRequests = upstream.requests.filter((url) =>
      url.startsWith("https://example.test/residence?"),
    );
    assert.equal(residenceRequests.length, 1);
    assert.match(residenceRequests[0], /[?&]cacheBust=\d+-\d+$/);
    assert.equal(upstream.requests.some((url) => url.includes("/resources/11480/")), false);

    const plugin = { id: "residence", label: "Residence" };
    const privateOutput = formatLatestVersions(snapshot, plugin);
    const publicOutput = formatPublicLatestVersions(snapshot, plugin);
    assert.match(privateOutput, /Current context: `Residence`/);
    assert.match(privateOutput, /clean snapshot `6\.0\.2\.4` \| upstream `6\.0\.3\.0` \(\*\*update available\*\*\)/);
    assert.match(privateOutput, /https:\/\/zrips\.net\/Residence\//);
    assert.match(publicOutput, /### Latest Residence, CMILib & Paper Versions/);
    assert.match(publicOutput, /\*\*\[Residence\]\(<https:\/\/zrips\.net\/Residence\/>\):\*\* `6\.0\.3\.0`/);
  } finally {
    service.stop();
    await service.flushPersistence();
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

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
    await assert.rejects(() => service.prepareReload(), /unsupported schema/i);
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

test("primary metadata rejects oversized streams without retrying and refuses redirects", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lookupbot-version-bounded-"));
  const catalogPath = path.join(workspaceRoot, "versions.json");
  const config = makeNetworkConfig(workspaceRoot);
  config.versions.retryMaxAttempts = 3;
  let calls = 0;
  const optionsSeen = [];
  const service = createVersionService(config, {
    logger: { info() {}, warn() {}, error() {} },
    sleep: async () => {},
    async fetch(_input, options) {
      calls += 1;
      optionsSeen.push(options);
      return new Response("x".repeat(1024 * 1024 + 1));
    },
  });

  try {
    await fs.writeFile(catalogPath, JSON.stringify(makeCatalog("generated")), "utf8");
    const snapshot = await service.start();

    assert.equal(snapshot.paper, null);
    assert.equal(snapshot.errorCount, 1);
    assert.equal(calls, 1);
    assert.ok(optionsSeen.every((options) => options.redirect === "error"));
  } finally {
    service.stop();
    await service.flushPersistence();
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("upstream version identifiers reject Discord injection while preserving prereleases", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lookupbot-version-safe-text-"));
  const catalogPath = path.join(workspaceRoot, "versions.json");
  const statePath = path.join(workspaceRoot, "logs/upstream-versions.json");
  const catalog = makeTrackedCatalog();
  const requests = [];
  const service = createVersionService(makeNetworkConfig(workspaceRoot), {
    logger: { info() {}, warn() {}, error() {} },
    async fetch(input, options) {
      const url = String(input);
      requests.push({ url, options });
      if (url.includes("fill.papermc.io")) {
        return Response.json([{ id: 87, channel: "STABLE" }]);
      }
      if (url.includes("/resources/3742/")) {
        return Response.json({ name: "1.2.3\n**[click](<https://evil.example>)** @everyone" });
      }
      if (url.includes("/resources/87610/")) {
        return Response.json({ name: "1.2.3-rc.1+build_7" });
      }
      if (url.startsWith("https://example.test/companions?")) {
        return new Response("file=CMIB1.1.0.jar");
      }
      throw new Error(`Unexpected test URL: ${url}`);
    },
  });

  try {
    await fs.writeFile(catalogPath, JSON.stringify(catalog), "utf8");
    const snapshot = await service.start();
    await service.flushPersistence();

    assert.equal(snapshot.plugins.has("cmi"), false);
    assert.equal(snapshot.plugins.get("cmilib").version, "1.2.3-rc.1+build_7");
    assert.equal(snapshot.errorCount, 1);
    assert.ok(requests.every((request) => request.options.redirect === "error"));
    assert.doesNotMatch(await fs.readFile(statePath, "utf8"), /evil\.example|@everyone|click/);

    assert.throws(
      () => formatPublicLatestVersions(snapshot, { id: "cmi", label: "CMI" }),
      /currently unavailable/i,
    );

    const poisonedSnapshot = {
      ...snapshot,
      plugins: new Map([
        ["cmi", { version: "1.2.3`\n[click](https://evil.example)", stale: false }],
        ["cmilib", { version: "1.2.3-rc.1+build_7", stale: false }],
      ]),
    };
    assert.throws(
      () => formatPublicLatestVersions(poisonedSnapshot, { id: "cmi", label: "CMI" }),
      /safe version identifier|safe inline version/i,
    );
  } finally {
    service.stop();
    await service.flushPersistence();
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("persisted poison is discarded without losing legitimate last-known siblings", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lookupbot-version-poisoned-state-"));
  const catalogPath = path.join(workspaceRoot, "versions.json");
  const statePath = path.join(workspaceRoot, "logs/upstream-versions.json");
  const service = createVersionService(makeNetworkConfig(workspaceRoot), {
    logger: { info() {}, warn() {}, error() {} },
    async fetch() {
      throw new TypeError("offline");
    },
    sleep: async () => {},
  });

  try {
    await fs.mkdir(path.dirname(statePath), { recursive: true });
    await fs.writeFile(catalogPath, JSON.stringify(makeTrackedCatalog()), "utf8");
    await fs.writeFile(
      statePath,
      JSON.stringify({
        schemaVersion: 1,
        savedAt: "2026-08-30T00:00:00.000Z",
        paper: { version: "26.3", build: 87, channel: "STABLE" },
        plugins: {
          cmi: { version: "1.0.0`\n# forged" },
          cmilib: { version: "1.0.0" },
        },
        companions: { "cmi-bungee": { version: "1.0.0" } },
      }),
      { mode: 0o600 },
    );

    const snapshot = await service.start();

    assert.equal(snapshot.plugins.has("cmi"), false);
    assert.equal(snapshot.plugins.get("cmilib").version, "1.0.0");
    assert.equal(snapshot.plugins.get("cmilib").stale, true);
    assert.equal(snapshot.companions.get("cmi-bungee").version, "1.0.0");
  } finally {
    service.stop();
    await service.flushPersistence();
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("primary version refreshes use bounded concurrency", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lookupbot-version-concurrency-"));
  const catalogPath = path.join(workspaceRoot, "versions.json");
  const catalog = makeCatalog("generated");
  catalog.plugins = Array.from({ length: 12 }, (_, index) => ({
    id: `plugin-${index}`,
    label: `Plugin ${index}`,
    version: "1.0.0",
    resourceId: 10_000 + index,
  }));
  let active = 0;
  let peak = 0;
  const service = createVersionService(makeNetworkConfig(workspaceRoot), {
    async fetch(input) {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return String(input).includes("fill.papermc.io")
        ? Response.json([{ id: 87, channel: "STABLE" }])
        : Response.json({ name: "1.1.0" });
    },
  });

  try {
    await fs.writeFile(catalogPath, JSON.stringify(catalog), "utf8");
    const snapshot = await service.start();

    assert.equal(snapshot.errorCount, 0);
    assert.equal(snapshot.paper.build, 87);
    assert.ok(peak > 1);
    assert.ok(peak <= 4, `expected at most four concurrent fetches, saw ${peak}`);
  } finally {
    service.stop();
    await service.flushPersistence();
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

async function createPaperFixture(t, versionOptions = {}) {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lookupbot-paper-stable-"));
  const config = makeNetworkConfig(workspaceRoot);
  Object.assign(config.versions, versionOptions);
  const upstream = createFetchFixture(t);
  const catalog = makeTrackedCatalog(new Date().toISOString());
  catalog.paper.version = config.versions.paperVersion;
  catalog.paper.channel = config.versions.paperChannels[0];
  catalog.paper.build = upstream.paperBuild;
  for (const plugin of catalog.plugins) {
    plugin.version = "1.0.0";
  }
  await fs.writeFile(path.join(workspaceRoot, "versions.json"), JSON.stringify(catalog), "utf8");
  const services = [];
  const createService = () => {
    const service = createVersionService(config, { logger: SILENT_LOGGER });
    services.push(service);
    return service;
  };
  t.after(async () => {
    for (const service of services) {
      service.stop();
      await service.flushPersistence();
    }
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });
  return { workspaceRoot, config, upstream, createService, service: createService() };
}

test("latest shows one tracked stable Paper release in every scope without public snapshot details", async (t) => {
  const { service, upstream } = await createPaperFixture(t);
  const snapshot = await service.start();
  assert.equal(snapshot.paper.version, "26.3");
  assert.equal(snapshot.paper.build, 87);
  assert.equal(snapshot.paper.channel, "STABLE");
  assert.equal(snapshot.paper.stale, false);
  assert.equal(snapshot.paperPreview, undefined);
  assert.equal(snapshot.paperStable, undefined);
  assert.deepEqual(upstream.requests.filter((url) => url.startsWith(PAPER_API_ROOT)), [
    `${PAPER_API_ROOT}/versions/26.3/builds`,
  ]);
  const plugin = { id: "cmi", label: "CMI" };
  for (const scope of ["context", "all"]) {
    const output = formatLatestVersionMessages(snapshot, plugin, scope).join("\n");
    assert.match(output, /upstream `26\.3 build 87 STABLE` \(current\)/);
    assert.equal(output.split("\n").filter((line) => line.startsWith("- **") && line.includes("Paper")).length, 1);
    assert.doesNotMatch(output, /beta|experimental|26\.2/i);
  }
  const output = formatPublicLatestVersions(snapshot, plugin);
  assert.match(output, /Paper:\*\* stable `26\.3 build 87`/);
  assert.equal((output.match(/Paper:\*\*/g) ?? []).length, 1);
  assert.doesNotMatch(output, /beta|experimental|26\.2|clean snapshot|Clean data generated|Upstream refresh attempted|<t:/i);
  assert.equal(evaluateAttention(snapshot).needsAttention, false);
  assert.deepEqual(getVersionAttentionSummary(snapshot).updateKeys, []);
  assert.equal(snapshot.errorCount, 0);
  const requestCount = upstream.requests.length;
  const changes = await service.getVersionChanges(plugin, "all");
  assert.deepEqual(changes.changes, []);
  assert.equal(upstream.requests.length, requestCount);
});

test("Paper selects the highest valid stable build only within the tracked version", async (t) => {
  const { service, upstream } = await createPaperFixture(t);
  upstream.paperBuildsByVersion["26.3"] = [
    { id: 175, channel: "STABLE" }, { id: 999, channel: "BETA" },
    { id: 1000, channel: "ALPHA" }, { id: -1, channel: "STABLE" },
    { id: "invalid", channel: "STABLE" }, { id: 176, channel: "STABLE" },
    { id: Number.MAX_SAFE_INTEGER + 1, channel: "STABLE" },
  ];
  upstream.paperBuildsByVersion["26.2"] = [{ id: 200, channel: "STABLE" }];
  upstream.paperBuildsByVersion["26.4"] = [{ id: 10, channel: "STABLE" }];
  const snapshot = await service.start();
  assert.equal(snapshot.paper.build, 176);
  assert.equal(snapshot.paper.channel, "STABLE");
  assert.deepEqual(getVersionAttentionSummary(snapshot).updateKeys, ["paper"]);
  assert.deepEqual(upstream.requests.filter((url) => url.startsWith(PAPER_API_ROOT)), [
    `${PAPER_API_ROOT}/versions/26.3/builds`,
  ]);
  assert.match(formatPublicLatestVersions(snapshot, { id: "cmi" }), /stable `26\.3 build 176`/);
});

test("Paper unavailability never falls back to another version or a preview", async (t) => {
  const { service, upstream, workspaceRoot } = await createPaperFixture(t);
  const statePath = path.join(workspaceRoot, "logs/upstream-versions.json");
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await fs.writeFile(statePath, JSON.stringify({
    schemaVersion: 1,
    paper: { version: "26.3", build: 174, channel: "BETA" },
    paperStable: { version: "26.2", build: 129, channel: "STABLE" },
    paperPreview: { version: "26.3", build: 174, channel: "BETA" },
  }));
  upstream.paperBuildsByVersion["26.3"] = [{ id: 174, channel: "BETA" }];
  const snapshot = await service.start();
  assert.equal(snapshot.paper, null);
  assert.equal(snapshot.errorCount, 1);
  assert.deepEqual(getVersionAttentionSummary(snapshot).unavailableKeys, ["paper"]);
  const output = formatPublicLatestVersions(snapshot, { id: "cmi" });
  assert.match(output, /Paper:\*\* stable \(upstream unavailable\)/);
  assert.doesNotMatch(output, /26\.2|BETA|beta|174/);
  await service.flushPersistence();
  const persisted = JSON.parse(await fs.readFile(statePath, "utf8"));
  assert.equal(persisted.paper, null);
  assert.equal(persisted.paperStable, undefined);
  assert.equal(persisted.paperPreview, undefined);
});

test("matching legacy stable history migrates with its exact download during an outage", async (t) => {
  const { service, upstream, workspaceRoot } = await createPaperFixture(t);
  const stable = makePaperBuild("26.3", 175, "STABLE");
  const statePath = path.join(workspaceRoot, "logs/upstream-versions.json");
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await fs.writeFile(statePath, JSON.stringify({
    schemaVersion: 1,
    paper: { version: "26.3", build: 175, channel: "STABLE" },
    paperStable: { version: "26.3", build: 175, channel: "STABLE", downloadUrl: stable.downloads["server:default"].url },
    paperPreview: { version: "26.3", build: 174, channel: "BETA" },
  }));
  upstream.failures.add("paper");
  const snapshot = await service.start();
  assert.equal(snapshot.paper.build, 175);
  assert.equal(snapshot.paper.stale, true);
  assert.equal(snapshot.paper.downloadUrl, stable.downloads["server:default"].url);
  assert.match(formatPublicLatestVersions(snapshot, { id: "cmi" }), /last known; live refresh unavailable/);
  await service.flushPersistence();
  const persisted = JSON.parse(await fs.readFile(statePath, "utf8"));
  assert.equal(persisted.paper.build, 175);
  assert.equal(persisted.paperPreview, undefined);
  assert.equal(persisted.paperStable, undefined);
});

test("Paper outages retain matching stable history and downloads across restart and recover together", async (t) => {
  const { service, createService, upstream, workspaceRoot } = await createPaperFixture(t);
  const stable = makePaperBuild("26.3", 175, "STABLE");
  const stableUrl = stable.downloads["server:default"].url;
  upstream.paperBuildsByVersion["26.3"] = [stable];
  const initial = await service.start();
  service.stop();
  await service.flushPersistence();
  assert.equal(JSON.parse(await fs.readFile(path.join(workspaceRoot, "logs/upstream-versions.json"), "utf8")).paper.downloadUrl, stableUrl);
  upstream.failures.add("paper");
  const restarted = createService();
  const retained = await restarted.start();
  assert.equal(retained.paper.build, 175);
  assert.equal(retained.paper.stale, true);
  assert.equal(retained.paper.lastSuccessfulCheckAt, initial.paper.lastSuccessfulCheckAt);
  assert.ok(formatPublicLatestVersions(retained, { id: "cmi" }).includes(stableUrl));
  assert.match(formatPublicLatestVersions(retained, { id: "cmi" }), /last known; live refresh unavailable/);
  upstream.failures.clear();
  const newer = makePaperBuild("26.3", 176, "STABLE", "b");
  upstream.paperBuildsByVersion["26.3"] = [newer];
  const recovered = await restarted.refreshUpstream();
  assert.equal(recovered.paper.build, 176);
  assert.equal(recovered.paper.stale, false);
  assert.equal(recovered.paper.downloadUrl, newer.downloads["server:default"].url);
  assert.ok(!formatPublicLatestVersions(recovered, { id: "cmi" }).includes(stableUrl));
  upstream.paperBuildsByVersion["26.3"] = [{ id: 177, channel: "STABLE" }];
  const missingLink = await restarted.refreshUpstream();
  assert.equal(missingLink.paper.downloadUrl, undefined);
  assert.match(formatPublicLatestVersions(missingLink, { id: "cmi" }), /Paper:\*\* stable `26\.3 build 177`/);
});

test("missing Paper history and disabled upstream checks remain explicit", async (t) => {
  const { service, createService, upstream, config } = await createPaperFixture(t);
  upstream.failures.add("paper");
  const unavailable = await service.start();
  assert.equal(unavailable.paper, null);
  assert.match(formatPublicLatestVersions(unavailable, { id: "cmi" }), /stable \(upstream unavailable\)/);
  assert.doesNotMatch(formatLatestVersions(unavailable, { id: "cmi" }), /beta|preview/i);
  config.versions.checkEnabled = false;
  const disabled = await createService().start();
  assert.match(formatLatestVersions(disabled, { id: "cmi" }), /upstream checks disabled/);
  assert.throws(() => formatPublicLatestVersions(disabled, { id: "cmi" }), /disabled/);
});

test("malformed or oversized Paper metadata cannot replace matching stable history", async (t) => {
  const { service, upstream } = await createPaperFixture(t, { circuitFailureThreshold: 100 });
  await service.start();
  for (const builds of [{ builds: [] }, [], Array(5001).fill({ id: 999, channel: "STABLE" }), [{ id: "invalid", channel: "STABLE" }]]) {
    upstream.paperBuildsByVersion["26.3"] = builds;
    const snapshot = await service.refreshUpstream();
    assert.equal(snapshot.paper.build, 87);
    assert.equal(snapshot.paper.stale, true);
    assert.equal(snapshot.errorCount, 1);
  }
});

test("Paper reloads remain staged until the version transaction commits", async (t) => {
  const { service, upstream } = await createPaperFixture(t);
  await service.start();
  upstream.paperBuild = 88;
  const discarded = await service.prepareReload();
  assert.equal(discarded.snapshot.paper.build, 88);
  assert.equal(service.getSnapshot().paper.build, 87);
  discarded.discard();
  assert.equal(service.getSnapshot().paper.build, 87);
  const committed = await service.prepareReload();
  committed.commit();
  assert.equal(service.getSnapshot().paper.build, 88);
});

test("public Paper output rejects unsafe, preview, and wrong-version metadata", async (t) => {
  const { service } = await createPaperFixture(t);
  const snapshot = await service.start();
  for (const paper of [
    { version: "26.3` @everyone", build: 175, channel: "STABLE" },
    { version: "26.3", build: "invalid", channel: "STABLE" },
    { version: "26.3", build: 174, channel: "BETA" },
    { version: "26.2", build: 129, channel: "STABLE" },
    { version: "26.4-rc-1", build: 2, channel: "STABLE" },
  ]) {
    assert.throws(() => formatPublicLatestVersions({ ...snapshot, paper }, { id: "cmi" }), /metadata|safe version|safe integer/);
  }
});

test("public Paper links only to the selected stable JAR, even when a newer preview exists", async (t) => {
  const { service, upstream } = await createPaperFixture(t);
  const stable = makePaperBuild("26.3", 175, "STABLE");
  const beta = makePaperBuild("26.3", 176, "BETA", "b");
  upstream.paperBuildsByVersion["26.3"] = [beta, stable];
  const snapshot = await service.start();
  const output = formatPublicLatestVersions(snapshot, { id: "cmi" });
  assert.ok(output.includes(`- **[Paper](<${stable.downloads["server:default"].url}>):** stable ` + "`26.3 build 175`"));
  assert.ok(!output.includes(beta.downloads["server:default"].url));
  assert.equal((output.match(/\[Paper\]/g) ?? []).length, 1);
});

test("unsafe, unofficial and mismatched Paper download URLs never become public links", async (t) => {
  const { service, upstream, workspaceRoot } = await createPaperFixture(t);
  const stable = makePaperBuild("26.3", 87, "STABLE");
  const validUrl = stable.downloads["server:default"].url;
  await service.start();
  for (const url of [
    undefined, null, 42, {}, "",
    validUrl.replace("https:", "http:"),
    validUrl.replace("fill-data.papermc.io", "evil.example"),
    validUrl.replace("fill-data.papermc.io", "fill-data.papermc.io.evil.example"),
    validUrl.replace("fill-data.papermc.io", "user@fill-data.papermc.io"),
    validUrl.replace("fill-data.papermc.io", "fill-data.papermc.io:444"),
    validUrl.replace("paper-26.3-87.jar", "paper-26.3-143.jar"),
    validUrl.replace("paper-26.3-87.jar", "paper-26.3-88.jar"),
    validUrl.replace("/v1/objects/", "/v1/../v1/objects/"),
    validUrl.replace("paper-26.3", "paper-26%2e3"),
    validUrl.replace("a".repeat(64), "not-a-sha256"),
    `${validUrl}?download=latest`, `${validUrl}#fragment`,
    `${validUrl}\n`, `${validUrl}\r\n`, `${validUrl}>)[click](<https://evil.example>) @everyone`,
    "https://fill-data.papermc.io/" + "a".repeat(600),
  ]) {
    upstream.paperBuildsByVersion["26.3"] = [{ ...stable, downloads: { "server:default": { url } } }];
    const snapshot = await service.refreshUpstream();
    assert.equal(snapshot.paper.build, 87);
    assert.equal(snapshot.paper.stale, false);
    assert.equal(snapshot.paper.downloadUrl, undefined);
    const output = formatPublicLatestVersions(snapshot, { id: "cmi", label: "CMI" });
    assert.doesNotMatch(output, /\[Paper\]|evil\.example|@everyone|fill-data/);
    const poisoned = { ...snapshot, paper: { ...snapshot.paper, downloadUrl: url } };
    assert.doesNotMatch(formatPublicLatestVersions(poisoned, { id: "cmi", label: "CMI" }), /\[Paper\]|evil\.example|@everyone|fill-data/);
    assert.doesNotMatch(await fs.readFile(path.join(workspaceRoot, "logs/upstream-versions.json"), "utf8"), /downloadUrl|evil\.example|@everyone/);
  }
});

test("persisted Paper download links are revalidated without discarding safe version history", async (t) => {
  const { service, upstream, workspaceRoot } = await createPaperFixture(t);
  const statePath = path.join(workspaceRoot, "logs/upstream-versions.json");
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await fs.writeFile(statePath, JSON.stringify({
    schemaVersion: 1,
    paper: { version: "26.3", build: 87, channel: "STABLE", downloadUrl: "https://evil.example/download.jar" },
    plugins: {}, companions: {},
  }), { mode: 0o600 });
  upstream.failures.add("paper");
  const snapshot = await service.start();
  await service.flushPersistence();
  assert.equal(snapshot.paper.build, 87);
  assert.equal(snapshot.paper.downloadUrl, undefined);
  const output = formatPublicLatestVersions(snapshot, { id: "cmi", label: "CMI" });
  assert.match(output, /last known; live refresh unavailable/);
  assert.doesNotMatch(output, /\[Paper\]|evil\.example|fill-data/);
  assert.doesNotMatch(await fs.readFile(statePath, "utf8"), /downloadUrl|evil\.example|fill-data/);
});
