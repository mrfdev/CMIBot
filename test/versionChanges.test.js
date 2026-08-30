import assert from "node:assert/strict";
import test from "node:test";
import {
  createVersionChangesService,
  formatVersionChanges,
} from "../src/versionChanges.js";

function makeConfig() {
  return {
    versions: {
      checkIntervalMs: 60_000,
      requestTimeoutMs: 1_000,
      retryMaxAttempts: 1,
      retryBaseDelayMs: 0,
      retryMaxDelayMs: 0,
      circuitFailureThreshold: 3,
      circuitCooldownMs: 60_000,
    },
  };
}

function makeSnapshot() {
  const catalog = {
    paper: {
      id: "paper",
      label: "Paper",
      version: "26.2",
      build: 112,
      projectUrl: "https://papermc.io/downloads/paper",
    },
    plugins: [
      {
        id: "cmi",
        label: "CMI",
        version: "1.0.0",
        contextId: "cmi",
        resourceId: 100,
        resourceUrl: "https://www.spigotmc.org/resources/100/",
      },
      {
        id: "cmilib",
        label: "CMILib",
        version: "1.0.0",
        shared: true,
        resourceId: 101,
      },
      {
        id: "luckperms",
        label: "LuckPerms",
        version: "5.5.77",
        contextId: null,
        versionSource: {
          type: "luckperms-metadata",
          url: "https://metadata.luckperms.net/data/all",
        },
      },
      {
        id: "placeholderapi",
        label: "PlaceholderAPI",
        version: "2.12.2",
        contextId: null,
        releaseNotesSource: {
          type: "github-releases",
          repository: "PlaceholderAPI/PlaceholderAPI",
        },
      },
    ],
    companions: [
      {
        id: "cmi-bungee",
        label: "CMI-Bungee",
        version: "1.0.0",
        resourceUrl: "https://www.zrips.net/cmib/",
        versionSource: {
          type: "zrips-listing",
          url: "https://www.zrips.net/cmib/",
          filePrefix: "CMIB-",
        },
      },
    ],
  };
  return {
    catalog,
    checkEnabled: true,
    paper: { version: "26.2", build: 119, channel: "STABLE", stale: false },
    plugins: new Map([
      ["cmi", { version: "1.2.0", stale: false }],
      ["cmilib", { version: "1.0.0", stale: false }],
      ["luckperms", { version: "5.5.79", stale: false }],
      ["placeholderapi", { version: "2.12.3", build: 270, stale: false }],
    ]),
    companions: new Map([
      ["cmi-bungee", { version: "1.1.0", stale: false }],
    ]),
  };
}

function jsonResponse(value, { status = 200, contentLength = null } = {}) {
  const text = JSON.stringify(value);
  return new Response(text, {
    status,
    headers: contentLength == null ? {} : { "content-length": String(contentLength) },
  });
}

test("version changes combine trusted providers, sanitize text, and cache exact version pairs", async () => {
  const snapshot = makeSnapshot();
  snapshot.catalog.plugins.find((entry) => entry.id === "luckperms").versionSource.url =
    "https://untrusted.example/private";
  const calls = [];
  const service = createVersionChangesService(makeConfig(), {
    now: () => 1_000,
    async fetch(input, options) {
      const url = String(input);
      calls.push(url);
      assert.equal(options.redirect, "error");
      if (url.includes("api.spiget.org")) {
        const description = Buffer.from(
          [
            "<ul>",
            "<li><b>Added</b> safer teleports for @everyone</li>",
            "<li>Fixed chat formatting; see https://evil.example/path</li>",
            "<li>Improved item frames</li>",
            "<li>Reduced allocations</li>",
            "<li>Updated translations</li>",
            "<script>must-not-appear</script>",
            "</ul>",
          ].join(""),
        ).toString("base64");
        return jsonResponse([
          { id: 12, title: "1.2.0", description },
          { id: 11, title: "1.0.0", description },
        ]);
      }
      if (url.includes("metadata.luckperms.net")) {
        return jsonResponse({
          changeLog: [
            {
              version: "5.5.79",
              title: "Fix permission handling",
              commit: "a".repeat(40),
            },
            {
              version: "5.5.78",
              title: "Improve bulk user loads",
              commit: "b".repeat(40),
            },
            {
              version: "5.5.77",
              title: "Already installed",
              commit: "c".repeat(40),
            },
          ],
        });
      }
      if (url.includes("api.github.com/repos/PlaceholderAPI/PlaceholderAPI/releases")) {
        return jsonResponse([
          {
            tag_name: "2.12.3",
            body: [
              "## Notable changes",
              "Fixed version parsing [details](https://evil.example)",
              "Added safer component support",
            ].join("\n"),
          },
        ]);
      }
      if (url.includes("fill.papermc.io")) {
        return jsonResponse([
          {
            id: 119,
            commits: [
              {
                sha: "d".repeat(40),
                message: "Bump integration and avoid `unsafe` output",
              },
            ],
          },
          { id: 112, commits: [{ sha: "e".repeat(40), message: "Already installed" }] },
        ]);
      }
      throw new Error("Unexpected release provider");
    },
  });

  const report = await service.resolve(snapshot, { id: "cmi", label: "CMI" }, "all");
  assert.equal(report.status, "ready");
  assert.deepEqual(
    report.changes.map((change) => change.id),
    ["cmi", "luckperms", "placeholderapi", "paper", "cmi-bungee"],
  );
  assert.equal(report.errorCount, 0);
  assert.equal(calls.length, 4);
  assert.ok(calls.includes("https://metadata.luckperms.net/data/all"));
  assert.equal(calls.some((url) => url.includes("untrusted.example")), false);

  const cmi = report.changes[0];
  assert.equal(cmi.releases[0].version, "1.2.0");
  assert.equal(cmi.releases[0].items.length, 4);
  assert.equal(cmi.releases[0].omittedItemCount, 1);
  assert.equal(cmi.releases.some((release) => release.version === "1.0.0"), false);

  const luckPerms = report.changes.find((change) => change.id === "luckperms");
  assert.deepEqual(
    luckPerms.releases.map((release) => release.version),
    ["5.5.79", "5.5.78"],
  );
  const companion = report.changes.find((change) => change.id === "cmi-bungee");
  assert.equal(companion.status, "link-only");

  const message = formatVersionChanges(report);
  assert.match(message, /### Version Changes/);
  assert.match(message, /`1\.0\.0` → `1\.2\.0`/);
  assert.match(message, /github\.com\/LuckPerms\/LuckPerms\/commit\/a{40}/);
  assert.match(message, /open release history/);
  assert.doesNotMatch(message, /@everyone|must-not-appear|evil\.example|<script>|`unsafe`/);
  assert.match(message, /@\u200beveryone/);

  await service.resolve(snapshot, { id: "cmi", label: "CMI" }, "all");
  assert.equal(calls.length, 4);
});

test("context-scoped changes do not fetch unrelated resources", async () => {
  const snapshot = makeSnapshot();
  snapshot.catalog.paper.build = 119;
  snapshot.catalog.plugins[0].version = "1.2.0";
  snapshot.catalog.plugins.push({
    id: "jobs",
    label: "Jobs",
    version: "1.0.0",
    contextId: "jobs",
    resourceId: 200,
  });
  snapshot.plugins.set("jobs", { version: "1.1.0", stale: false });
  let calls = 0;
  const service = createVersionChangesService(makeConfig(), {
    async fetch() {
      calls += 1;
      throw new Error("Unrelated resources must not be fetched");
    },
  });

  const report = await service.resolve(snapshot, { id: "cmi", label: "CMI" }, "context");
  assert.deepEqual(report.changes, []);
  assert.equal(calls, 0);
  assert.match(formatVersionChanges(report), /No tracked version changes are pending/);
});

test("Paper version transitions compare builds within the new version", async () => {
  const snapshot = makeSnapshot();
  snapshot.catalog.paper.version = "26.1";
  snapshot.catalog.paper.build = 200;
  snapshot.paper = { version: "26.2", build: 2, channel: "STABLE", stale: false };
  snapshot.catalog.plugins[0].version = "1.2.0";
  let requestedUrl = "";
  const service = createVersionChangesService(makeConfig(), {
    async fetch(input) {
      requestedUrl = String(input);
      return jsonResponse([
        { id: 2, commits: [{ sha: "a".repeat(40), message: "Second build" }] },
        { id: 1, commits: [{ sha: "b".repeat(40), message: "First build" }] },
      ]);
    },
  });

  const report = await service.resolve(snapshot, { id: "cmi", label: "CMI" }, "context");
  assert.match(requestedUrl, /\/versions\/26\.2\/builds$/);
  assert.deepEqual(
    report.changes.find((change) => change.id === "paper").releases.map((release) => release.version),
    ["26.2 build 2", "26.2 build 1"],
  );
});

test("release-note failures preserve the version diff with a generic fallback", async () => {
  const snapshot = makeSnapshot();
  snapshot.catalog.paper.build = 119;
  snapshot.catalog.plugins = [snapshot.catalog.plugins[0]];
  snapshot.plugins = new Map([["cmi", { version: "1.2.0", stale: true }]]);
  snapshot.catalog.companions = [];
  snapshot.companions = new Map();
  const service = createVersionChangesService(makeConfig(), {
    async fetch() {
      return jsonResponse({}, { status: 503 });
    },
  });

  const report = await service.resolve(snapshot, { id: "cmi", label: "CMI" }, "context");
  assert.equal(report.changes.length, 1);
  assert.equal(report.errorCount, 1);
  assert.equal(report.changes[0].status, "unavailable");
  const message = formatVersionChanges(report);
  assert.match(message, /`1\.0\.0` → `1\.2\.0`/);
  assert.match(message, /temporarily unavailable/);
  assert.match(message, /latest is last known/);
  assert.doesNotMatch(message, /503|Upstream request/);
});

test("version change reports explain unavailable catalogs and disabled checks", async () => {
  const service = createVersionChangesService(makeConfig(), {
    async fetch() {
      throw new Error("No fetch expected");
    },
  });
  const missing = await service.resolve(
    { catalog: null, checkEnabled: true },
    { id: "cmi", label: "CMI" },
  );
  assert.match(formatVersionChanges(missing), /catalog is not available/i);

  const disabled = await service.resolve(
    { ...makeSnapshot(), checkEnabled: false },
    { id: "cmi", label: "CMI" },
  );
  assert.match(formatVersionChanges(disabled), /checks are disabled/i);
});

test("release-note responses and rendered links fail closed at their safety boundaries", async () => {
  const snapshot = makeSnapshot();
  snapshot.catalog.paper.build = 119;
  snapshot.catalog.plugins = [snapshot.catalog.plugins[0]];
  snapshot.plugins = new Map([["cmi", { version: "1.2.0", stale: false }]]);
  snapshot.catalog.companions = [];
  snapshot.companions = new Map();
  const service = createVersionChangesService(makeConfig(), {
    async fetch() {
      return jsonResponse([], { contentLength: 2 * 1024 * 1024 });
    },
  });
  const oversized = await service.resolve(
    snapshot,
    { id: "cmi", label: "CMI" },
    "context",
  );
  assert.equal(oversized.errorCount, 1);

  const streamedService = createVersionChangesService(makeConfig(), {
    async fetch() {
      return new Response(`{\"padding\":\"${"x".repeat(1024 * 1024)}\"}`);
    },
  });
  const streamedOversized = await streamedService.resolve(
    snapshot,
    { id: "cmi", label: "CMI" },
    "context",
  );
  assert.equal(streamedOversized.errorCount, 1);

  const message = formatVersionChanges({
    status: "ready",
    scope: "context",
    pluginLabel: "CMI",
    changes: [
      {
        id: "cmi",
        label: "CMI",
        current: "1.0.0",
        latest: "1.1.0",
        upstream: { stale: false },
        historyUrl: "https://untrusted.example/history",
        status: "available",
        releases: [
          {
            version: "1.1.0",
            url: "https://untrusted.example/release",
            items: [
              {
                text: "Safe text",
                url: "https://untrusted.example/commit",
              },
            ],
            omittedItemCount: 0,
          },
        ],
      },
    ],
    omittedResourceCount: 0,
    errorCount: 0,
  });
  assert.match(message, /Safe text/);
  assert.doesNotMatch(message, /untrusted\.example/);

  const poisonedReport = {
    ...reportForFormatting("1.2.3-rc.1+build_7"),
    changes: [
      {
        ...reportForFormatting("1.2.3-rc.1+build_7").changes[0],
        latest: "1.2.3`\n[click](https://evil.example)",
      },
    ],
  };
  assert.throws(() => formatVersionChanges(poisonedReport), /safe inline version/i);
  assert.match(formatVersionChanges(reportForFormatting("1.2.3-rc.1+build_7")), /1\.2\.3-rc\.1\+build_7/);
});

function reportForFormatting(latest) {
  return {
    status: "ready",
    scope: "context",
    pluginLabel: "CMI",
    changes: [
      {
        id: "cmi",
        label: "CMI",
        current: "1.0.0",
        latest,
        upstream: { stale: false },
        historyUrl: "",
        status: "link-only",
        releases: [],
      },
    ],
    omittedResourceCount: 0,
    errorCount: 0,
  };
}
