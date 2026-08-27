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
    runtimeInfo: {
      startedAt: new Date("2026-08-27T09:00:00.000Z"),
      release: "0.1.0 (abcdef123456)",
    },
    startupState: { ready: true },
    now: new Date("2026-08-27T10:00:00.000Z").getTime(),
  });

  assert.match(message, /Overall: `healthy`/);
  assert.match(message, /Release: `0\.1\.0 \(abcdef123456\)`/);
  assert.match(message, /Discord: `connected \(42 ms gateway latency\)`/);
  assert.match(message, /Search cache: `ready, 100 entries from 4 files`/);
  assert.match(message, /Upstream checks: `healthy`/);
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

    const release = await createRuntimeInfo(workspaceRoot, {
      configuredRelease: "abcdef1234567890",
      startedAt: new Date("2026-08-27T09:00:00.000Z"),
    });
    assert.equal(release.release, "1.2.3 (abcdef123456)");

    const ignored = await createRuntimeInfo(workspaceRoot, {
      configuredRelease: "private-host-alias",
    });
    assert.equal(ignored.release, "1.2.3");
    assert.doesNotMatch(ignored.release, /private-host-alias/);
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});
