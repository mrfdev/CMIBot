import assert from "node:assert/strict";
import test from "node:test";
import { createServiceLogger } from "../src/logger.js";

test("structured service logs redact sensitive values and omit sensitive fields", () => {
  const stdout = [];
  const stderr = [];
  const logger = createServiceLogger({
    now: () => new Date("2026-08-27T10:00:00.000Z"),
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
  });

  logger.info("discord.command.completed", {
    requestId: "request-123",
    commandName: "lookup",
    durationMs: 17,
    userId: "123456789012345678",
    host: "private-host-alias",
  });
  logger.error("startup.failed", {
    path: "/Users/private/service",
    error: new Error(
      "Could not read /Users/private/service/secret.key with Bearer private-token and id 123456789012345678",
    ),
  });

  assert.equal(stdout.length, 1);
  assert.equal(stderr.length, 1);
  const completed = JSON.parse(stdout[0]);
  assert.deepEqual(completed, {
    timestamp: "2026-08-27T10:00:00.000Z",
    level: "info",
    event: "discord.command.completed",
    requestId: "request-123",
    commandName: "lookup",
    durationMs: 17,
  });

  const failed = JSON.parse(stderr[0]);
  assert.equal(failed.event, "startup.failed");
  assert.equal(failed.errorName, "Error");
  assert.match(failed.errorMessage, /<path>/);
  assert.match(failed.errorMessage, /Bearer <redacted>/);
  assert.match(failed.errorMessage, /<id>/);
  assert.doesNotMatch(stderr[0], /private-host-alias|secret\.key|private-token|123456789012345678/);
  assert.equal("path" in failed, false);
  assert.equal("stack" in failed, false);
});

test("request context follows asynchronous service logs", async () => {
  const lines = [];
  const logger = createServiceLogger({
    now: () => new Date("2026-08-27T10:00:00.000Z"),
    stdout: (line) => lines.push(line),
    stderr: (line) => lines.push(line),
  });

  await logger.withContext(
    { requestId: "request-context", userId: "123456789012345678" },
    async () => {
      await Promise.resolve();
      logger.warn("ai.summary_failed", { model: "fallback" });
    },
  );

  const record = JSON.parse(lines[0]);
  assert.equal(record.requestId, "request-context");
  assert.equal(record.model, "fallback");
  assert.equal("userId" in record, false);
});
