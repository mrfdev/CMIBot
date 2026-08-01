import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createInteractionHandler,
  createSafeInteractionListener,
  reloadServicesAtomically,
} from "../src/discordBot.js";

function makeConfig(workspaceRoot) {
  return {
    workspaceRoot,
    openai: {
      enabled: false,
      apiKey: "",
      model: "gpt-5-mini",
    },
    security: {
      auditLogPath: "logs/test-interactions.jsonl",
      commandUserRateLimit: 0,
      commandChannelRateLimit: 0,
      commandGlobalRateLimit: 0,
      commandRateWindowSeconds: 30,
      debugCooldownSeconds: 0,
      reloadCooldownSeconds: 0,
      rateLimitAuditCooldownSeconds: 30,
    },
    discord: {
      guildId: "expected-guild",
      allowedChannelIds: ["channel-1"],
      testChannelIds: [],
      testDefaultContext: "cmi",
      pluginChannelIds: {
        cmi: ["channel-1"],
      },
      adminRoleIds: ["admin-role"],
      allowedRoleIds: ["support-role"],
    },
    plugins: {
      cmi: {
        id: "cmi",
        label: "CMI",
      },
    },
  };
}

function makeRejectedInteraction({ rejectFallback = false } = {}) {
  const replies = [];
  let replyCount = 0;

  return {
    interaction: {
      isChatInputCommand: () => true,
      isRepliable: () => true,
      commandName: "lookup",
      guildId: "wrong-guild",
      channelId: "channel-1",
      user: {
        id: "user-1",
        tag: "tester",
      },
      replied: false,
      deferred: false,
      async reply(payload) {
        replyCount += 1;
        if (replyCount === 1 || rejectFallback) {
          throw new Error(replyCount === 1 ? "Discord rejected the command reply" : "Discord rejected the fallback");
        }
        this.replied = true;
        replies.push(payload);
      },
    },
    replies,
    getReplyCount: () => replyCount,
  };
}

test("an unexpected reply failure is audited and contained", async (t) => {
  t.mock.method(console, "error", () => {});
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lookupbot-interaction-"));

  try {
    const handler = createInteractionHandler(makeConfig(workspaceRoot), {}, {});
    const fixture = makeRejectedInteraction();

    await assert.doesNotReject(() => handler(fixture.interaction));

    assert.equal(fixture.getReplyCount(), 2);
    assert.equal(fixture.replies.length, 1);
    assert.match(fixture.replies[0].content, /unexpected error/i);
    assert.doesNotMatch(fixture.replies[0].content, /Discord rejected/);

    const auditText = await fs.readFile(path.join(workspaceRoot, "logs/test-interactions.jsonl"), "utf8");
    const auditEntry = JSON.parse(auditText.trim());
    assert.equal(auditEntry.outcome, "unexpected-error");
    assert.equal(auditEntry.reason, "Discord rejected the command reply");
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("a rejected fallback response cannot escape the interaction boundary", async (t) => {
  t.mock.method(console, "error", () => {});
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lookupbot-interaction-"));

  try {
    const handler = createInteractionHandler(makeConfig(workspaceRoot), {}, {});
    const fixture = makeRejectedInteraction({ rejectFallback: true });

    await assert.doesNotReject(() => handler(fixture.interaction));
    assert.equal(fixture.getReplyCount(), 2);
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("a failure in the recovery function is also contained", async (t) => {
  t.mock.method(console, "error", () => {});
  const listener = createSafeInteractionListener(
    () => {
      throw new Error("handler failed");
    },
    () => {
      throw new Error("recovery failed");
    },
  );

  await assert.doesNotReject(() => listener({}));
});

test("debug output is denied without an admin role", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lookupbot-debug-role-"));
  const replies = [];

  try {
    const handler = createInteractionHandler(makeConfig(workspaceRoot), {}, {});
    const interaction = {
      isChatInputCommand: () => true,
      isRepliable: () => true,
      commandName: "lookup",
      guildId: "expected-guild",
      channelId: "channel-1",
      user: {
        id: "user-1",
        tag: "tester",
      },
      member: {
        roles: {
          cache: [],
        },
      },
      options: {
        getSubcommand: () => "debug",
      },
      replied: false,
      deferred: false,
      async reply(payload) {
        this.replied = true;
        replies.push(payload);
      },
    };

    await handler(interaction);

    assert.equal(replies.length, 1);
    assert.match(replies[0].content, /Only the configured admin role/i);
    const auditText = await fs.readFile(path.join(workspaceRoot, "logs/test-interactions.jsonl"), "utf8");
    const auditEntry = JSON.parse(auditText.trim());
    assert.equal(auditEntry.outcome, "denied");
    assert.equal(auditEntry.reason, "debug-role");
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("the per-user window follows a user across different subcommands", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lookupbot-user-window-"));
  const config = makeConfig(workspaceRoot);
  config.security.commandUserRateLimit = 1;
  const handler = createInteractionHandler(config, {}, {});

  function makeInteraction(subcommand) {
    const replies = [];
    return {
      replies,
      interaction: {
        isChatInputCommand: () => true,
        isRepliable: () => true,
        commandName: "lookup",
        guildId: "expected-guild",
        channelId: "channel-1",
        user: {
          id: "same-user",
          tag: "tester",
        },
        member: {
          roles: {
            cache: [],
          },
        },
        options: {
          getSubcommand: () => subcommand,
        },
        replied: false,
        deferred: false,
        async reply(payload) {
          this.replied = true;
          replies.push(payload);
        },
      },
    };
  }

  try {
    const debug = makeInteraction("debug");
    const reload = makeInteraction("reload");
    const stats = makeInteraction("stats");

    await handler(debug.interaction);
    await handler(reload.interaction);
    await handler(stats.interaction);

    assert.match(debug.replies[0].content, /Only the configured admin role/i);
    assert.match(reload.replies[0].content, /sending bot commands too quickly/i);
    assert.match(stats.replies[0].content, /sending bot commands too quickly/i);

    const auditText = await fs.readFile(path.join(workspaceRoot, "logs/test-interactions.jsonl"), "utf8");
    assert.equal(auditText.trim().split("\n").length, 2);
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("authorized commands share a channel-wide request window", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lookupbot-channel-window-"));
  const config = makeConfig(workspaceRoot);
  config.security.commandUserRateLimit = 10;
  config.security.commandChannelRateLimit = 1;
  config.security.commandGlobalRateLimit = 10;
  const searchCache = {
    getPluginSummary() {
      return {
        pluginId: "cmi",
        pluginLabel: "CMI",
        totalEntries: 0,
        totalFiles: 0,
        profileSummaries: [],
      };
    },
  };
  const handler = createInteractionHandler(config, searchCache, {});

  function makeStatsInteraction(userId) {
    const responses = [];
    return {
      responses,
      interaction: {
        isChatInputCommand: () => true,
        isRepliable: () => true,
        commandName: "lookup",
        guildId: "expected-guild",
        channelId: "channel-1",
        user: {
          id: userId,
          tag: userId,
        },
        member: {
          roles: {
            cache: [{ id: "support-role" }],
          },
        },
        options: {
          getSubcommand: () => "stats",
        },
        replied: false,
        deferred: false,
        async reply(payload) {
          this.replied = true;
          responses.push(payload);
        },
        async deferReply() {
          this.deferred = true;
        },
        async editReply(payload) {
          this.replied = true;
          responses.push(payload);
        },
      },
    };
  }

  try {
    const first = makeStatsInteraction("support-1");
    const second = makeStatsInteraction("support-2");

    await handler(first.interaction);
    await handler(second.interaction);

    assert.match(first.responses[0].content, /Lookup Stats/i);
    assert.match(second.responses[0].content, /channel is receiving too many bot requests/i);
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("only one global reload can prepare data at a time", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lookupbot-reload-guard-"));
  const config = makeConfig(workspaceRoot);
  let rejectPreparation;
  let preparationStarted;
  let blockPreparation = true;
  const started = new Promise((resolve) => {
    preparationStarted = resolve;
  });
  const searchCache = {
    prepareReload() {
      if (!blockPreparation) {
        return Promise.reject(new Error("test reload failure"));
      }
      preparationStarted();
      return new Promise((resolve, reject) => {
        rejectPreparation = reject;
      });
    },
  };
  const versionService = {
    async prepareReload() {
      return {
        commit() {
          return {};
        },
        discard() {},
      };
    },
  };
  const handler = createInteractionHandler(config, searchCache, versionService);

  function makeReloadInteraction(userId) {
    const responses = [];
    return {
      responses,
      interaction: {
        isChatInputCommand: () => true,
        isRepliable: () => true,
        commandName: "lookup",
        guildId: "expected-guild",
        channelId: "channel-1",
        user: {
          id: userId,
          tag: userId,
        },
        member: {
          roles: {
            cache: [{ id: "admin-role" }],
          },
        },
        options: {
          getSubcommand: () => "reload",
        },
        replied: false,
        deferred: false,
        async reply(payload) {
          this.replied = true;
          responses.push(payload);
        },
        async deferReply() {
          this.deferred = true;
        },
        async editReply(payload) {
          this.replied = true;
          responses.push(payload);
        },
      },
    };
  }

  try {
    const first = makeReloadInteraction("admin-1");
    const second = makeReloadInteraction("admin-2");
    const firstReload = handler(first.interaction);

    await started;
    await handler(second.interaction);
    assert.match(second.responses[0].content, /already in progress/i);

    blockPreparation = false;
    rejectPreparation(new Error("finish test reload"));
    await firstReload;
    assert.match(first.responses[0].content, /existing cache and version snapshots remain active/i);

    const third = makeReloadInteraction("admin-3");
    await handler(third.interaction);
    assert.doesNotMatch(third.responses[0].content, /already in progress/i);
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("cross-service reload discards prepared data when either side fails", async () => {
  let cacheCommits = 0;
  let cacheDiscards = 0;
  const searchCache = {
    async prepareReload() {
      return {
        commit() {
          cacheCommits += 1;
          return {};
        },
        discard() {
          cacheDiscards += 1;
        },
      };
    },
  };
  const versionService = {
    async prepareReload() {
      throw new Error("broken version catalog");
    },
  };

  await assert.rejects(
    () => reloadServicesAtomically(searchCache, versionService),
    /version catalog: broken version catalog/,
  );
  assert.equal(cacheCommits, 0);
  assert.equal(cacheDiscards, 1);
});
