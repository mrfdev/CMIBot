import assert from "node:assert/strict";
import test from "node:test";
import { AiReranker } from "../src/ai.js";

function candidate(snippet, lineNumber) {
  return {
    entry: {
      relativePath: "Plugin/config.yml",
      yamlPath: "Feature.Enabled",
      lineNumber,
      snippet,
    },
  };
}

test("AI metrics count reported tokens without retaining prompt content", async () => {
  const records = [];
  const reranker = new AiReranker(
    { apiKey: "test-key", model: "test-model" },
    { metrics: { recordAi: (payload) => records.push(payload) } },
  );
  reranker.client = {
    responses: {
      async create() {
        return {
          output_text: '{"ranked_ids":["1","0"]}',
          usage: { input_tokens: 20, output_tokens: 4, total_tokens: 24 },
        };
      },
    },
  };
  const candidates = [candidate("private first prompt", 1), candidate("private second prompt", 2)];

  const result = await reranker.rerank("private query", candidates);

  assert.strictEqual(result[0], candidates[1]);
  assert.equal(records.length, 1);
  assert.deepEqual(
    {
      operation: records[0].operation,
      outcome: records[0].outcome,
      inputTokens: records[0].inputTokens,
      outputTokens: records[0].outputTokens,
      totalTokens: records[0].totalTokens,
    },
    { operation: "rerank", outcome: "success", inputTokens: 20, outputTokens: 4, totalTokens: 24 },
  );
  assert.doesNotMatch(JSON.stringify(records), /private|query|prompt/);
});

test("AI request failures are measured and safely fall back", async (t) => {
  t.mock.method(console, "error", () => {});
  const records = [];
  const reranker = new AiReranker(
    { apiKey: "test-key", model: "test-model" },
    { metrics: { recordAi: (payload) => records.push(payload) } },
  );
  reranker.client = {
    responses: {
      async create() {
        throw new Error("provider unavailable");
      },
    },
  };
  const candidates = [candidate("first", 1), candidate("second", 2)];

  assert.strictEqual(await reranker.rerank("query", candidates), candidates);
  assert.equal(records.length, 1);
  assert.equal(records[0].operation, "rerank");
  assert.equal(records[0].outcome, "error");
});
