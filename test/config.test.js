import assert from "node:assert/strict";
import test from "node:test";
import { validateBotConfig } from "../src/config.js";

function makeAi(overrides = {}) {
  const { ollama = {}, ...rest } = overrides;
  return {
    enabled: false,
    externalProvidersEnabled: false,
    paidBudgetUsd: 0,
    usageStatePath: "logs/ai-usage.json",
    ollama: {
      enabled: true,
      baseUrl: "http://127.0.0.1:11434",
      model: "qwen3:8b",
      ...ollama,
    },
    ...rest,
  };
}

function makeConfig(ai, aiRoleIds = []) {
  return {
    workspaceRoot: "/unused",
    ai: makeAi(ai),
    discord: {
      token: "test-token",
      applicationId: "test-application",
      guildId: "test-guild",
      allowedChannelIds: ["channel"],
      pluginChannelIds: {
        cmi: ["channel"],
      },
      testChannelIds: [],
      testDefaultContext: "cmi",
      allowedRoleIds: ["support"],
      adminRoleIds: ["admin"],
      aiRoleIds,
    },
    security: {
      auditLogPath: "logs/audit.jsonl",
    },
    search: {
      defaultResultLimit: 3,
      maxResultLimit: 15,
      synonymsPath: "data/search-synonyms.json",
      synonymsByPlugin: {},
    },
    versions: {
      catalogPath: "data/versions.json",
      statePath: "logs/versions.json",
      checkIntervalMs: 60_000,
      requestTimeoutMs: 1_000,
    },
    logging: {
      maxBytes: 1024,
      maxFiles: 2,
      minFreeBytes: 1024,
    },
    metrics: {
      logIntervalMs: 60_000,
    },
    plugins: {
      cmi: {
        id: "cmi",
        label: "CMI",
        commandAvailability: {
          config: "ready",
        },
        profiles: {
          config: {
            name: "config",
            sourceType: "yaml",
            include: ["CMIPlugin/config.yml"],
            exclude: [],
          },
        },
      },
    },
  };
}

test("disabled local AI does not require AI role IDs", () => {
  assert.doesNotThrow(() =>
    validateBotConfig(
      makeConfig({
        enabled: false,
        apiKey: "",
        model: "gpt-5-mini",
      }),
    ),
  );
});

test("external AI providers fail closed", () => {
  assert.throws(
    () =>
      validateBotConfig(
        makeConfig(
          {
            enabled: true,
            externalProvidersEnabled: true,
          },
          ["ai-role"],
        ),
      ),
    /AI_EXTERNAL_PROVIDERS_ENABLED/,
  );
});

test("enabled AI requires an allowed AI role", () => {
  assert.throws(
    () =>
      validateBotConfig(
        makeConfig({
          enabled: true,
        }),
      ),
    /AI_ROLE_IDS/,
  );
});

test("zero-cost mode rejects any nonzero paid budget", () => {
  assert.throws(
    () => validateBotConfig(makeConfig({ paidBudgetUsd: 0.01 }, ["ai-role"])),
    /AI_PAID_BUDGET_USD/,
  );
});

test("local AI rejects remote endpoints and cloud model names", () => {
  assert.throws(
    () => validateBotConfig(makeConfig({
      ollama: { baseUrl: "https://example.com", model: "qwen3:8b", enabled: true },
    }, ["ai-role"])),
    /loopback-only/,
  );
  assert.throws(
    () => validateBotConfig(makeConfig({
      ollama: { baseUrl: "http://127.0.0.1:11434", model: "gpt-oss:20b-cloud", enabled: true },
    }, ["ai-role"])),
    /non-cloud/,
  );
});

test("duplicate Discord routes fail closed without echoing channel IDs", () => {
  const config = makeConfig({ enabled: false, apiKey: "", model: "gpt-5-mini" });
  config.discord.allowedChannelIds = ["123456789012345678"];
  config.discord.pluginChannelIds.cmi = ["123456789012345678"];
  config.discord.testChannelIds = ["123456789012345678"];

  assert.throws(
    () => validateBotConfig(config),
    (error) => {
      assert.match(error.message, /more than one route/i);
      assert.doesNotMatch(error.message, /123456789012345678/);
      return true;
    },
  );
});

test("profile include globs cannot escape the project workspace", () => {
  const config = makeConfig({ enabled: false, apiKey: "", model: "gpt-5-mini" });
  config.plugins.cmi.profiles.config.include = ["../private-file"];

  assert.throws(
    () => validateBotConfig(config),
    (error) => {
      assert.match(error.message, /project workspace/i);
      assert.doesNotMatch(error.message, /private-file/);
      return true;
    },
  );
});

test("search synonyms cannot reference an unknown plugin context", () => {
  const config = makeConfig({ enabled: false, apiKey: "", model: "gpt-5-mini" });
  config.search.synonymsByPlugin = {
    unknown: {
      short: ["expanded term"],
    },
  };

  assert.throws(() => validateBotConfig(config), /unknown plugin context/i);
});

test("source links reject non-public repository hosts without echoing them", () => {
  const config = makeConfig({ enabled: false, apiKey: "", model: "gpt-5-mini" });
  config.search.sourceLinksEnabled = true;
  config.search.sourceRepositoryUrl = "https://private-host-alias/internal/repository";

  assert.throws(
    () => validateBotConfig(config),
    (error) => {
      assert.match(error.message, /public HTTPS GitHub repository/i);
      assert.doesNotMatch(error.message, /private-host-alias/);
      return true;
    },
  );
});
