import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { writeAuditLog } from "../src/auditLog.js";

async function readJsonLines(filePath) {
  const content = await fs.readFile(filePath, "utf8");
  return content
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

test("audit logs rotate before the configured size and bound archive retention", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lookupbot-audit-"));
  const relativePath = "logs/usage.jsonl";
  const absolutePath = path.join(workspaceRoot, relativePath);

  try {
    for (let index = 0; index < 8; index += 1) {
      await writeAuditLog(
        workspaceRoot,
        relativePath,
        { index, message: "rotation-test" },
        { maxBytes: 90, maxFiles: 2 },
      );
    }

    const active = await readJsonLines(absolutePath);
    const firstArchive = await readJsonLines(`${absolutePath}.1`);
    const secondArchive = await readJsonLines(`${absolutePath}.2`);
    assert.ok(active.length > 0);
    assert.ok(firstArchive.length > 0);
    assert.ok(secondArchive.length > 0);
    await assert.rejects(() => fs.stat(`${absolutePath}.3`), { code: "ENOENT" });

    const retainedIndexes = [...secondArchive, ...firstArchive, ...active].map((entry) => entry.index);
    assert.deepEqual(retainedIndexes, [...retainedIndexes].sort((left, right) => left - right));
    assert.equal(retainedIndexes.at(-1), 7);
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("concurrent audit writes remain complete JSON lines during rotation", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lookupbot-audit-concurrent-"));
  const relativePath = "logs/usage.jsonl";
  const absolutePath = path.join(workspaceRoot, relativePath);

  try {
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        writeAuditLog(
          workspaceRoot,
          relativePath,
          { index, message: "concurrent-test" },
          { maxBytes: 160, maxFiles: 10 },
        ),
      ),
    );

    const files = (await fs.readdir(path.dirname(absolutePath)))
      .filter((name) => name.startsWith("usage.jsonl"))
      .map((name) => path.join(path.dirname(absolutePath), name));
    const entries = (await Promise.all(files.map((file) => readJsonLines(file)))).flat();

    assert.equal(entries.length, 20);
    assert.deepEqual(
      entries.map((entry) => entry.index).sort((left, right) => left - right),
      Array.from({ length: 20 }, (_, index) => index),
    );
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("audit directories, active logs, and rotated archives are owner-only", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lookupbot-audit-modes-"));
  const logsPath = path.join(workspaceRoot, "logs");
  const absolutePath = path.join(logsPath, "usage.jsonl");

  try {
    await fs.mkdir(logsPath, { mode: 0o755 });
    await fs.writeFile(absolutePath, '{"legacy":true}\n', { mode: 0o644 });
    await fs.writeFile(`${absolutePath}.1`, '{"legacyArchive":true}\n', { mode: 0o644 });
    await fs.writeFile(`${absolutePath}.9`, '{"olderLegacyArchive":true}\n', { mode: 0o644 });

    await writeAuditLog(
      workspaceRoot,
      "logs/usage.jsonl",
      { message: "repair-without-rotation" },
      { maxBytes: 10_000, maxFiles: 2 },
    );

    assert.equal((await fs.stat(`${absolutePath}.1`)).mode & 0o777, 0o600);
    assert.equal((await fs.stat(`${absolutePath}.9`)).mode & 0o777, 0o600);

    for (let index = 0; index < 4; index += 1) {
      await writeAuditLog(
        workspaceRoot,
        "logs/usage.jsonl",
        { index, message: "permissions-test" },
        { maxBytes: 55, maxFiles: 2 },
      );
    }

    assert.equal((await fs.stat(logsPath)).mode & 0o777, 0o700);
    const auditFiles = (await fs.readdir(logsPath)).filter((name) => name.startsWith("usage.jsonl"));
    assert.ok(auditFiles.length > 1);
    for (const fileName of auditFiles) {
      assert.equal((await fs.stat(path.join(logsPath, fileName))).mode & 0o777, 0o600);
    }
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("audit writes reject a final-file symlink without changing its target", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lookupbot-audit-symlink-"));
  const logsPath = path.join(workspaceRoot, "logs");
  const targetPath = path.join(workspaceRoot, "other-user-data.txt");
  const auditPath = path.join(logsPath, "usage.jsonl");

  try {
    await fs.mkdir(logsPath);
    await fs.writeFile(targetPath, "must remain unchanged\n", "utf8");
    await fs.symlink(targetPath, auditPath);

    await writeAuditLog(workspaceRoot, "logs/usage.jsonl", { unsafe: true });

    assert.equal(await fs.readFile(targetPath, "utf8"), "must remain unchanged\n");
    assert.equal((await fs.lstat(auditPath)).isSymbolicLink(), true);
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("audit writes preserve the managed release logs symlink workflow", async () => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lookupbot-audit-managed-"));
  const releaseRoot = path.join(temporaryRoot, "release");
  const sharedLogs = path.join(temporaryRoot, "shared-logs");

  try {
    await fs.mkdir(releaseRoot);
    await fs.mkdir(sharedLogs, { mode: 0o700 });
    await fs.symlink(sharedLogs, path.join(releaseRoot, "logs"), "dir");

    await writeAuditLog(releaseRoot, "logs/usage.jsonl", { managed: true });

    assert.deepEqual(await readJsonLines(path.join(sharedLogs, "usage.jsonl")), [{ managed: true }]);
    assert.equal((await fs.stat(path.join(sharedLogs, "usage.jsonl"))).mode & 0o777, 0o600);
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
});
