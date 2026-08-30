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
  getVersionAttentionSummary,
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

    if (url.includes("fill.papermc.io")) {
      key = "paper";
      body = [{ id: state.paperBuild, channel: "STABLE" }];
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

    if (state.failures.has(key)) {
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
    paper: { version: "26.2", build: 87, stale: false },
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
    async fetch() {
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
    assert.match(publicOutput, /### Latest Residence & CMILib Versions/);
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
    assert.equal(optionsSeen[0].redirect, "error");
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
        paper: { version: "26.2", build: 87, channel: "STABLE" },
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
    assert.ok(peak > 1);
    assert.ok(peak <= 4, `expected at most four concurrent fetches, saw ${peak}`);
  } finally {
    service.stop();
    await service.flushPersistence();
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});
