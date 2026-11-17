import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildVersionCatalog } from "../scripts/version-catalog.mjs";
import { createVersionService, formatLatestVersions, getVersionAttentionSummary } from "../src/versionCatalog.js";

const execFileAsync = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

test("PlaceholderAPI CI checks accept release and DEV jars while excluding classifier artifacts", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lookupbot-papi-"));
  let service;
  try {
    const serverDirectory = path.join(workspaceRoot, "server");
    const pluginsDirectory = path.join(serverDirectory, "plugins");
    await fs.mkdir(pluginsDirectory, { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, "plugin.yml"), "name: PlaceholderAPI\nversion: 2.12.3\n");
    await execFileAsync("zip", ["-q", path.join(pluginsDirectory, "PlaceholderAPI-2.12.3-build-269.jar"), "plugin.yml"], { cwd: workspaceRoot });
    const catalog = await buildVersionCatalog(repositoryRoot, serverDirectory);
    catalog.paper.build = 1;
    catalog.companions = [];
    const installed = catalog.plugins.find((entry) => entry.id === "placeholderapi");
    const shipped = JSON.parse(await fs.readFile(path.join(repositoryRoot, "data/versions.json"), "utf8"));
    assert.deepEqual(installed.versionSource, shipped.plugins.find((entry) => entry.id === "placeholderapi").versionSource);
    await fs.writeFile(path.join(workspaceRoot, "versions.json"), JSON.stringify(catalog));

    let build = { number: 269, artifacts: [{ fileName: "PlaceholderAPI-2.12.3.jar" }] };
    service = createVersionService({
      workspaceRoot,
      versions: {
        catalogPath: "versions.json", statePath: "upstream.json", checkEnabled: true,
        checkIntervalMs: 60_000, requestTimeoutMs: 1_000,
        paperVersion: catalog.paper.version, paperChannels: ["STABLE"], retryMaxAttempts: 1,
      },
    }, {
      logger: { info() {}, warn() {}, error() {} },
      async fetch(input) {
        if (String(input).startsWith("https://fill.papermc.io/")) {
          return Response.json([{ id: catalog.paper.build, channel: "STABLE" }]);
        }
        assert.equal(String(input), installed.versionSource.url);
        return Response.json(build);
      },
    });
    let snapshot = await service.start();
    assert.equal(snapshot.errorCount, 0);
    assert.equal(snapshot.plugins.get("placeholderapi").version, "2.12.3");

    const classifiers = ["javadoc", "plain", "sources"].map((suffix) => ({ fileName: `PlaceholderAPI-2.12.4-DEV-270-${suffix}.jar` }));
    build = { number: 270, artifacts: [...classifiers, { fileName: "PlaceholderAPI-2.12.4-DEV-270.jar" }] };
    snapshot = await service.refreshUpstream();
    assert.equal(snapshot.errorCount, 0, "A successful CI response with the runnable DEV jar must not fail");
    assert.equal(snapshot.retainedCount, 0);
    assert.equal(snapshot.plugins.get("placeholderapi").version, "2.12.4-DEV-270");
    assert.equal(snapshot.plugins.get("placeholderapi").build, 270);
    assert.equal(snapshot.plugins.get("placeholderapi").stale, false);
    assert.match(formatLatestVersions(snapshot, { id: "cmi", label: "CMI" }, "all"), /2\.12\.4-DEV-270/);
    assert.deepEqual(getVersionAttentionSummary(snapshot).updateKeys, ["plugin:placeholderapi"]);

    build = { number: 271, artifacts: classifiers };
    snapshot = await service.refreshUpstream();
    assert.equal(snapshot.errorCount, 1, "Classifier jars must never count as a runnable release");
    assert.equal(snapshot.retainedCount, 1);
    assert.equal(snapshot.plugins.get("placeholderapi").version, "2.12.4-DEV-270");
    assert.equal(snapshot.plugins.get("placeholderapi").stale, true);

    build = { number: 272, artifacts: [{ fileName: "PlaceholderAPI-2.12.4.jar" }] };
    snapshot = await service.refreshUpstream();
    assert.equal(snapshot.errorCount, 0);
    assert.equal(snapshot.retainedCount, 0);
    assert.equal(snapshot.plugins.get("placeholderapi").version, "2.12.4");
    assert.equal(snapshot.plugins.get("placeholderapi").build, 272);
  } finally {
    service?.stop();
    await service?.flushPersistence();
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});
