import assert from "node:assert/strict";
import test from "node:test";
import { createLazyAiResolver, isAiEnabled } from "../src/aiLoader.js";

test("disabled local AI never loads its module", async () => {
  let loadCount = 0;
  const resolveAiService = createLazyAiResolver(
    { enabled: false },
    {
      loadAiModule: async () => {
        loadCount += 1;
        throw new Error("disabled AI attempted to load");
      },
    },
  );

  assert.equal(isAiEnabled({ enabled: false }), false);
  assert.equal(await resolveAiService(), null);
  assert.equal(await resolveAiService(), null);
  assert.equal(loadCount, 0);
});

test("enabled local AI needs no API key and constructs its service once", async () => {
  let loadCount = 0;
  let constructionCount = 0;
  const config = { enabled: true };
  const resolveAiService = createLazyAiResolver(config, {
    workspaceRoot: "/private/workspace",
    loadAiModule: async () => {
      loadCount += 1;
      return {
        GroundedAiService: class {
          constructor(receivedConfig, options) {
            constructionCount += 1;
            assert.equal(receivedConfig, config);
            assert.equal(options.workspaceRoot, "/private/workspace");
          }
        },
      };
    },
  });

  assert.equal(isAiEnabled({ enabled: true }), true);
  assert.equal(loadCount, 0);
  const first = await resolveAiService();
  const second = await resolveAiService();

  assert.equal(first, second);
  assert.equal(loadCount, 1);
  assert.equal(constructionCount, 1);
});
