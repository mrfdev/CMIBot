import assert from "node:assert/strict";
import test from "node:test";
import {
  createUpstreamResilience,
  parseRetryAfter,
  UpstreamCircuitOpenError,
  UpstreamHttpError,
} from "../src/upstreamResilience.js";

test("temporary failures retry with bounded exponential backoff", async () => {
  const delays = [];
  const events = [];
  let attempts = 0;
  let retries = 0;
  const resilience = createUpstreamResilience({
    maxAttempts: 3,
    baseDelayMs: 100,
    maxDelayMs: 500,
    failureThreshold: 3,
    cooldownMs: 1_000,
    random: () => 0.5,
    sleep: async (delayMs) => delays.push(delayMs),
    logger: {
      warn(event, fields) {
        events.push({ event, fields });
      },
    },
    metrics: {
      recordUpstreamRetry() {
        retries += 1;
      },
    },
  });

  const result = await resilience.execute("resource", async () => {
    attempts += 1;
    if (attempts < 3) {
      throw new TypeError("temporary transport failure");
    }
    return "ok";
  });

  assert.equal(result, "ok");
  assert.equal(attempts, 3);
  assert.deepEqual(delays, [100, 200]);
  assert.equal(retries, 2);
  assert.deepEqual(
    events.map(({ event, fields }) => ({ event, ...fields })),
    [
      { event: "versions.upstream_retry", attempt: 1, delayMs: 100, reason: "network" },
      { event: "versions.upstream_retry", attempt: 2, delayMs: 200, reason: "network" },
    ],
  );
  assert.doesNotMatch(JSON.stringify(events), /temporary transport failure|resource/);
});

test("permanent HTTP responses fail immediately without opening a circuit", async () => {
  let attempts = 0;
  const resilience = createUpstreamResilience({
    maxAttempts: 3,
    baseDelayMs: 0,
    maxDelayMs: 0,
    failureThreshold: 1,
    cooldownMs: 1_000,
  });

  await assert.rejects(
    resilience.execute("resource", async () => {
      attempts += 1;
      throw new UpstreamHttpError(404);
    }),
    UpstreamHttpError,
  );

  assert.equal(attempts, 1);
  assert.equal(resilience.getSnapshot().open, 0);
});

test("a resource circuit opens, skips calls during cooldown, and closes after one probe", async () => {
  let currentTime = 10_000;
  let operationCalls = 0;
  const circuitOutcomes = [];
  const resilience = createUpstreamResilience({
    maxAttempts: 1,
    failureThreshold: 2,
    cooldownMs: 1_000,
    now: () => currentTime,
    metrics: {
      recordUpstreamCircuit({ outcome }) {
        circuitOutcomes.push(outcome);
      },
    },
  });
  const fail = () => {
    operationCalls += 1;
    throw new TypeError("offline");
  };

  await assert.rejects(resilience.execute("resource", fail), TypeError);
  await assert.rejects(resilience.execute("resource", fail), TypeError);
  assert.equal(resilience.getSnapshot().open, 1);

  await assert.rejects(resilience.execute("resource", fail), UpstreamCircuitOpenError);
  assert.equal(operationCalls, 2);
  assert.equal(
    await resilience.execute("unrelated-resource", async () => "still healthy"),
    "still healthy",
  );

  currentTime += 1_000;
  assert.equal(await resilience.execute("resource", async () => {
    operationCalls += 1;
    return "recovered";
  }), "recovered");

  assert.equal(operationCalls, 3);
  assert.equal(resilience.getSnapshot().open, 0);
  assert.deepEqual(circuitOutcomes, ["opened", "rejected", "closed"]);
});

test("Retry-After parsing supports seconds and dates while retry delays stay capped", async () => {
  const now = Date.parse("2026-08-27T10:00:00.000Z");
  assert.equal(parseRetryAfter("1.5", now), 1_500);
  assert.equal(parseRetryAfter("Wed, 27 Aug 2026 10:00:03 GMT", now), 3_000);
  assert.equal(parseRetryAfter("invalid", now), 0);

  const delays = [];
  let attempts = 0;
  const resilience = createUpstreamResilience({
    maxAttempts: 2,
    baseDelayMs: 100,
    maxDelayMs: 500,
    failureThreshold: 3,
    cooldownMs: 1_000,
    random: () => 0.5,
    sleep: async (delayMs) => delays.push(delayMs),
  });

  await resilience.execute("resource", async () => {
    attempts += 1;
    if (attempts === 1) {
      throw new UpstreamHttpError(429, { retryAfterMs: 30_000 });
    }
    return "ok";
  });

  assert.deepEqual(delays, [500]);
});
