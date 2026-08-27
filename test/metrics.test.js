import assert from "node:assert/strict";
import test from "node:test";
import { createMetricsRegistry } from "../src/metrics.js";

test("metrics retain bounded aggregates without query or identity labels", () => {
  let currentTime = 1_000;
  const metrics = createMetricsRegistry({
    now: () => currentTime,
    memoryUsage: () => ({ rss: 1_024, heapUsed: 512, heapTotal: 768, external: 64 }),
  });

  metrics.recordCommand({ durationMs: 12, outcome: "success", userId: "private-user" });
  metrics.recordCommand({ durationMs: 31, outcome: "unexpected-error" });
  metrics.recordSearch({
    durationMs: 101,
    outcome: "success",
    resultCount: 3,
    candidateCount: 12,
    cacheStatus: "miss",
    cacheEvicted: true,
    query: "private query",
  });
  metrics.recordReload({ durationMs: 600, outcome: "success", scope: "profile", pluginId: "private" });
  metrics.recordAi({
    durationMs: 900,
    outcome: "success",
    operation: "summary",
    inputTokens: 20,
    outputTokens: 10,
    totalTokens: 30,
  });
  metrics.recordUpstream({ durationMs: 2_000, outcome: "error", resourceCount: 9, errorCount: 1, retainedCount: 1 });
  metrics.recordUpstreamRetry();
  metrics.recordUpstreamCircuit({ outcome: "opened" });
  metrics.recordUpstreamCircuit({ outcome: "rejected" });
  metrics.recordUpstreamCircuit({ outcome: "closed" });
  metrics.observeLogRecord({ level: "error", event: "discord.client_error" });
  currentTime = 2_500;

  const snapshot = metrics.getSnapshot();
  assert.equal(snapshot.uptimeMs, 1_500);
  assert.equal(snapshot.commands.count, 2);
  assert.equal(snapshot.commands.p95Ms, 50);
  assert.equal(snapshot.commands.outcomes.error, 1);
  assert.deepEqual(snapshot.searches.results, { returned: 3, candidates: 12 });
  assert.deepEqual(snapshot.searches.cache, { hits: 0, misses: 1, evictions: 1 });
  assert.equal(snapshot.reloads.scopes.profile, 1);
  assert.deepEqual(snapshot.ai.tokens, { input: 20, output: 10, total: 30 });
  assert.deepEqual(snapshot.upstream.checks, {
    resources: 9,
    failures: 1,
    retained: 1,
    retries: 1,
    circuitOpenings: 1,
    circuitRejections: 1,
    circuitRecoveries: 1,
  });
  assert.equal(snapshot.errors.categories.discord, 1);
  assert.deepEqual(snapshot.memory, {
    rssBytes: 1_024,
    heapUsedBytes: 512,
    heapTotalBytes: 768,
    externalBytes: 64,
  });

  const serialized = JSON.stringify(snapshot);
  assert.doesNotMatch(serialized, /private|query|userId|pluginId/);
});

test("metrics normalize unbounded labels into fixed buckets", () => {
  const metrics = createMetricsRegistry();
  metrics.recordCommand({ durationMs: 1, outcome: "new-outcome-added-later" });
  metrics.recordReload({ durationMs: 1, outcome: "success", scope: "private-scope" });
  metrics.recordError("private-category");

  const snapshot = metrics.getSnapshot();
  assert.equal(snapshot.commands.outcomes.other, 1);
  assert.equal(snapshot.reloads.scopes.all, 1);
  assert.equal(snapshot.errors.categories.other, 1);
  assert.doesNotMatch(JSON.stringify(snapshot), /private/);
});
