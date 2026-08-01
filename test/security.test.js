import assert from "node:assert/strict";
import test from "node:test";
import { createCooldownManager, createSlidingWindowRateLimiter } from "../src/security.js";

test("sliding-window limits follow a key until the window expires", () => {
  let now = 0;
  const limiter = createSlidingWindowRateLimiter({ now: () => now });

  assert.equal(limiter.check("user:1", 2, 10, "user").allowed, true);
  assert.equal(limiter.check("user:1", 2, 10, "user").allowed, true);

  const denied = limiter.check("user:1", 2, 10, "user");
  assert.deepEqual(denied, {
    allowed: false,
    retryAfterSeconds: 10,
    scope: "user",
  });

  now = 10_000;
  assert.equal(limiter.check("user:1", 2, 10, "user").allowed, true);
});

test("multi-scope checks do not consume other limits when one scope denies", () => {
  const limiter = createSlidingWindowRateLimiter({ now: () => 0 });
  const rules = [
    { key: "channel:1", scope: "channel", maxRequests: 1, windowSeconds: 10 },
    { key: "global", scope: "global", maxRequests: 2, windowSeconds: 10 },
  ];

  assert.equal(limiter.checkMany(rules).allowed, true);

  const denied = limiter.checkMany(rules);
  assert.equal(denied.allowed, false);
  assert.equal(denied.scope, "channel");

  assert.equal(limiter.check("global", 2, 10, "global").allowed, true);
  assert.equal(limiter.check("global", 2, 10, "global").allowed, false);
});

test("zero values disable a sliding-window layer", () => {
  const limiter = createSlidingWindowRateLimiter({ now: () => 0 });

  for (let index = 0; index < 20; index += 1) {
    assert.equal(limiter.check("disabled", 0, 30).allowed, true);
    assert.equal(limiter.check("disabled-window", 10, 0).allowed, true);
  }
});

test("sliding-window state evicts old buckets at its memory bound", () => {
  let now = 0;
  const limiter = createSlidingWindowRateLimiter({ now: () => now, maxBuckets: 2 });

  assert.equal(limiter.check("user:oldest", 1, 60).allowed, true);
  now += 1;
  assert.equal(limiter.check("user:middle", 1, 60).allowed, true);
  now += 1;
  assert.equal(limiter.check("user:newest", 1, 60).allowed, true);

  assert.equal(limiter.check("user:oldest", 1, 60).allowed, true);
});

test("cooldowns use an injectable clock and expire cleanly", () => {
  let now = 0;
  const cooldowns = createCooldownManager({ now: () => now });

  assert.equal(cooldowns.check("user:1", "lookup", 5).allowed, true);
  assert.deepEqual(cooldowns.check("user:1", "lookup", 5), {
    allowed: false,
    retryAfterSeconds: 5,
  });

  now = 5_000;
  assert.equal(cooldowns.check("user:1", "lookup", 5).allowed, true);
});
