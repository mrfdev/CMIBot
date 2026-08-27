import assert from "node:assert/strict";
import test from "node:test";
import {
  createAttentionMonitor,
  evaluateAttention,
  formatAttentionMessage,
  formatAttentionTestMessage,
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

test("attention messages expose only safe public update labels and versions", () => {
  const now = Date.parse("2026-08-27T12:00:00.000Z");
  const snapshot = makeSnapshot(now - 72 * 60 * 60 * 1000);
  snapshot.checkEnabled = true;
  snapshot.checkedAt = new Date(now - 30 * 60 * 60 * 1000).toISOString();
  snapshot.errorCount = 2;
  snapshot.retainedCount = 1;
  snapshot.catalog.plugins = [
    {
      id: "private-resource-key",
      label: "Public Plugin @everyone *name*",
      version: "0.9.0",
      resourceId: 123,
      resourceUrl: "https://private.example.test/resource/123",
    },
  ];
  snapshot.plugins.set("private-resource-key", {
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
  assert.equal(attention.updateCount, 1);
  assert.match(message, /2 upstream check\(s\)/);
  assert.match(message, /Public Plugin ＠everyone name/);
  assert.match(message, /`0\.9\.0` → `1\.0\.0`/);
  assert.doesNotMatch(
    message,
    /private-resource-key|private\.example|resource\/123|@everyone|\/Users\/|token|secret/i,
  );
});

test("attention messages identify each available tracked update", () => {
  const now = Date.parse("2026-08-27T12:00:00.000Z");
  const snapshot = makeSnapshot(now);
  snapshot.checkEnabled = true;
  snapshot.checkedAt = new Date(now).toISOString();
  snapshot.catalog.plugins = [
    { id: "cmi", label: "CMI", version: "1.0.0", resourceId: 1 },
  ];
  snapshot.catalog.companions = [
    {
      id: "bridge",
      label: "CMI Bridge",
      version: "2.0.0",
      versionSource: { type: "test" },
    },
  ];
  snapshot.paper = { version: "26.2", build: 87 };
  snapshot.plugins.set("cmi", { version: "1.1.0" });
  snapshot.companions.set("bridge", { version: "2.1.0" });

  const attention = evaluateAttention(snapshot, { now });
  const message = formatAttentionMessage(attention, { now });

  assert.equal(attention.updateCount, 2);
  assert.deepEqual(attention.updateDetails, [
    { label: "CMI Bridge", current: "2.0.0", latest: "2.1.0" },
    { label: "CMI", current: "1.0.0", latest: "1.1.0" },
  ]);
  assert.match(message, /2 tracked update\(s\) are available/);
  assert.match(message, /CMI Bridge.*`2\.0\.0` → `2\.1\.0`/);
  assert.match(message, /CMI.*`1\.0\.0` → `1\.1\.0`/);
});

test("manual alert tests are clearly marked and preserve the live incident state", async () => {
  const now = Date.parse("2026-08-27T12:00:00.000Z");
  const snapshot = makeSnapshot(now);
  const messages = [];
  const records = [];
  const monitor = createAttentionMonitor(
    {
      discord: { adminAlertChannelId: "private-channel" },
      versions: { checkIntervalMs: 1 },
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

  const testResult = await monitor.sendTestAlert();
  assert.equal(testResult.status, "sent");
  assert.match(messages[0], /admin alert test/i);
  assert.match(messages[0], /manual test, not a new incident/i);
  assert.match(formatAttentionTestMessage(testResult.attention, { now }), /data checks are healthy/i);
  assert.equal((await monitor.checkNow()).status, "healthy");
  assert.equal(messages.length, 1);
  assert.deepEqual(records.map((record) => record.event), ["attention.test_sent"]);
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

test("a different update set sends a fresh alert even when the count is unchanged", async () => {
  const now = Date.parse("2026-08-27T12:00:00.000Z");
  const messages = [];
  const snapshot = makeSnapshot(now);
  snapshot.checkEnabled = true;
  snapshot.checkedAt = new Date(now).toISOString();
  snapshot.paper = { version: "26.2", build: 87 };
  snapshot.catalog.plugins = [
    { id: "first", label: "First Plugin", version: "1.0.0", resourceId: 1 },
  ];
  snapshot.plugins.set("first", { version: "2.0.0" });

  const monitor = createAttentionMonitor(
    {
      discord: { adminAlertChannelId: "private-channel" },
      versions: { checkIntervalMs: 1 },
    },
    { getSnapshot: () => snapshot },
    {
      now: () => now,
      sendMessage: async (message) => messages.push(message),
      logger: { info() {}, warn() {} },
    },
  );

  assert.equal((await monitor.checkNow()).status, "alerted");
  snapshot.catalog.plugins = [
    { id: "second", label: "Second Plugin", version: "1.0.0", resourceId: 2 },
  ];
  snapshot.plugins = new Map([["second", { version: "2.0.0" }]]);
  assert.equal((await monitor.checkNow()).status, "alerted");
  assert.equal(messages.length, 2);
  assert.match(messages[0], /First Plugin/);
  assert.match(messages[1], /Second Plugin/);
});

test("large update sets stay within one Discord message and direct admins to the full list", () => {
  const now = Date.parse("2026-08-27T12:00:00.000Z");
  const snapshot = makeSnapshot(now);
  snapshot.checkEnabled = true;
  snapshot.checkedAt = new Date(now).toISOString();
  snapshot.paper = { version: "26.2", build: 87 };
  snapshot.catalog.plugins = Array.from({ length: 8 }, (_, index) => ({
    id: `plugin-${index}`,
    label: `Tracked Plugin ${index}`,
    version: "1.0.0",
    resourceId: index + 1,
  }));
  snapshot.plugins = new Map(
    snapshot.catalog.plugins.map((plugin) => [plugin.id, { version: "2.0.0" }]),
  );

  const attention = evaluateAttention(snapshot, { now });
  const message = formatAttentionMessage(attention, { now });

  assert.equal(attention.updateCount, 8);
  assert.equal(attention.updateDetails.length, 6);
  assert.match(message, /2 additional update\(s\) omitted/);
  assert.match(message, /\/lookup latest scope:all/);
  assert.ok(message.length <= 2_000);
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
