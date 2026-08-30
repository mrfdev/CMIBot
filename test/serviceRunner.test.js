import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runnerPath = path.join(repositoryRoot, "scripts", "service-runner.mjs");

test("the managed runner captures legacy output in the same process with privacy filtering", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lookupbot-service-runner-"));
  try {
    const currentRelease = path.join(projectRoot, ".deploy", "current");
    await fs.mkdir(path.join(currentRelease, "src"), { recursive: true });
    await fs.writeFile(
      path.join(currentRelease, "src", "index.js"),
      [
        'console.log("legacy bot connected", "123456789012345678");',
        'console.error("legacy failure at /Users/private/service");',
        "",
      ].join("\n"),
      "utf8",
    );
    await fs.writeFile(
      path.join(projectRoot, ".env"),
      "SERVICE_LOG_MAX_SIZE_MB=1\nSERVICE_LOG_MAX_FILES=2\nSERVICE_LOG_MIN_FREE_MB=64\n",
      { mode: 0o600 },
    );

    const result = await execFileAsync(process.execPath, [runnerPath], {
      encoding: "utf8",
      env: { ...process.env, CMIBOT_PROJECT_ROOT: projectRoot },
    });
    const info = await fs.readFile(path.join(projectRoot, "logs", "cmibot-service.log"), "utf8");
    const error = await fs.readFile(path.join(projectRoot, "logs", "cmibot-service.error.log"), "utf8");

    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
    assert.match(info, /legacy bot connected <id>/);
    assert.match(error, /legacy failure at <path>/);
    assert.doesNotMatch(`${info}${error}`, /123456789012345678|\/Users\/private/);

    const runnerSource = await fs.readFile(runnerPath, "utf8");
    assert.doesNotMatch(runnerSource, /node:child_process|\bspawn\(|\bfork\(/);
  } finally {
    await fs.rm(projectRoot, { recursive: true, force: true });
  }
});

test("the managed runner rejects an insecure environment before importing the release", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lookupbot-service-runner-env-"));
  try {
    const currentRelease = path.join(projectRoot, ".deploy", "current");
    const markerPath = path.join(projectRoot, "release-imported");
    await fs.mkdir(path.join(currentRelease, "src"), { recursive: true });
    await fs.writeFile(
      path.join(currentRelease, "src", "index.js"),
      `await import("node:fs/promises").then((fs) => fs.writeFile(${JSON.stringify(markerPath)}, "yes"));\n`,
      "utf8",
    );
    await fs.writeFile(path.join(projectRoot, ".env"), "DISCORD_TOKEN=private\n", { mode: 0o644 });

    await assert.rejects(
      execFileAsync(process.execPath, [runnerPath], {
        encoding: "utf8",
        env: { ...process.env, CMIBOT_PROJECT_ROOT: projectRoot },
      }),
      (error) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /owner-only permissions/i);
        assert.doesNotMatch(error.stderr, new RegExp(projectRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
        return true;
      },
    );
    await assert.rejects(() => fs.access(markerPath), { code: "ENOENT" });
  } finally {
    await fs.rm(projectRoot, { recursive: true, force: true });
  }
});
