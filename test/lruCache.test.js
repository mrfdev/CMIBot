import assert from "node:assert/strict";
import test from "node:test";
import { createBoundedLruCache } from "../src/lruCache.js";

test("bounded LRU eviction follows read recency", () => {
  const cache = createBoundedLruCache(2);

  assert.deepEqual(cache.set("first", 1), { stored: true, evicted: false });
  assert.deepEqual(cache.set("second", 2), { stored: true, evicted: false });
  assert.deepEqual(cache.get("first"), { hit: true, value: 1 });
  assert.deepEqual(cache.set("third", 3), { stored: true, evicted: true });

  assert.deepEqual(cache.get("second"), { hit: false, value: undefined });
  assert.deepEqual(cache.get("first"), { hit: true, value: 1 });
  assert.deepEqual(cache.get("third"), { hit: true, value: 3 });
  assert.equal(cache.size, 2);
  assert.equal(cache.maxSize, 2);
});

test("a zero-sized LRU remains disabled", () => {
  const cache = createBoundedLruCache(0);

  assert.deepEqual(cache.set("ignored", true), { stored: false, evicted: false });
  assert.deepEqual(cache.get("ignored"), { hit: false, value: undefined });
  assert.equal(cache.clear(), 0);
  assert.equal(cache.size, 0);
});
