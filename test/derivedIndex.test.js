import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { gunzip as gunzipCallback } from "node:zlib";
import { createDerivedIndexStore } from "../src/derivedIndex.js";
import { loadProfileSourceSnapshot } from "../src/profileSources.js";
import { loadEntriesForProfile } from "../src/profileIndex.js";
import { materializeIndexedYamlContext } from "../src/yamlIndex.js";

const gunzip = promisify(gunzipCallback);
const SILENT_LOGGER = { info() {}, warn() {}, error() {} };

function makeProfile() {
  return {
    name: "config",
    sourceType: "yaml",
    include: ["Plugin/config.yml"],
    exclude: [],
  };
}

async function writeSource(workspaceRoot, contents) {
  const sourcePath = path.join(workspaceRoot, "Plugin", "config.yml");
  await fs.mkdir(path.dirname(sourcePath), { recursive: true });
  await fs.writeFile(sourcePath, contents, "utf8");
  return sourcePath;
}

test("compact derived indexes reuse exact source content and preserve YAML expansion", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lookupbot-derived-index-"));
  const cacheDirectory = "logs/test-derived-indexes";
  const profile = makeProfile();
  const sourcePath = await writeSource(
    workspaceRoot,
    ["Feature:", "  Enabled: true", "  Message: hello", ""].join("\n"),
  );
  const store = createDerivedIndexStore({
    workspaceRoot,
    cacheDirectory,
    maxArtifactBytes: 1024 * 1024,
    logger: SILENT_LOGGER,
  });
  let builds = 0;

  async function load(snapshot, forceRebuild = false) {
    return store.loadOrBuild({
      scopeKey: "plugin:example:config",
      profile,
      sourceFingerprint: snapshot.fingerprint,
      forceRebuild,
      build() {
        builds += 1;
        return loadEntriesForProfile(profile, workspaceRoot, {
          sourceFiles: snapshot.files,
        });
      },
      validate(entries) {
        assert.ok(entries.length > 0);
      },
    });
  }

  try {
    const originalSource = await fs.readFile(sourcePath, "utf8");
    const firstSnapshot = await loadProfileSourceSnapshot(profile, workspaceRoot);
    const first = await load(firstSnapshot);
    assert.equal(builds, 1);
    assert.match(materializeIndexedYamlContext(first[0]).snippet, /Enabled: true/);

    const cacheRoot = path.join(workspaceRoot, cacheDirectory);
    const artifactNames = await fs.readdir(cacheRoot);
    assert.equal(artifactNames.length, 1);
    assert.match(artifactNames[0], /^[a-f0-9]{64}\.idx\.json\.gz$/);
    const artifactPath = path.join(cacheRoot, artifactNames[0]);
    assert.equal((await fs.stat(cacheRoot)).mode & 0o777, 0o700);
    assert.equal((await fs.stat(artifactPath)).mode & 0o777, 0o600);

    const decodedArtifact = await gunzip(await fs.readFile(artifactPath));
    const artifactText = decodedArtifact.toString("utf8");
    assert.doesNotMatch(artifactText, new RegExp(workspaceRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(artifactText, /plugin:example:config/);

    const secondSnapshot = await loadProfileSourceSnapshot(profile, workspaceRoot);
    const second = await load(secondSnapshot);
    assert.equal(builds, 1);
    assert.match(materializeIndexedYamlContext(second[0]).snippet, /Enabled: true/);

    const changedSource = originalSource.replace("true", "fals");
    assert.equal(Buffer.byteLength(changedSource), Buffer.byteLength(originalSource));
    await fs.writeFile(sourcePath, changedSource, "utf8");
    const changedSnapshot = await loadProfileSourceSnapshot(profile, workspaceRoot);
    const changed = await load(changedSnapshot);
    assert.equal(builds, 2);
    assert.equal(changed.find((entry) => entry.key === "Enabled").value, "fals");

    await load(changedSnapshot, true);
    assert.equal(builds, 3);
    assert.equal(await fs.readFile(sourcePath, "utf8"), changedSource);
    assert.deepEqual(store.getSummary(), {
      enabled: true,
      hits: 1,
      misses: 2,
      rebuilds: 3,
      forcedRebuilds: 1,
      rejectedArtifacts: 1,
      artifactsWritten: 3,
      writeFailures: 0,
    });
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("corrupt and symlinked artifacts are replaced without modifying their targets", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lookupbot-derived-safety-"));
  const cacheDirectory = "logs/test-derived-indexes";
  const profile = makeProfile();
  const sourcePath = await writeSource(workspaceRoot, "Feature:\n  Enabled: true\n");
  const sentinelPath = path.join(workspaceRoot, "sentinel.txt");
  await fs.writeFile(sentinelPath, "do-not-modify", "utf8");
  const store = createDerivedIndexStore({
    workspaceRoot,
    cacheDirectory,
    maxArtifactBytes: 1024 * 1024,
    logger: SILENT_LOGGER,
  });
  const snapshot = await loadProfileSourceSnapshot(profile, workspaceRoot);
  let builds = 0;
  const load = () =>
    store.loadOrBuild({
      scopeKey: "plugin:example:config",
      profile,
      sourceFingerprint: snapshot.fingerprint,
      build() {
        builds += 1;
        return loadEntriesForProfile(profile, workspaceRoot, {
          sourceFiles: snapshot.files,
        });
      },
      validate(entries) {
        assert.ok(entries.length > 0);
      },
    });

  try {
    await load();
    const cacheRoot = path.join(workspaceRoot, cacheDirectory);
    const artifactPath = path.join(cacheRoot, (await fs.readdir(cacheRoot))[0]);

    await fs.writeFile(artifactPath, "not-a-derived-index", { mode: 0o600 });
    await load();
    assert.equal(builds, 2);

    await fs.unlink(artifactPath);
    await fs.symlink(sentinelPath, artifactPath, "file");
    await load();
    assert.equal(builds, 3);
    assert.equal((await fs.lstat(artifactPath)).isSymbolicLink(), false);
    assert.equal(await fs.readFile(sentinelPath, "utf8"), "do-not-modify");
    assert.equal(await fs.readFile(sourcePath, "utf8"), "Feature:\n  Enabled: true\n");
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("profile source snapshots reject traversal and do not follow source symlinks", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lookupbot-source-safety-"));
  const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lookupbot-source-outside-"));
  const outsidePath = path.join(outsideRoot, "private.yml");
  await fs.writeFile(outsidePath, "Secret: never-read", "utf8");
  await fs.mkdir(path.join(workspaceRoot, "Plugin"), { recursive: true });
  await fs.symlink(outsidePath, path.join(workspaceRoot, "Plugin", "config.yml"), "file");

  try {
    const symlinkSnapshot = await loadProfileSourceSnapshot(makeProfile(), workspaceRoot);
    assert.deepEqual(symlinkSnapshot.files, []);

    await assert.rejects(
      () =>
        loadProfileSourceSnapshot(
          {
            ...makeProfile(),
            include: [`../${path.basename(outsideRoot)}/private.yml`],
          },
          workspaceRoot,
        ),
      (error) => {
        assert.match(error.message, /escaped the project workspace|discovery failed safely/i);
        assert.doesNotMatch(error.message, /private\.yml|lookupbot-source-outside/i);
        return true;
      },
    );
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
    await fs.rm(outsideRoot, { recursive: true, force: true });
  }
});
