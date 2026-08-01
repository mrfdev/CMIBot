import assert from "node:assert/strict";
import test from "node:test";
import { createLazyAiResolver, isAiEnabled } from "../src/aiLoader.js";

test("disabled AI never loads its module", async () => {
  let loadCount = 0;
  const resolveAiReranker = createLazyAiResolver(
    {
      enabled: false,
      apiKey: "unused-key",
      model: "unused-model",
    },
    {
      loadAiModule: async () => {
        loadCount += 1;
        throw new Error("disabled AI attempted to load");
      },
    },
  );

  assert.equal(isAiEnabled({ enabled: false, apiKey: "unused-key" }), false);
  assert.equal(await resolveAiReranker(), null);
  assert.equal(await resolveAiReranker(), null);
  assert.equal(loadCount, 0);
});

test("AI without an API key remains disabled", async () => {
  let loadCount = 0;
  const resolveAiReranker = createLazyAiResolver(
    {
      enabled: true,
      apiKey: "",
      model: "unused-model",
    },
    {
      loadAiModule: async () => {
        loadCount += 1;
        return { AiReranker: class {} };
      },
    },
  );

  assert.equal(isAiEnabled({ enabled: true, apiKey: "" }), false);
  assert.equal(await resolveAiReranker(), null);
  assert.equal(loadCount, 0);
});

test("enabled AI loads and constructs its module once on first use", async () => {
  let loadCount = 0;
  let constructionCount = 0;
  const config = {
    enabled: true,
    apiKey: "test-key",
    model: "test-model",
  };
  const resolveAiReranker = createLazyAiResolver(config, {
    loadAiModule: async () => {
      loadCount += 1;
      return {
        AiReranker: class {
          constructor(receivedConfig) {
            constructionCount += 1;
            assert.equal(receivedConfig, config);
          }
        },
      };
    },
  });

  assert.equal(loadCount, 0);
  const first = await resolveAiReranker();
  const second = await resolveAiReranker();

  assert.equal(first, second);
  assert.equal(loadCount, 1);
  assert.equal(constructionCount, 1);
});
