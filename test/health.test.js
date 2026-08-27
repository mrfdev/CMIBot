import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { formatHealthMessage } from "../src/discord/health.js";
import { createRuntimeInfo } from "../src/runtimeInfo.js";

test("health output reports readiness without infrastructure identifiers", () => {
  const privateValues = ["private-host-alias", "/Users/private/service", "123456789012345678"];
  const message = formatHealthMessage({
    config: {
      workspaceRoot: privateValues[1],
      discord: {
        pluginChannelIds: { cmi: [privateValues[2]] },
      },
      plugins: {
        cmi: { id: "cmi", label: "CMI" },
      },
    },
    searchCache: {
      getGlobalSummary() {
        return {
          totalEntries: 100,
          totalFiles: 4,
          pluginSummaries: [{ pluginId: "cmi" }],
          lastReloadedAt: new Date("2026-08-27T09:55:00.000Z"),
        };
      },
      getResultCacheSummary() {
        return {
          entries: 8,
          maxEntries: 256,
          hits: 12,
          misses: 4,
          evictions: 0,
        };
      },
      getDerivedIndexSummary() {
        return {
          enabled: true,
          hits: 12,
          rebuilds: 3,
          forcedRebuilds: 1,
          rejectedArtifacts: 1,
          writeFailures: 0,
        };
      },
    },
    versionService: {
      getSnapshot() {
        return {
          catalog: {
            generatedAt: "2026-08-27T09:45:00.000Z",
            plugins: [{ id: "cmi" }],
          },
          checkEnabled: true,
          checkedAt: "2026-08-27T09:59:00.000Z",
          errorCount: 0,
          retainedCount: 0,
        };
      },
    },
    client: {
      isReady: () => true,
      ws: { ping: 42 },
    },
    metrics: {
      getSnapshot() {
        return {
          commands: { count: 4, p95Ms: 50, outcomes: { error: 1 } },
          searches: { count: 3, p95Ms: 25, results: { returned: 7 } },
          reloads: { count: 1, p95Ms: 500 },
          ai: { count: 1, tokens: { total: 30 } },
          upstream: {
            checks: { retries: 2, circuitOpenings: 1, circuitRejections: 3 },
          },
          memory: { rssBytes: 10 * 1024 * 1024, heapUsedBytes: 4 * 1024 * 1024 },
        };
      },
    },
    runtimeInfo: {
      startedAt: new Date("2026-08-27T09:00:00.000Z"),
      release: "0.1.0 (abcdef123456)",
    },
    startupState: { ready: true },
    serviceLogs: {
      getSnapshot() {
        return {
          maxBytesPerFile: 10 * 1024 * 1024,
          maxArchivesPerStream: 5,
          droppedWrites: 0,
        };
      },
    },
    now: new Date("2026-08-27T10:00:00.000Z").getTime(),
  });

  assert.match(message, /Overall: `healthy`/);
  assert.match(message, /Release: `0\.1\.0 \(abcdef123456\)`/);
  assert.match(message, /Discord: `connected \(42 ms gateway latency\)`/);
  assert.match(message, /Search cache: `ready, 100 entries from 4 files`/);
  assert.match(message, /Repeated-search LRU: `8\/256 entries, 12 hits, 4 misses, 0 evictions`/);
  assert.match(message, /Derived indexes: `12 reused, 3 rebuilt \(1 forced\), 1 rejected, 0 write failures`/);
  assert.match(message, /Upstream checks: `healthy`/);
  assert.match(message, /Commands: `4 observed, p95 50 ms, 1 errors`/);
  assert.match(message, /Upstream resilience: `retries: 2, circuits opened: 1, requests skipped: 3`/);
  assert.match(message, /Service logs: `bounded to 10 MiB per stream with 5 archives; 0 writes dropped`/);
  for (const privateValue of privateValues) {
    assert.doesNotMatch(message, new RegExp(privateValue.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("runtime release metadata accepts commit IDs but ignores arbitrary labels", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lookupbot-runtime-info-"));
  try {
    await fs.writeFile(
      path.join(workspaceRoot, "package.json"),
      JSON.stringify({ version: "1.2.3" }),
      "utf8",
    );

    const fullRevision = "abcdef1234567890abcdef1234567890abcdef12";
    const release = await createRuntimeInfo(workspaceRoot, {
      configuredRelease: fullRevision,
      startedAt: new Date("2026-08-27T09:00:00.000Z"),
    });
    assert.equal(release.release, "1.2.3 (abcdef123456)");
    assert.equal(release.revision, "abcdef123456");
    assert.equal(release.fullRevision, fullRevision);

    const abbreviated = await createRuntimeInfo(workspaceRoot, {
      configuredRelease: "abcdef1234567890",
    });
    assert.equal(abbreviated.release, "1.2.3 (abcdef123456)");
    assert.equal(abbreviated.fullRevision, "");

    const ignored = await createRuntimeInfo(workspaceRoot, {
      configuredRelease: "private-host-alias",
    });
    assert.equal(ignored.release, "1.2.3");
    assert.doesNotMatch(ignored.release, /private-host-alias/);
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});
