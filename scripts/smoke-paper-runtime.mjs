import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertJavaFeature,
  readRuntimeCompatibility,
  resolveJavaTool,
} from "./runtime-compatibility.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(scriptDirectory, "..");
const serverDirectory = path.join(workspaceRoot, "servers", "Paper-26.2");
const startupTimeoutMs = 180_000;
const shutdownTimeoutMs = 30_000;

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? "" : "";
}

function stripAnsi(value) {
  return value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

async function runSmoke(javaBinary, expectedFeature, paperJar, label) {
  const output = [];
  let outputTail = "";
  let ready = false;
  let stopRequested = false;
  let timedOut = false;

  const child = spawn(
    javaBinary,
    [
      "-Xms512M",
      "-Xmx2G",
      "--add-modules=jdk.incubator.vector",
      "-Dfile.encoding=UTF-8",
      "-Dcom.mojang.eula.agree=true",
      "-Dterminal.ansi=false",
      "-jar",
      paperJar,
      "--nogui",
    ],
    {
      cwd: serverDirectory,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );

  const requestStop = () => {
    if (stopRequested || child.killed) {
      return;
    }
    stopRequested = true;
    if (child.stdin.writable && !child.stdin.destroyed) {
      child.stdin.write("plugins\n");
      setTimeout(() => {
        if (child.stdin.writable && !child.stdin.destroyed) {
          child.stdin.write("stop\n");
        }
      }, 1_500).unref();
    }
  };

  const startupTimer = setTimeout(() => {
    timedOut = true;
    requestStop();
    setTimeout(() => child.kill("SIGTERM"), shutdownTimeoutMs).unref();
  }, startupTimeoutMs);

  const handleOutput = (chunk) => {
    const text = chunk.toString();
    process.stdout.write(text);
    output.push(text);
    outputTail = `${outputTail}${text}`.slice(-4_096);
    if (!ready && /Done \([\d.]+s\)!/i.test(outputTail)) {
      ready = true;
      setTimeout(requestStop, 2_000).unref();
    }
  };

  child.stdout.on("data", handleOutput);
  child.stderr.on("data", handleOutput);

  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  clearTimeout(startupTimer);

  const cleanOutput = stripAnsi(output.join(""));
  const lines = cleanOutput.split(/\r?\n/);
  const warningCount = lines.filter((line) => /\bWARN\b/.test(line)).length;
  const errorCount = lines.filter((line) => /\b(?:ERROR|SEVERE)\b/.test(line)).length;
  const exporterEnabled = /LookupRuntimeExporter v1\.0\.1/i.test(cleanOutput);
  const logPath = path.join(workspaceRoot, "servers", `smoke-${label}-last.log`);
  await fs.writeFile(logPath, cleanOutput, "utf8");

  if (timedOut || !ready) {
    throw new Error(`Paper did not reach its ready state within ${startupTimeoutMs / 1000} seconds.`);
  }
  if (exitCode !== 0) {
    throw new Error(`Paper exited with code ${exitCode ?? "unknown"}.`);
  }
  if (!exporterEnabled) {
    throw new Error("LookupRuntimeExporter 1.0.1 did not appear in the plugin startup or plugin list output.");
  }

  console.log(
    `[smoke] Java ${expectedFeature}: ready, exporter enabled, clean shutdown; ` +
      `${warningCount} warning line(s), ${errorCount} error line(s).`,
  );
  console.log(`[smoke] Log written to ${logPath}`);
}

async function main() {
  const compatibility = await readRuntimeCompatibility(workspaceRoot);
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
  await runSmoke(javaBinary, expectedFeature, compatibility.paperJar, label);
}

await main();
