import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  prepareGroundedEvidence,
  toProviderEvidence,
  validateAiQuestion,
} from "../src/aiSafety.js";
import { GroundedAiService } from "../src/groundedAi.js";
import { AiUsageLedger } from "../src/aiUsage.js";
import {
  isLocalOllamaModelName,
  normalizeLoopbackOllamaBaseUrl,
  OllamaError,
  OllamaProvider,
} from "../src/ollama.js";
import { extractEntriesFromText } from "../src/yamlIndex.js";
import { formatAiStatusMessage } from "../src/discord/aiInteraction.js";

function jsonResponse(value, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return JSON.stringify(value);
    },
  };
}

function makeEvidence() {
  return [{
    id: "E1",
    profileName: "config",
    yamlPath: "Economy.Enabled",
    lineNumber: 3,
    snippet: "Economy:\n  Enabled: true",
    sourceUrl: "https://github.com/example/project/blob/abc/config.yml#L3",
  }];
}

test("Ollama accepts only loopback endpoints and non-cloud local model names", () => {
  assert.equal(normalizeLoopbackOllamaBaseUrl("http://127.0.0.1:11434"), "http://127.0.0.1:11434");
  assert.equal(normalizeLoopbackOllamaBaseUrl("http://[::1]:11434"), "http://[::1]:11434");
  assert.equal(normalizeLoopbackOllamaBaseUrl("http://localhost:11434"), "");
  assert.equal(normalizeLoopbackOllamaBaseUrl("https://127.0.0.1:11434"), "");
  assert.equal(normalizeLoopbackOllamaBaseUrl("http://example.com:11434"), "");
  assert.equal(isLocalOllamaModelName("qwen3:8b"), true);
  assert.equal(isLocalOllamaModelName("gpt-oss:20b-cloud"), false);
});

test("Ollama requests use structured local evidence without source URLs or operational metadata", async () => {
  let sent;
  const provider = new OllamaProvider(
    {
      baseUrl: "http://127.0.0.1:11434",
      model: "qwen3:8b",
      requestTimeoutMs: 1_000,
      maxOutputTokens: 200,
    },
    {
      async fetchImpl(url, options) {
        assert.equal(url, "http://127.0.0.1:11434/api/chat");
        sent = JSON.parse(options.body);
        return jsonResponse({
          model: "qwen3:8b",
          done: true,
          prompt_eval_count: 31,
          eval_count: 9,
          message: {
            content: JSON.stringify({
              answer: "Enable the indexed economy setting.",
              citations: ["E1"],
              confidence: "high",
            }),
          },
        });
      },
    },
  );

  const result = await provider.generate({
    question: "How do I enable the economy?",
    evidence: toProviderEvidence(makeEvidence()),
  });

  assert.equal(result.answer, "Enable the indexed economy setting.");
  assert.deepEqual(result.citations, ["E1"]);
  assert.deepEqual(result.usage, { inputTokens: 31, outputTokens: 9 });
  assert.equal(sent.stream, false);
  assert.equal(sent.think, false);
  assert.equal(sent.options.num_predict, 200);
  assert.equal("tools" in sent, false);
  const serialized = JSON.stringify(sent);
  assert.doesNotMatch(serialized, /github\.com|sourceUrl|channelId|userId|hostname/);
});

test("Ollama readiness checks require the exact configured local model", async () => {
  const provider = new OllamaProvider(
    { baseUrl: "http://127.0.0.1:11434", model: "qwen3:8b" },
    {
      fetchImpl: async (url, options) => {
        assert.equal(url, "http://127.0.0.1:11434/api/tags");
        assert.equal(options.redirect, "error");
        return jsonResponse({ models: [{ name: "qwen3:8b" }] });
      },
    },
  );
  assert.deepEqual(await provider.status(), { ready: true, reason: "ready" });
});

test("Ollama rejects invented citations and unsafe generated URLs", async () => {
  for (const content of [
    { answer: "Unsupported", citations: ["E999"], confidence: "high" },
    { answer: "See https://example.com", citations: ["E1"], confidence: "high" },
    { answer: "See [this](//example.com)", citations: ["E1"], confidence: "high" },
  ]) {
    const provider = new OllamaProvider(
      { baseUrl: "http://127.0.0.1:11434", model: "qwen3:8b" },
      {
        fetchImpl: async () => jsonResponse({
          model: "qwen3:8b",
          done: true,
          message: { content: JSON.stringify(content) },
        }),
      },
    );
    await assert.rejects(
      provider.generate({ question: "question", evidence: toProviderEvidence(makeEvidence()) }),
      OllamaError,
    );
  }
});

test("AI question validation rejects likely secrets, private IDs, and filesystem paths", () => {
  assert.equal(validateAiQuestion("How do I change the password setting?").ok, true);
  for (const question of [
    "password=super-secret-value",
    "read /etc/passwd please",
    "inspect ../private/secret.key",
    "my channel is 123456789012345678",
    "Authorization: Bearer abcdefghijklmnop",
  ]) {
    assert.equal(validateAiQuestion(question).ok, false, question);
  }
});

test("grounded evidence excludes unsafe paths and redacts secret-looking values", () => {
  const [safe] = extractEntriesFromText(
    "Database:\n  Password: very-secret-value\nFeature:\n  Enabled: true",
    "CMIPlugin/CMI/config.yml",
  ).filter((entry) => entry.yamlPath === "Database.Password");
  const unsafe = {
    ...safe,
    relativePath: "CMIPlugin/private/secret.key",
    snippet: "must-not-leak",
  };
  const config = {
    ai: { maxEvidenceItems: 6, maxEvidenceChars: 1_000 },
    search: {
      sourceLinksEnabled: true,
      sourceRepositoryUrl: "https://github.com/example/project",
    },
    sharedDebugRoots: [],
  };
  const plugin = { id: "cmi", debugRoots: ["CMIPlugin"] };
  const evidence = prepareGroundedEvidence(
    [
      { entry: safe, profileName: "config" },
      { entry: unsafe, profileName: "config" },
    ],
    {
      config,
      plugin,
      runtimeInfo: { fullRevision: "a".repeat(40) },
    },
  );

  assert.equal(evidence.length, 1);
  assert.match(evidence[0].snippet, /Password: <redacted>/);
  assert.doesNotMatch(JSON.stringify(evidence), /very-secret-value|must-not-leak|secret\.key/);
});

test("local provider failures are measured without retaining prompts and fall back to cited evidence", async () => {
  const records = [];
  const logs = [];
  const usage = [];
  const service = new GroundedAiService(
    {
      enabled: true,
      ollama: { enabled: true },
    },
    {
      provider: {
        async generate() {
          throw new OllamaError("service-unavailable");
        },
      },
      usageLedger: {
        async canRequest() {
          return { allowed: true };
        },
        async record(value) {
          usage.push(value);
        },
      },
      metrics: { recordAi: (value) => records.push(value) },
      logger: { warn: (event, fields) => logs.push({ event, fields }) },
      monotonicNow: (() => {
        let now = 0;
        return () => (now += 5);
      })(),
    },
  );

  const result = await service.answer({
    question: "private support question",
    evidence: makeEvidence(),
  });

  assert.equal(result.generated, false);
  assert.deepEqual(result.citations, ["E1"]);
  assert.equal(records[0].provider, "ollama");
  assert.equal(records[0].estimatedCostMicrousd, 0);
  assert.deepEqual(usage, [{ generated: false }]);
  const retained = JSON.stringify({ records, logs, usage });
  assert.doesNotMatch(retained, /private support question|Economy\.Enabled|github\.com/);
});

test("local generation is single-flight even while usage allowance is loading", async () => {
  let releaseAllowance;
  const allowance = new Promise((resolve) => {
    releaseAllowance = resolve;
  });
  let providerCalls = 0;
  const service = new GroundedAiService(
    { enabled: true, ollama: { enabled: true } },
    {
      provider: {
        async generate() {
          providerCalls += 1;
          return {
            answer: "Grounded answer.",
            citations: ["E1"],
            confidence: "high",
            usage: {},
          };
        },
      },
      usageLedger: {
        async canRequest() {
          return allowance;
        },
        async record() {},
      },
      logger: { warn() {} },
    },
  );

  const first = service.answer({ question: "first", evidence: makeEvidence() });
  const second = await service.answer({ question: "second", evidence: makeEvidence() });
  assert.equal(second.generated, false);
  assert.equal(second.reason, "busy");
  releaseAllowance({ allowed: true });
  assert.equal((await first).generated, true);
  assert.equal(providerCalls, 1);
});

test("AI usage persistence is owner-only, aggregate-only, and enforces local resource limits", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lookupbot-ai-usage-"));
  const fixedNow = new Date("2026-08-27T12:00:00.000Z").getTime();
  try {
    const ledger = new AiUsageLedger({
      workspaceRoot,
      statePath: "logs/ai-usage.json",
      dailyRequestLimit: 1,
      monthlyRequestLimit: 2,
    }, { now: () => fixedNow });
    assert.equal((await ledger.canRequest()).allowed, true);
    await ledger.record({
      generated: true,
      inputTokens: 12,
      outputTokens: 4,
      question: "must not persist",
      userId: "must not persist",
    });

    const snapshot = await ledger.getSnapshot();
    assert.deepEqual(snapshot.today, {
      requests: 1,
      generated: 1,
      inputTokens: 12,
      outputTokens: 4,
    });
    assert.deepEqual(await ledger.canRequest(), {
      allowed: false,
      reason: "daily-limit",
      snapshot,
    });
    const statePath = path.join(workspaceRoot, "logs/ai-usage.json");
    const contents = await fs.readFile(statePath, "utf8");
    assert.doesNotMatch(contents, /must not persist|question|userId/);
    assert.equal((await fs.stat(statePath)).mode & 0o077, 0);
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("malformed AI usage state fails closed instead of resetting resource limits", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lookupbot-ai-corrupt-"));
  try {
    await fs.mkdir(path.join(workspaceRoot, "logs"));
    await fs.writeFile(path.join(workspaceRoot, "logs/ai-usage.json"), "not-json\n", { mode: 0o600 });
    const ledger = new AiUsageLedger({
      workspaceRoot,
      statePath: "logs/ai-usage.json",
      dailyRequestLimit: 1,
      monthlyRequestLimit: 1,
    });
    await assert.rejects(ledger.canRequest());
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("local AI status output omits infrastructure and private identifiers", () => {
  const privateValues = ["private-host-alias", "/Users/private/service", "123456789012345678"];
  const message = formatAiStatusMessage({
    enabled: true,
    providerReady: true,
    providerReason: "ready",
    busy: false,
    endpoint: privateValues[0],
    path: privateValues[1],
    channelId: privateValues[2],
    usage: {
      today: { requests: 2, generated: 1, inputTokens: 10, outputTokens: 4 },
      month: { requests: 3, generated: 2, inputTokens: 20, outputTokens: 8 },
      dailyRequestLimit: 50,
      monthlyRequestLimit: 1_000,
    },
  });

  assert.match(message, /zero-cost, local-only/);
  assert.match(message, /Paid budget: `\$0\.00 hard limit`/);
  for (const privateValue of privateValues) {
    assert.doesNotMatch(message, new RegExp(privateValue.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});
