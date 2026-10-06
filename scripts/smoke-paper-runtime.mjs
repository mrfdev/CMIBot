import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertJavaFeature,
  readRuntimeCompatibility,
  resolveJavaTool,
  runtimeServerPaths,
} from "./runtime-compatibility.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const workspaceRoot = path.resolve(path.dirname(scriptPath), "..");

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? "" : "";
}

function stripAnsi(value) {
  return value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

export async function runPaperSmoke({
  serverDirectory,
  javaBinary,
  compatibility,
  logPath,
  startupTimeoutMs = 180_000,
  exporterTimeoutMs = 30_000,
  shutdownTimeoutMs = 30_000,
  killTimeoutMs = 5_000,
  settleDelayMs = 2_000,
  spawnProcess = spawn,
  writeOutput = (text) => process.stdout.write(text),
}) {
  const output = [];
  let outputTail = "";
  let ready = false;
  let exporterEnabled = false;
  let exportRequested = false;
  let exportCompleted = false;
  let stopRequested = false;
  let failure = null;
  const timers = new Set();
  const exporterVersion = compatibility.exporterVersion.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const enabledPattern = new RegExp(`\\[LookupRuntimeExporter\\] Enabling LookupRuntimeExporter v${exporterVersion}(?:\\s|$)`);
  const child = spawnProcess(
    javaBinary,
    [
      "-Xms512M",
      "-Xmx2G",
      "--add-modules=jdk.incubator.vector",
      "-Dfile.encoding=UTF-8",
      "-Dcom.mojang.eula.agree=true",
      "-Dterminal.ansi=false",
      "-jar",
      compatibility.paperJar,
      "--nogui",
    ],
    { cwd: serverDirectory, stdio: ["pipe", "pipe", "pipe"] },
  );

  const schedule = (callback, delay) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      callback();
    }, delay);
    timers.add(timer);
    return timer;
  };
  const cancel = (timer) => {
    clearTimeout(timer);
    timers.delete(timer);
  };
  const isRunning = () => child.exitCode === null && child.signalCode === null;
  const requestStop = () => {
    if (stopRequested || !isRunning()) {
      return;
    }
    stopRequested = true;
    cancel(startupTimer);
    cancel(exporterTimer);
    if (child.stdin.writable && !child.stdin.destroyed) {
      child.stdin.write("plugins\nstop\n");
    }
    schedule(() => {
      if (!isRunning()) return;
      failure ??= new Error(`Paper did not shut down within ${shutdownTimeoutMs / 1000} seconds.`);
      child.kill("SIGTERM");
      schedule(() => {
        if (isRunning()) child.kill("SIGKILL");
      }, killTimeoutMs);
    }, shutdownTimeoutMs);
  };
  const fail = (message) => {
    failure ??= new Error(message);
    requestStop();
  };
  let exporterTimer;
  const startupTimer = schedule(() => {
    fail(`Paper did not reach its ready state within ${startupTimeoutMs / 1000} seconds.`);
  }, startupTimeoutMs);
  const requestExport = () => {
    if (stopRequested || !isRunning()) return;
    if (!exporterEnabled) {
      fail(`LookupRuntimeExporter ${compatibility.exporterVersion} was not enabled before Paper became ready.`);
      return;
    }
    if (!child.stdin.writable || child.stdin.destroyed) {
      fail("Paper closed its command input before the runtime export.");
      return;
    }
    exportRequested = true;
    child.stdin.write("lookupexport\n");
    exporterTimer = schedule(() => {
      fail(`Runtime metadata export did not complete within ${exporterTimeoutMs / 1000} seconds.`);
    }, exporterTimeoutMs);
  };
  const handleOutput = (chunk) => {
    const text = chunk.toString();
    writeOutput(text);
    output.push(text);
    outputTail = `${outputTail}${stripAnsi(text)}`.slice(-8_192);
    exporterEnabled ||= enabledPattern.test(outputTail);
    if (!ready && /Done \([\d.]+s\)!/i.test(outputTail)) {
      ready = true;
      cancel(startupTimer);
      schedule(requestExport, settleDelayMs);
    }
    if (exportRequested && !exportCompleted && /\[LookupRuntimeExporter\] LOOKUP_EXPORT_COMPLETE\s+entries=\d+\s+warnings=\d+/i.test(outputTail)) {
      exportCompleted = true;
      cancel(exporterTimer);
      requestStop();
    }
  };
  child.stdout.on("data", handleOutput);
  child.stderr.on("data", handleOutput);
  child.stdin.on("error", (error) => fail(`Paper command input failed: ${error.message}`));
  const exitCode = await new Promise((resolve) => {
    child.once("error", (error) => { failure ??= error; });
    child.once("close", resolve);
  });
  for (const timer of timers) clearTimeout(timer);

  const cleanOutput = stripAnsi(output.join(""));
  await fs.writeFile(logPath, cleanOutput, "utf8");
  if (failure) throw failure;
  if (!ready) throw new Error("Paper stopped before reaching its ready state.");
  if (!exportCompleted) throw new Error("Paper stopped before runtime metadata export completed.");
  if (exitCode !== 0) throw new Error(`Paper exited with code ${exitCode ?? "unknown"}.`);
  const lines = cleanOutput.split(/\r?\n/);
  return {
    warningCount: lines.filter((line) => /\bWARN\b/.test(line)).length,
    errorCount: lines.filter((line) => /\b(?:ERROR|SEVERE)\b/.test(line)).length,
  };
}

async function main() {
  const compatibility = await readRuntimeCompatibility(workspaceRoot);
  const { serverDirectory } = runtimeServerPaths(workspaceRoot, compatibility);
  const javaHome = argumentValue("--java-home");
  const expectedFeature = Number(argumentValue("--expect") || compatibility.javaTarget);
  const label = argumentValue("--label") || `java${expectedFeature}`;
  const javaBinary = await resolveJavaTool(compatibility, {
    feature: expectedFeature,
    javaHome,
    tool: "java",
  });
  const javaVersion = await assertJavaFeature(javaBinary, expectedFeature);
  console.log(`[smoke] ${javaVersion.output.split("\n")[0]}`);
  const logPath = path.join(workspaceRoot, "servers", `smoke-${label}-last.log`);
  const { warningCount, errorCount } = await runPaperSmoke({ serverDirectory, javaBinary, compatibility, logPath });
  console.log(
    `[smoke] Java ${expectedFeature}: ready, exporter ${compatibility.exporterVersion} completed, clean shutdown; ` +
      `${warningCount} warning line(s), ${errorCount} error line(s).`,
  );
  console.log(`[smoke] Log written to ${logPath}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  await main();
}
