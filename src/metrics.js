const LATENCY_BUCKETS_MS = Object.freeze([10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000, 30_000]);
const OUTCOME_NAMES = Object.freeze(["success", "empty", "rejected", "denied", "error", "other"]);
const ERROR_CATEGORIES = Object.freeze([
  "ai",
  "audit",
  "cache",
  "discord",
  "process",
  "startup",
  "upstream",
  "other",
]);

function finiteNonNegative(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function integerNonNegative(value) {
  return Math.max(0, Math.round(finiteNonNegative(value)));
}

function normalizeOutcome(value) {
  const outcome = String(value || "other").toLowerCase();
  if (["success", "completed", "help"].includes(outcome)) {
    return "success";
  }
  if (outcome === "empty") {
    return "empty";
  }
  if (outcome === "rejected") {
    return "rejected";
  }
  if (["denied", "blocked"].includes(outcome)) {
    return "denied";
  }
  if (outcome.includes("error") || outcome === "failed") {
    return "error";
  }
  return "other";
}

function createLatencySeries() {
  const buckets = LATENCY_BUCKETS_MS.map((upperBoundMs) => ({ upperBoundMs, count: 0 }));
  const outcomes = Object.fromEntries(OUTCOME_NAMES.map((name) => [name, 0]));
  let count = 0;
  let totalMs = 0;
  let maxMs = 0;

  function percentile(percent) {
    if (!count) {
      return 0;
    }
    const target = Math.ceil(count * percent);
    let cumulative = 0;
    for (const bucket of buckets) {
      cumulative += bucket.count;
      if (cumulative >= target) {
        return bucket.upperBoundMs;
      }
    }
    return Math.ceil(maxMs);
  }

  return {
    record(durationMs, outcome) {
      const duration = finiteNonNegative(durationMs);
      count += 1;
      totalMs += duration;
      maxMs = Math.max(maxMs, duration);
      outcomes[normalizeOutcome(outcome)] += 1;
      const bucket = buckets.find((candidate) => duration <= candidate.upperBoundMs);
      if (bucket) {
        bucket.count += 1;
      }
    },
    snapshot() {
      return {
        count,
        averageMs: count ? Math.round(totalMs / count) : 0,
        p50Ms: percentile(0.5),
        p95Ms: percentile(0.95),
        maxMs: Math.round(maxMs),
        outcomes: { ...outcomes },
      };
    },
  };
}

function classifyErrorEvent(event) {
  const prefix = String(event || "").split(".")[0];
  if (prefix === "ai") return "ai";
  if (prefix === "audit") return "audit";
  if (prefix === "cache") return "cache";
  if (prefix === "discord") return "discord";
  if (prefix === "process") return "process";
  if (prefix === "startup") return "startup";
  if (prefix === "versions") return "upstream";
  return "other";
}

export function createMetricsRegistry({
  now = () => Date.now(),
  memoryUsage = () => process.memoryUsage(),
} = {}) {
  const startedAt = now();
  const commands = createLatencySeries();
  const searches = createLatencySeries();
  const reloads = createLatencySeries();
  const ai = createLatencySeries();
  const upstream = createLatencySeries();
  const reloadScopes = { startup: 0, all: 0, plugin: 0, profile: 0 };
  const aiOperations = { answer: 0, summary: 0 };
  const aiProviders = { ollama: 0, lexical: 0 };
  const aiTokens = { input: 0, output: 0, total: 0 };
  let aiEstimatedCostMicrousd = 0;
  const searchResults = { returned: 0, candidates: 0 };
  const searchCache = { hits: 0, misses: 0, evictions: 0 };
  const upstreamChecks = {
    resources: 0,
    failures: 0,
    retained: 0,
    retries: 0,
    circuitOpenings: 0,
    circuitRejections: 0,
    circuitRecoveries: 0,
  };
  const errors = Object.fromEntries(ERROR_CATEGORIES.map((name) => [name, 0]));
  let timer = null;

  function snapshotMemory() {
    const current = memoryUsage();
    return {
      rssBytes: integerNonNegative(current?.rss),
      heapUsedBytes: integerNonNegative(current?.heapUsed),
      heapTotalBytes: integerNonNegative(current?.heapTotal),
      externalBytes: integerNonNegative(current?.external),
    };
  }

  function getSnapshot() {
    return {
      uptimeMs: integerNonNegative(now() - startedAt),
      commands: commands.snapshot(),
      searches: {
        ...searches.snapshot(),
        results: { ...searchResults },
        cache: { ...searchCache },
      },
      reloads: {
        ...reloads.snapshot(),
        scopes: { ...reloadScopes },
      },
      ai: {
        ...ai.snapshot(),
        operations: { ...aiOperations },
        providers: { ...aiProviders },
        tokens: { ...aiTokens },
        estimatedCostMicrousd: aiEstimatedCostMicrousd,
      },
      upstream: {
        ...upstream.snapshot(),
        checks: { ...upstreamChecks },
      },
      errors: {
        total: Object.values(errors).reduce((total, value) => total + value, 0),
        categories: { ...errors },
      },
      memory: snapshotMemory(),
    };
  }

  function logSnapshot(logger) {
    const snapshot = getSnapshot();
    logger.info("metrics.snapshot", {
      commandCount: snapshot.commands.count,
      commandP95Ms: snapshot.commands.p95Ms,
      commandErrors: snapshot.commands.outcomes.error,
      searchCount: snapshot.searches.count,
      searchP95Ms: snapshot.searches.p95Ms,
      searchCacheHits: snapshot.searches.cache.hits,
      searchCacheMisses: snapshot.searches.cache.misses,
      searchCacheEvictions: snapshot.searches.cache.evictions,
      reloadCount: snapshot.reloads.count,
      reloadP95Ms: snapshot.reloads.p95Ms,
      aiRequestCount: snapshot.ai.count,
      aiTokenCount: snapshot.ai.tokens.total,
      upstreamCheckCount: snapshot.upstream.count,
      upstreamFailures: snapshot.upstream.checks.failures,
      upstreamRetries: snapshot.upstream.checks.retries,
      upstreamCircuitOpenings: snapshot.upstream.checks.circuitOpenings,
      upstreamCircuitRejections: snapshot.upstream.checks.circuitRejections,
      errorCount: snapshot.errors.total,
      rssBytes: snapshot.memory.rssBytes,
      heapUsedBytes: snapshot.memory.heapUsedBytes,
    });
  }

  return {
    recordCommand({ durationMs, outcome } = {}) {
      commands.record(durationMs, outcome);
    },
    recordSearch({
      durationMs,
      outcome,
      resultCount = 0,
      candidateCount = 0,
      cacheStatus = "disabled",
      cacheEvicted = false,
    } = {}) {
      searches.record(durationMs, outcome);
      searchResults.returned += integerNonNegative(resultCount);
      searchResults.candidates += integerNonNegative(candidateCount);
      if (cacheStatus === "hit") {
        searchCache.hits += 1;
      } else if (cacheStatus === "miss") {
        searchCache.misses += 1;
      }
      if (cacheEvicted === true) {
        searchCache.evictions += 1;
      }
    },
    recordReload({ durationMs, outcome, scope = "all" } = {}) {
      reloads.record(durationMs, outcome);
      const normalizedScope = Object.hasOwn(reloadScopes, scope) ? scope : "all";
      reloadScopes[normalizedScope] += 1;
    },
    recordAi({
      durationMs,
      outcome,
      operation,
      provider,
      inputTokens = 0,
      outputTokens = 0,
      totalTokens = 0,
      estimatedCostMicrousd = 0,
    } = {}) {
      ai.record(durationMs, outcome);
      if (Object.hasOwn(aiOperations, operation)) {
        aiOperations[operation] += 1;
      }
      if (Object.hasOwn(aiProviders, provider)) {
        aiProviders[provider] += 1;
      }
      aiTokens.input += integerNonNegative(inputTokens);
      aiTokens.output += integerNonNegative(outputTokens);
      aiTokens.total += integerNonNegative(totalTokens || Number(inputTokens) + Number(outputTokens));
      aiEstimatedCostMicrousd += integerNonNegative(estimatedCostMicrousd);
    },
    recordUpstream({ durationMs, outcome, resourceCount = 0, errorCount = 0, retainedCount = 0 } = {}) {
      upstream.record(durationMs, outcome);
      upstreamChecks.resources += integerNonNegative(resourceCount);
      upstreamChecks.failures += integerNonNegative(errorCount);
      upstreamChecks.retained += integerNonNegative(retainedCount);
    },
    recordUpstreamRetry() {
      upstreamChecks.retries += 1;
    },
    recordUpstreamCircuit({ outcome } = {}) {
      if (outcome === "opened") {
        upstreamChecks.circuitOpenings += 1;
      } else if (outcome === "rejected") {
        upstreamChecks.circuitRejections += 1;
      } else if (outcome === "closed") {
        upstreamChecks.circuitRecoveries += 1;
      }
    },
    recordError(category = "other") {
      errors[Object.hasOwn(errors, category) ? category : "other"] += 1;
    },
    observeLogRecord(record) {
      if (record?.level === "error" || /(?:error|failed)$/.test(String(record?.event || ""))) {
        errors[classifyErrorEvent(record.event)] += 1;
      }
    },
    getSnapshot,
    start(logger, intervalMs) {
      if (timer || !Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
        return;
      }
      timer = setInterval(() => logSnapshot(logger), intervalMs);
      timer.unref?.();
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}
