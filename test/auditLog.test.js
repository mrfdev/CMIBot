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
