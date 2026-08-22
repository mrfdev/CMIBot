import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const lifecycleUrl = pathToFileURL(path.join(repositoryRoot, "src", "processLifecycle.js")).href;

async function runSignalFixture(signal) {
  const fixture = [
    `import { installGracefulShutdown } from ${JSON.stringify(lifecycleUrl)};`,
    "installGracefulShutdown({",
    "  stop: async (receivedSignal) => {",
    "    await new Promise((resolve) => setTimeout(resolve, 20));",
    "    console.log(`fixture stopped after ${receivedSignal}`);",
    "  },",
    "});",
    'console.log("fixture ready");',
    "setInterval(() => {}, 1000);",
  ].join("\n");
  const child = spawn(process.execPath, ["--input-type=module", "--eval", fixture], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Fixture did not become ready. stdout=${stdout} stderr=${stderr}`)), 2000);
      const inspect = () => {
        if (stdout.includes("fixture ready")) {
          clearTimeout(timeout);
          child.off("exit", exitedEarly);
          resolve();
        }
      };
      const exitedEarly = (code, exitSignal) => {
        clearTimeout(timeout);
        reject(new Error(`Fixture exited before ready (code=${code}, signal=${exitSignal}). stderr=${stderr}`));
      };
      child.stdout.on("data", inspect);
      child.once("exit", exitedEarly);
      inspect();
    });

    child.kill(signal);
    const { code, exitSignal } = await new Promise((resolve) => {
      child.once("exit", (code, exitSignal) => resolve({ code, exitSignal }));
    });
    return { code, exitSignal, stderr, stdout };
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  }
}

test("SIGTERM waits for cleanup and exits cleanly", { timeout: 5000 }, async () => {
  const result = await runSignalFixture("SIGTERM");

  assert.equal(result.code, 0);
  assert.equal(result.exitSignal, null);
  assert.match(result.stdout, /Received SIGTERM; shutting down\.[\s\S]*fixture stopped after SIGTERM[\s\S]*LookupBot stopped cleanly\./);
});

test("SIGINT waits for cleanup and exits cleanly", { timeout: 5000 }, async () => {
  const result = await runSignalFixture("SIGINT");

  assert.equal(result.code, 0);
  assert.equal(result.exitSignal, null);
  assert.match(result.stdout, /Received SIGINT; shutting down\.[\s\S]*fixture stopped after SIGINT[\s\S]*LookupBot stopped cleanly\./);
});
