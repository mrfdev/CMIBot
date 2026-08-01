import assert from "node:assert/strict";
import test from "node:test";
import { validateBotConfig } from "../src/config.js";

const REQUIRED_ENV = {
  DISCORD_TOKEN: "test-token",
  DISCORD_APPLICATION_ID: "test-application",
  DISCORD_GUILD_ID: "test-guild",
};

function withRequiredEnvironment(callback) {
  const original = Object.fromEntries(
    Object.keys(REQUIRED_ENV).map((name) => [name, process.env[name]]),
  );

  Object.assign(process.env, REQUIRED_ENV);
  try {
    callback();
  } finally {
    for (const [name, value] of Object.entries(original)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
}

function makeConfig(openai, aiRoleIds = []) {
  return {
    openai,
    discord: {
      allowedChannelIds: ["channel"],
      testDefaultContext: "cmi",
      allowedRoleIds: ["support"],
      adminRoleIds: ["admin"],
      aiRoleIds,
    },
    plugins: {
      cmi: {},
    },
  };
}

test("disabled AI does not require an API key or AI role IDs", () => {
  withRequiredEnvironment(() => {
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
});

test("enabled AI requires an API key", () => {
  withRequiredEnvironment(() => {
    assert.throws(
      () =>
        validateBotConfig(
          makeConfig(
            {
              enabled: true,
              apiKey: "",
              model: "gpt-5-mini",
            },
            ["ai-role"],
          ),
        ),
      /OPENAI_API_KEY/,
    );
  });
});

test("enabled AI requires an allowed AI role", () => {
  withRequiredEnvironment(() => {
    assert.throws(
      () =>
        validateBotConfig(
          makeConfig({
            enabled: true,
            apiKey: "test-key",
            model: "gpt-5-mini",
          }),
        ),
      /AI_ROLE_IDS/,
    );
  });
});
