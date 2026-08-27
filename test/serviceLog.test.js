import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRotatingLogSink, createServiceLogManager } from "../src/serviceLog.js";

test("service logs rotate before crossing their size limit and bound archives", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "lookupbot-service-log-"));
  try {
    const sink = createRotatingLogSink({
      directory,
      fileName: "cmibot-service.log",
      maxBytes: 20,
      maxFiles: 2,
      minFreeBytes: 1,
    });

    assert.equal(sink.write("first-entry"), true);
    assert.equal(sink.write("second-entry"), true);
    assert.equal(sink.write("third-entry"), true);

    assert.equal(await fs.readFile(path.join(directory, "cmibot-service.log"), "utf8"), "third-entry\n");
    assert.equal(await fs.readFile(path.join(directory, "cmibot-service.log.1"), "utf8"), "second-entry\n");
    assert.equal(await fs.readFile(path.join(directory, "cmibot-service.log.2"), "utf8"), "first-entry\n");
    const snapshot = sink.getSnapshot();
    assert.equal(snapshot.rotations, 2);
    assert.equal(snapshot.droppedWrites, 0);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("service logs prune only their own archives and drop writes below the disk reserve", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "lookupbot-service-log-"));
  try {
    const sink = createRotatingLogSink({
      directory,
      fileName: "cmibot-service.error.log",
      maxBytes: 100,
      maxFiles: 2,
      minFreeBytes: 100,
      getAvailableBytes: () => 0,
    });
    await fs.writeFile(path.join(directory, "cmibot-service.error.log.1"), "archive one\n");
    await fs.writeFile(path.join(directory, "cmibot-service.error.log.2"), "archive two\n");
    await fs.writeFile(path.join(directory, "unrelated.txt"), "keep me\n");

    assert.equal(sink.write("must be dropped"), false);
    await assert.rejects(fs.access(path.join(directory, "cmibot-service.error.log.1")), /ENOENT/);
    await assert.rejects(fs.access(path.join(directory, "cmibot-service.error.log.2")), /ENOENT/);
    assert.equal(await fs.readFile(path.join(directory, "unrelated.txt"), "utf8"), "keep me\n");
    assert.deepEqual(
      { prunedArchives: sink.getSnapshot().prunedArchives, droppedWrites: sink.getSnapshot().droppedWrites },
      { prunedArchives: 2, droppedWrites: 1 },
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("service log status exposes only bounded aggregate information", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lookupbot-service-log-"));
  try {
    const manager = createServiceLogManager(workspaceRoot, {
      maxBytes: 1_024,
      maxFiles: 3,
      minFreeBytes: 1,
    });
    manager.stdout('{"event":"safe"}');
    manager.stderr('{"event":"failure"}');
    const serialized = JSON.stringify(manager.getSnapshot());

    assert.match(serialized, /"maxArchivesPerStream":3/);
    assert.doesNotMatch(serialized, new RegExp(workspaceRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(serialized, /cmibot-service/);
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});
