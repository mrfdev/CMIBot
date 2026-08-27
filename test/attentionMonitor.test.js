import assert from "node:assert/strict";
import test from "node:test";
import {
  createAttentionMonitor,
  evaluateAttention,
  formatAttentionMessage,
} from "../src/attentionMonitor.js";

function makeSnapshot(now) {
  return {
    catalog: {
      generatedAt: new Date(now).toISOString(),
      paper: { version: "26.2", build: 87 },
      plugins: [],
      companions: [],
    },
    paper: null,
    plugins: new Map(),
    companions: new Map(),
    checkedAt: null,
    errorCount: 0,
    retainedCount: 0,
    checkEnabled: false,
  };
}

test("attention evaluation and messages expose aggregate state only", () => {
  const now = Date.parse("2026-08-27T12:00:00.000Z");
  const snapshot = makeSnapshot(now - 72 * 60 * 60 * 1000);
  snapshot.checkEnabled = true;
  snapshot.checkedAt = new Date(now - 30 * 60 * 60 * 1000).toISOString();
  snapshot.errorCount = 2;
  snapshot.retainedCount = 1;
  snapshot.catalog.plugins = [
    { id: "private-resource-name", version: "1.0.0", resourceId: 123 },
  ];
  snapshot.plugins.set("private-resource-name", {
    version: "1.0.0",
    stale: true,
  });

  const attention = evaluateAttention(snapshot, {
    now,
    cleanDataMaxAgeMs: 48 * 60 * 60 * 1000,
    upstreamMaxAgeMs: 24 * 60 * 60 * 1000,
  });
  const message = formatAttentionMessage(attention, { now });

  assert.equal(attention.needsAttention, true);
  assert.equal(attention.cleanDataStale, true);
  assert.equal(attention.upstreamOverdue, true);
  assert.equal(attention.upstreamFailureCount, 2);
  assert.equal(attention.retainedCount, 1);
  assert.match(message, /2 upstream check\(s\)/);
  assert.doesNotMatch(message, /private-resource-name|123|\/Users\/|token|secret/i);
});

test("attention monitor deduplicates alerts and sends one recovery", async () => {
  let now = Date.parse("2026-08-27T12:00:00.000Z");
  let snapshot = makeSnapshot(now - 72 * 60 * 60 * 1000);
  const messages = [];
  const records = [];
  const monitor = createAttentionMonitor(
    {
      discord: { adminAlertChannelId: "private-channel" },
      versions: { checkIntervalMs: 12 * 60 * 60 * 1000 },
      attention: {
        cleanDataMaxAgeMs: 48 * 60 * 60 * 1000,
        upstreamMaxAgeMs: 24 * 60 * 60 * 1000,
        reminderMs: 24 * 60 * 60 * 1000,
      },
    },
    { getSnapshot: () => snapshot },
    {
      now: () => now,
      sendMessage: async (message) => messages.push(message),
      logger: {
        info(event, fields) {
          records.push({ event, fields });
        },
        warn(event, fields) {
          records.push({ event, fields });
        },
      },
    },
  );

  assert.equal((await monitor.checkNow()).status, "alerted");
  assert.equal((await monitor.checkNow()).status, "unchanged");
  assert.equal(messages.length, 1);

  snapshot = makeSnapshot(now);
  assert.equal((await monitor.checkNow()).status, "recovered");
  assert.equal((await monitor.checkNow()).status, "healthy");
  assert.equal(messages.length, 2);
  assert.match(messages[1], /recovered/i);
  assert.deepEqual(
    records.map((record) => record.event),
    ["attention.alert_sent", "attention.recovery_sent"],
  );
});

test("attention monitor is disabled without a dedicated private channel", async () => {
  const monitor = createAttentionMonitor(
    {
      discord: { adminAlertChannelId: "" },
      versions: { checkIntervalMs: 1 },
    },
    { getSnapshot: () => null },
  );

  assert.equal((await monitor.checkNow()).status, "disabled");
});

test("attention monitor rejects a destination outside the configured guild without logging IDs", async () => {
  const now = Date.parse("2026-08-27T12:00:00.000Z");
  const records = [];
  const monitor = createAttentionMonitor(
    {
      discord: {
        adminAlertChannelId: "alert-channel",
        guildId: "configured-guild",
      },
      versions: { checkIntervalMs: 1 },
      attention: { cleanDataMaxAgeMs: 1 },
    },
    { getSnapshot: () => makeSnapshot(now - 10_000) },
    {
      now: () => now,
      client: {
        channels: {
          async fetch() {
            return {
              guildId: "different-guild",
              isTextBased: () => true,
              async send() {
                throw new Error("must not send");
              },
            };
          },
        },
      },
      logger: {
        info() {},
        warn(event, fields) {
          records.push({ event, fields });
        },
      },
    },
  );

  assert.equal((await monitor.checkNow()).status, "error");
  assert.deepEqual(records, [
    { event: "attention.check_failed", fields: { errorName: "Error" } },
  ]);
  assert.doesNotMatch(JSON.stringify(records), /alert-channel|configured-guild|different-guild/);
});
