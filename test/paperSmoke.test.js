import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runPaperSmoke } from "../scripts/smoke-paper-runtime.mjs";

async function smokeFixture(t, mode) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cmibot-paper-smoke-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const logPath = path.join(directory, "smoke.log");
  const source = `
    import readline from "node:readline";
    const mode = ${JSON.stringify(mode)};
    setInterval(() => {}, 1000);
    if (mode === "stuck-shutdown") process.on("SIGTERM", () => {});
    if (mode !== "stuck-startup") {
      console.log("[INFO]: [LookupRuntimeExporter] " + (mode === "load-only" ? "Loading server plugin" : "Enabling") + " LookupRuntimeExporter v2.3.4");
      console.log("[ERROR]: [Jobs] Vault is required by this plugin for economy support!");
      console.log("[INFO]: Done (0.01s)! For help, type help");
    }
    readline.createInterface({ input: process.stdin }).on("line", (line) => {
      if (line === "lookupexport") {
        console.log("command received: lookupexport");
        if (mode === "export-fails") process.exit(0);
        if (mode !== "stuck-export") {
          process.stdout.write("[INFO]: [LookupRuntimeExporter] LOOKUP_EXPORT_");
          setTimeout(() => console.log("COMPLETE entries=10 warnings=0"), 10);
        }
      }
      if (line === "stop") {
        console.log("command received: stop");
        if (mode !== "stuck-shutdown") process.exit(mode === "bad-exit" ? 1 : 0);
      }
    });
  `;
  const options = {
    serverDirectory: directory,
    javaBinary: "fixture-java",
    compatibility: { exporterVersion: "2.3.4", paperJar: "fixture-paper.jar" },
    logPath,
    startupTimeoutMs: 1_000,
    exporterTimeoutMs: 150,
    shutdownTimeoutMs: 150,
    killTimeoutMs: 100,
    settleDelayMs: 0,
    writeOutput: () => {},
    spawnProcess: (_binary, _args, spawnOptions) => {
      const child = spawn(process.execPath, ["--input-type=module", "--eval", source], spawnOptions);
      t.after(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      });
      return child;
    },
  };
  return { options, readLog: () => fs.readFile(logPath, "utf8") };
}

test("Paper smoke requires a completed export from the manifest version and preserves unrelated diagnostics", { timeout: 5_000 }, async (t) => {
  const { options, readLog } = await smokeFixture(t, "success");
  assert.deepEqual(await runPaperSmoke(options), { warningCount: 0, errorCount: 1 });
  assert.match(await readLog(), /command received: lookupexport[\s\S]*LOOKUP_EXPORT_COMPLETE[\s\S]*command received: stop/);
});

test("Paper smoke rejects an exporter that was loaded but never enabled", { timeout: 5_000 }, async (t) => {
  const { options, readLog } = await smokeFixture(t, "load-only");
  await assert.rejects(runPaperSmoke(options), /2\.3\.4 was not enabled/);
  assert.doesNotMatch(await readLog(), /command received: lookupexport/);
});

test("Paper smoke rejects shutdown before export completion even when exit is zero", { timeout: 5_000 }, async (t) => {
  const { options } = await smokeFixture(t, "export-fails");
  await assert.rejects(runPaperSmoke(options), /stopped before runtime metadata export completed/);
});

test("Paper smoke bounds startup and incomplete export and preserves failure logs", { timeout: 5_000 }, async (t) => {
  for (const [mode, expected] of [["stuck-startup", /did not reach its ready state/], ["stuck-export", /export did not complete/]]) {
    const { options, readLog } = await smokeFixture(t, mode);
    await assert.rejects(runPaperSmoke(options), expected);
    assert.match(await readLog(), /command received: stop/);
  }
});

test("Paper smoke kills a process that ignores stop and SIGTERM", { timeout: 5_000 }, async (t) => {
  const { options, readLog } = await smokeFixture(t, "stuck-shutdown");
  await assert.rejects(runPaperSmoke(options), /did not shut down/);
  assert.match(await readLog(), /LOOKUP_EXPORT_COMPLETE/);
});

test("Paper smoke rejects a nonzero exit after successful export", { timeout: 5_000 }, async (t) => {
  const { options } = await smokeFixture(t, "bad-exit");
  await assert.rejects(runPaperSmoke(options), /exited with code 1/);
});
