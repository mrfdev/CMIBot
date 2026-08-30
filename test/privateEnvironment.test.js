import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  loadPrivateEnvironment,
  readPrivateEnvironmentFile,
} from "../src/privateEnvironment.js";

test("owner-only environment files load without overriding process values", async () => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lookupbot-private-env-"));
  const environmentPath = path.join(temporaryRoot, ".env");

  try {
    await fs.writeFile(
      environmentPath,
      "DISCORD_TOKEN=file-token\nEXISTING_SETTING=file-value\n",
      { mode: 0o600 },
    );
    const target = { EXISTING_SETTING: "process-value" };

    const loaded = await loadPrivateEnvironment({ environmentPath, target });

    assert.equal(loaded, true);
    assert.equal(target.DISCORD_TOKEN, "file-token");
    assert.equal(target.EXISTING_SETTING, "process-value");
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("environment reads reject broad permissions and symbolic links", async () => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lookupbot-private-env-"));
  const environmentPath = path.join(temporaryRoot, ".env");
  const targetPath = path.join(temporaryRoot, "target.env");

  try {
    await fs.writeFile(environmentPath, "DISCORD_TOKEN=private\n", { mode: 0o644 });
    await assert.rejects(
      () => readPrivateEnvironmentFile(environmentPath),
      /owner-only permissions/i,
    );

    await fs.writeFile(targetPath, "DISCORD_TOKEN=private\n", { mode: 0o600 });
    await fs.rm(environmentPath);
    await fs.symlink(targetPath, environmentPath);
    await assert.rejects(
      () => readPrivateEnvironmentFile(environmentPath),
      /regular file|symbolic link|unavailable/i,
    );
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("a missing optional environment file preserves environment-only startup", async () => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lookupbot-private-env-"));
  try {
    const loaded = await loadPrivateEnvironment({
      environmentPath: path.join(temporaryRoot, ".env"),
      target: { DISCORD_TOKEN: "process-token" },
      allowMissing: true,
    });
    assert.equal(loaded, false);
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
});
