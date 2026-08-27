import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { installLocalAi } from "../scripts/install-local-ai.mjs";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const installer = path.join(repositoryRoot, "scripts", "install-local-ai.mjs");

async function createExecutable(filePath, lines) {
  await fs.writeFile(filePath, `${lines.join("\n")}\n`, { mode: 0o755 });
}

test("local AI installer enforces cloud-off loopback service and verifies the approved model", async () => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lookupbot-local-ai-install-"));
  const stateDirectory = path.join(temporaryRoot, "state");
  const launchAgentsDirectory = path.join(temporaryRoot, "LaunchAgents");
  const loadedPath = path.join(temporaryRoot, "launchctl.loaded");
  const invocationPath = path.join(temporaryRoot, "ollama-arguments.txt");
  const ollamaPath = path.join(temporaryRoot, "ollama");
  const launchctlPath = path.join(temporaryRoot, "launchctl");
  const chatRequests = [];
  const fetchImpl = async (url, options = {}) => {
    if (options.method === "POST" && String(url).endsWith("/api/chat")) {
      chatRequests.push(JSON.parse(options.body));
      return new Response(JSON.stringify({
        done: true,
        model: "qwen3:8b",
        message: {
          content: JSON.stringify({
            answer: "The example setting is enabled.",
            citations: ["E1"],
            confidence: "high",
          }),
        },
        prompt_eval_count: 10,
        eval_count: 8,
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ models: [{ name: "qwen3:8b", model: "qwen3:8b" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    await fs.mkdir(stateDirectory);
    await fs.writeFile(
      path.join(stateDirectory, "server.json"),
      `${JSON.stringify({ unrelated_setting: "preserved" }, null, 2)}\n`,
      { mode: 0o644 },
    );
    await createExecutable(ollamaPath, [
      "#!/bin/sh",
      "set -eu",
      "printf '%s\\n' \"$@\" > \"$CMIBOT_TEST_OLLAMA_ARGUMENTS\"",
    ]);
    await createExecutable(launchctlPath, [
      "#!/bin/sh",
      "set -eu",
      "case \"$1\" in",
      "  print)",
      "    if [ -f \"$CMIBOT_TEST_OLLAMA_LOADED\" ]; then",
      "      printf '%s\\n' 'state = running' 'pid = 1357'",
      "      exit 0",
      "    fi",
      "    exit 113",
      "    ;;",
      "  bootout)",
      "    rm -f \"$CMIBOT_TEST_OLLAMA_LOADED\"",
      "    ;;",
      "  bootstrap)",
      "    : > \"$CMIBOT_TEST_OLLAMA_LOADED\"",
      "    ;;",
      "  *) exit 64 ;;",
      "esac",
    ]);
    const port = 43145;
    const baseUrl = `http://127.0.0.1:${port}`;
    const previousEnvironment = { ...process.env };
    const output = [];
    Object.assign(process.env, {
      CMIBOT_LAUNCHCTL: launchctlPath,
      CMIBOT_OLLAMA_BASE_URL: baseUrl,
      CMIBOT_OLLAMA_BINARY: ollamaPath,
      CMIBOT_OLLAMA_LAUNCH_AGENTS_DIR: launchAgentsDirectory,
      CMIBOT_OLLAMA_STATE_DIR: stateDirectory,
      CMIBOT_OLLAMA_TEST_MODE: "1",
      CMIBOT_TEST_OLLAMA_ARGUMENTS: invocationPath,
      CMIBOT_TEST_OLLAMA_LOADED: loadedPath,
      CMIBOT_UID: "501",
    });
    try {
      await installLocalAi({
        args: [],
        fetchImpl,
        logger: { log: (message) => output.push(message) },
        platform: "darwin",
      });
    } finally {
      for (const key of Object.keys(process.env)) {
        if (!(key in previousEnvironment)) delete process.env[key];
      }
      Object.assign(process.env, previousEnvironment);
    }
    const stdout = `${output.join("\n")}\n`;

    assert.match(stdout, /zero-cost local AI/i);
    assert.match(stdout, /loopback-only local AI service/i);
    assert.match(stdout, /installed and ready/i);
    assert.doesNotMatch(stdout, new RegExp(temporaryRoot));
    assert.doesNotMatch(stdout, /127\.0\.0\.1|qwen3|LaunchAgents|\.ollama/i);

    const serverConfigPath = path.join(stateDirectory, "server.json");
    const serverConfig = JSON.parse(await fs.readFile(serverConfigPath, "utf8"));
    assert.deepEqual(serverConfig, {
      unrelated_setting: "preserved",
      disable_ollama_cloud: true,
    });
    assert.equal((await fs.stat(serverConfigPath)).mode & 0o777, 0o600);
    assert.equal((await fs.stat(stateDirectory)).mode & 0o777, 0o700);

    const plistPath = path.join(launchAgentsDirectory, "com.mrfdev.cmibot.ollama.plist");
    const plist = await fs.readFile(plistPath, "utf8");
    assert.equal((await fs.stat(plistPath)).mode & 0o777, 0o600);
    assert.match(plist, /<string>com\.mrfdev\.cmibot\.ollama<\/string>/);
    assert.match(plist, /<key>OLLAMA_NO_CLOUD<\/key>\s*<string>1<\/string>/);
    assert.match(plist, new RegExp(`<key>OLLAMA_HOST<\\/key>\\s*<string>127\\.0\\.0\\.1:${port}<\\/string>`));
    assert.doesNotMatch(plist, /__[A-Z0-9_]+__/);

    assert.equal(await fs.readFile(invocationPath, "utf8"), "pull\nqwen3:8b\n");
    assert.equal(chatRequests.length, 1);
    assert.equal(chatRequests[0].model, "qwen3:8b");
    assert.equal(chatRequests[0].stream, false);
    assert.equal(chatRequests[0].think, false);
    assert.deepEqual(chatRequests[0].format.properties.citations.items.enum, ["E1"]);
    assert.doesNotMatch(JSON.stringify(chatRequests[0]), /https?:\/\/|Users\/|private key/i);
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("local AI installer rejects a non-loopback endpoint without disclosing it", async () => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lookupbot-local-ai-reject-"));
  const unsafeEndpoint = "http://0.0.0.0:11434";
  try {
    await assert.rejects(
      execFileAsync(process.execPath, [installer], {
        cwd: repositoryRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          CMIBOT_OLLAMA_BASE_URL: unsafeEndpoint,
          CMIBOT_OLLAMA_STATE_DIR: path.join(temporaryRoot, "state"),
          CMIBOT_OLLAMA_TEST_MODE: "1",
        },
      }),
      (error) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /failed safely/);
        assert.doesNotMatch(`${error.stdout}${error.stderr}`, /0\.0\.0\.0|11434|lookupbot-local-ai-reject/);
        return true;
      },
    );
    await assert.rejects(fs.access(path.join(temporaryRoot, "state")), { code: "ENOENT" });
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
});
