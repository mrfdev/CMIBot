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
import { createResultPagination } from "../src/discord/pagination.js";
import { extractEntriesFromText, makeDisplayContext } from "../src/yamlIndex.js";

const SILENT_LOGGER = {
  info() {},
  warn() {},
  error() {},
};

function createTestInteractionHandler(config, searchCache, versionService, dependencies = {}) {
  return createInteractionHandler(config, searchCache, versionService, {
    logger: SILENT_LOGGER,
    ...dependencies,
  });
}

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
    const handler = createTestInteractionHandler(makeConfig(workspaceRoot), {}, {});
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
    const handler = createTestInteractionHandler(makeConfig(workspaceRoot), {}, {});
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
    const handler = createTestInteractionHandler(makeConfig(workspaceRoot), {}, {});
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

test("health output is denied without an admin role", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lookupbot-health-role-"));
  const replies = [];

  try {
    const handler = createTestInteractionHandler(makeConfig(workspaceRoot), {}, {});
    const interaction = {
      isChatInputCommand: () => true,
      isRepliable: () => true,
      commandName: "lookup",
      guildId: "expected-guild",
      channelId: "channel-1",
      user: { id: "user-1", tag: "tester" },
      member: { roles: { cache: [] } },
      options: { getSubcommand: () => "health" },
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
    assert.equal(auditEntry.reason, "health-role");
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("alert tests are denied without an admin role", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lookupbot-alert-test-role-"));
  const replies = [];

  try {
    const handler = createTestInteractionHandler(makeConfig(workspaceRoot), {}, {}, {
      attentionMonitor: {
        async sendTestAlert() {
          throw new Error("unauthorized alert test must not run");
        },
      },
    });
    const interaction = {
      isChatInputCommand: () => true,
      isRepliable: () => true,
      commandName: "lookup",
      guildId: "expected-guild",
      channelId: "channel-1",
      user: { id: "user-1", tag: "tester" },
      member: { roles: { cache: [] } },
      options: { getSubcommand: () => "alerts-test" },
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
    assert.ok(replies[0].flags);
    const auditText = await fs.readFile(path.join(workspaceRoot, "logs/test-interactions.jsonl"), "utf8");
    const auditEntry = JSON.parse(auditText.trim());
    assert.equal(auditEntry.outcome, "denied");
    assert.equal(auditEntry.reason, "alerts-test-role");
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("an admin can send a private alert test without exposing its destination", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lookupbot-alert-test-admin-"));
  const responses = [];
  const deferrals = [];
  let sendCount = 0;

  try {
    const handler = createTestInteractionHandler(makeConfig(workspaceRoot), {}, {}, {
      attentionMonitor: {
        async sendTestAlert() {
          sendCount += 1;
          return { status: "sent" };
        },
      },
    });
    const interaction = {
      isChatInputCommand: () => true,
      isRepliable: () => true,
      commandName: "lookup",
      guildId: "expected-guild",
      channelId: "channel-1",
      user: { id: "admin-1", tag: "admin" },
      member: { roles: { cache: [{ id: "admin-role" }] } },
      options: { getSubcommand: () => "alerts-test" },
      replied: false,
      deferred: false,
      async deferReply(payload) {
        this.deferred = true;
        deferrals.push(payload);
      },
      async editReply(payload) {
        this.replied = true;
        responses.push(payload);
      },
    };

    await handler(interaction);

    assert.equal(sendCount, 1);
    assert.equal(deferrals.length, 1);
    assert.ok(deferrals[0].flags);
    assert.match(responses[0].content, /Test alert delivered/i);
    assert.deepEqual(responses[0].allowedMentions, { parse: [] });
    assert.doesNotMatch(responses[0].content, /channel-1|admin-1/);
    const auditText = await fs.readFile(path.join(workspaceRoot, "logs/test-interactions.jsonl"), "utf8");
    const auditEntry = JSON.parse(auditText.trim());
    assert.equal(auditEntry.outcome, "success");
    assert.equal(auditEntry.subcommand, "alerts-test");
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("authorized health output is private and uses live service state", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lookupbot-health-admin-"));
  const replies = [];
  const config = makeConfig(workspaceRoot);

  try {
    const handler = createTestInteractionHandler(
      config,
      {
        getGlobalSummary() {
          return {
            totalEntries: 12,
            totalFiles: 3,
            pluginSummaries: [{ pluginId: "cmi" }],
            lastReloadedAt: new Date(),
          };
        },
      },
      {
        getSnapshot() {
          return {
            catalog: { generatedAt: new Date().toISOString(), plugins: [{ id: "cmi" }] },
            checkEnabled: false,
            checkedAt: null,
            errorCount: 0,
            retainedCount: 0,
          };
        },
      },
      {
        client: { isReady: () => true, ws: { ping: 10 } },
        runtimeInfo: { release: "1.0.0 (abcdef123456)", startedAt: new Date(Date.now() - 1_000) },
        startupState: { ready: true },
      },
    );
    const interaction = {
      isChatInputCommand: () => true,
      isRepliable: () => true,
      commandName: "lookup",
      guildId: "expected-guild",
      channelId: "channel-1",
      user: { id: "admin-1", tag: "admin" },
      member: { roles: { cache: [{ id: "admin-role" }] } },
      options: { getSubcommand: () => "health" },
      replied: false,
      deferred: false,
      async reply(payload) {
        this.replied = true;
        replies.push(payload);
      },
    };

    await handler(interaction);

    assert.equal(replies.length, 1);
    assert.match(replies[0].content, /Lookup Health/);
    assert.match(replies[0].content, /Search cache: `ready, 12 entries from 3 files`/);
    assert.ok(replies[0].flags);
    assert.doesNotMatch(replies[0].content, /channel-1|admin-1/);
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("version changes stay private and audit only bounded aggregate counts", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lookupbot-version-changes-"));
  const config = makeConfig(workspaceRoot);
  const snapshot = {
    catalog: {
      generatedAt: new Date().toISOString(),
      plugins: [
        {
          id: "cmi",
          label: "CMI",
          version: "1.0.0",
          contextId: "cmi",
          resourceUrl: "https://www.spigotmc.org/resources/100/",
        },
        {
          id: "cmilib",
          label: "CMILib",
          version: "1.0.0",
          shared: true,
          resourceUrl: "https://www.spigotmc.org/resources/101/",
        },
      ],
      companions: [],
      paper: {
        id: "paper",
        label: "Paper",
        version: "26.2",
        build: 119,
        channel: "STABLE",
        projectUrl: "https://papermc.io/downloads/paper",
      },
    },
    plugins: new Map([
      ["cmi", { version: "1.1.0", stale: false }],
      ["cmilib", { version: "1.0.0", stale: false }],
    ]),
    companions: new Map(),
    paper: { version: "26.2", build: 119, channel: "STABLE", stale: false },
    checkEnabled: true,
    checkedAt: new Date().toISOString(),
    errorCount: 0,
    retainedCount: 0,
  };
  let changeRequests = 0;
  const versionService = {
    getSnapshot: () => snapshot,
    async getVersionChanges() {
      changeRequests += 1;
      return {
        status: "ready",
        scope: "context",
        pluginLabel: "CMI",
        changes: [
          {
            id: "cmi",
            label: "CMI",
            current: "1.0.0",
            latest: "1.1.0",
            upstream: { stale: false },
            historyUrl: "https://www.spigotmc.org/resources/100/updates",
            status: "available",
            error: false,
            releases: [
              {
                version: "1.1.0",
                url: "https://www.spigotmc.org/resources/100/update?update=10",
                items: [{ text: "Safe change for @everyone" }],
                omittedItemCount: 0,
              },
            ],
          },
        ],
        omittedResourceCount: 0,
        errorCount: 0,
        releaseCount: 1,
        itemCount: 1,
      };
    },
  };
  const handler = createTestInteractionHandler(config, {}, versionService);

  function makeLatestInteraction({ publicResponse, includeChanges = true }) {
    const replies = [];
    const deferrals = [];
    const edits = [];
    const followUps = [];
    return {
      replies,
      deferrals,
      edits,
      followUps,
      interaction: {
        isChatInputCommand: () => true,
        isRepliable: () => true,
        commandName: "lookup",
        guildId: "expected-guild",
        channelId: "channel-1",
        user: { id: "support-1", tag: "support" },
        member: { roles: { cache: [{ id: "support-role" }] } },
        options: {
          getSubcommand: () => "latest",
          getString: () => "context",
          getBoolean(name) {
            return (name === "changes" && includeChanges) || (name === "public" && publicResponse);
          },
        },
        replied: false,
        deferred: false,
        async reply(payload) {
          this.replied = true;
          replies.push(payload);
        },
        async deferReply(payload) {
          this.deferred = true;
          deferrals.push(payload);
        },
        async editReply(payload) {
          this.replied = true;
          edits.push(payload);
        },
        async followUp(payload) {
          followUps.push(payload);
        },
      },
    };
  }

  try {
    const defaultAttempt = makeLatestInteraction({
      publicResponse: false,
      includeChanges: false,
    });
    await handler(defaultAttempt.interaction);
    assert.equal(changeRequests, 0);
    assert.match(defaultAttempt.edits[0].content, /Latest Versions/);
    assert.equal(defaultAttempt.followUps.length, 0);

    const publicAttempt = makeLatestInteraction({ publicResponse: true });
    await handler(publicAttempt.interaction);
    assert.equal(changeRequests, 0);
    assert.match(publicAttempt.replies[0].content, /private-only/i);
    assert.ok(publicAttempt.replies[0].flags);

    const privateAttempt = makeLatestInteraction({ publicResponse: false });
    await handler(privateAttempt.interaction);
    assert.equal(changeRequests, 1);
    assert.ok(privateAttempt.deferrals[0].flags);
    assert.match(privateAttempt.edits[0].content, /Latest Versions/);
    assert.equal(privateAttempt.followUps.length, 1);
    assert.ok(privateAttempt.followUps[0].flags);
    assert.match(privateAttempt.followUps[0].content, /Version Changes/);
    assert.doesNotMatch(privateAttempt.followUps[0].content, /@everyone/);
    assert.deepEqual(privateAttempt.followUps[0].allowedMentions, { parse: [] });

    const auditText = await fs.readFile(
      path.join(workspaceRoot, "logs/test-interactions.jsonl"),
      "utf8",
    );
    const auditEntries = auditText.trim().split("\n").map((line) => JSON.parse(line));
    const success = auditEntries.find(
      (entry) => entry.outcome === "success" && entry.changes === true,
    );
    assert.equal(success.changeResourceCount, 1);
    assert.equal(success.releaseNoteCount, 1);
    assert.equal(success.releaseNoteItemCount, 1);
    assert.equal("releases" in success, false);
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("authorized autocomplete is context-aware, generation-cached, and unaudited", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lookupbot-autocomplete-"));
  const config = makeConfig(workspaceRoot);
  config.security.queryMaxLength = 80;
  config.sharedDebugRoots = [];
  config.plugins.cmi = {
    id: "cmi",
    label: "CMI",
    debugRoots: ["CMIPlugin"],
    profiles: { config: {} },
    commandAvailability: { config: "ready" },
  };
  let generation = 1;
  let entryName = "TeleportEnabled";
  let entryLoads = 0;
  const searchCache = {
    getGeneration: () => generation,
    getEntries() {
      entryLoads += 1;
      return [{
        relativePath: "CMIPlugin/CMI/config.yml",
        key: entryName,
        yamlPath: `Commands.${entryName}`,
      }];
    },
  };
  const handler = createTestInteractionHandler(config, searchCache, {});

  function makeAutocomplete(focusedValue) {
    const responses = [];
    return {
      responses,
      interaction: {
        isAutocomplete: () => true,
        isChatInputCommand: () => false,
        commandName: "lookup",
        guildId: "expected-guild",
        channelId: "channel-1",
        member: { roles: { cache: [{ id: "support-role" }] } },
        options: {
          getSubcommand: () => "config",
          getFocused: () => ({ name: "keyword", value: focusedValue }),
        },
        async respond(choices) {
          responses.push(choices);
        },
      },
    };
  }

  try {
    const first = makeAutocomplete("tele");
    await handler(first.interaction);
    assert.match(first.responses[0][0].value, /TeleportEnabled/);

    const sameGeneration = makeAutocomplete("chat");
    await handler(sameGeneration.interaction);
    assert.deepEqual(sameGeneration.responses[0], []);
    assert.equal(entryLoads, 1);

    generation = 2;
    entryName = "ChatFormat";
    const reloaded = makeAutocomplete("chat");
    await handler(reloaded.interaction);
    assert.ok(reloaded.responses[0].some((choice) => /ChatFormat/.test(choice.value)));
    assert.equal(entryLoads, 2);

    await assert.rejects(
      () => fs.access(path.join(workspaceRoot, "logs/test-interactions.jsonl")),
      { code: "ENOENT" },
    );
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("autocomplete fails closed before reading indexes for unauthorized members", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lookupbot-autocomplete-denied-"));
  const config = makeConfig(workspaceRoot);
  config.plugins.cmi = {
    id: "cmi",
    label: "CMI",
    debugRoots: ["CMIPlugin"],
    profiles: { config: {} },
    commandAvailability: { config: "ready" },
  };
  let cacheRead = false;
  const handler = createTestInteractionHandler(
    config,
    {
      getEntries() {
        cacheRead = true;
        throw new Error("unauthorized autocomplete must not read the cache");
      },
    },
    {},
  );
  const responses = [];
  const interaction = {
    isAutocomplete: () => true,
    isChatInputCommand: () => false,
    commandName: "lookup",
    guildId: "expected-guild",
    channelId: "channel-1",
    member: { roles: { cache: [] } },
    options: {
      getSubcommand: () => "config",
      getFocused: () => ({ name: "keyword", value: "tele" }),
    },
    async respond(choices) {
      responses.push(choices);
    },
  };

  try {
    await handler(interaction);
    assert.deepEqual(responses, [[]]);
    assert.equal(cacheRead, false);
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("pagination buttons revalidate the owning user, role, channel, context, and cache", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lookupbot-pagination-role-"));
  const pagination = createResultPagination(
    { paginationTtlMs: 10_000 },
    { createSessionId: () => "buttonSession01", now: () => 1_000 },
  );
  const session = pagination.createSession({
    ownerId: "support-user",
    guildId: "expected-guild",
    channelId: "channel-1",
    pluginId: "cmi",
    cacheGeneration: 4,
    keyword: "setting",
    results: [
      {
        displayPath: "CMIPlugin/config.yml",
        relativePath: "CMIPlugin/config.yml",
        yamlPath: "One",
        lineNumber: 1,
        snippet: "One: true",
        codeLanguage: "yml",
        sourceType: "yaml",
        related: [],
      },
      {
        displayPath: "CMIPlugin/config.yml",
        relativePath: "CMIPlugin/config.yml",
        yamlPath: "Two",
        lineNumber: 2,
        snippet: "Two: true",
        codeLanguage: "yml",
        sourceType: "yaml",
        related: [],
      },
    ],
    totalMentions: 2,
    fileCount: 1,
    pageSize: 1,
  });
  const nextCustomId = session.payload.components[0].components[2].custom_id;
  const handler = createTestInteractionHandler(
    makeConfig(workspaceRoot),
    { getGeneration: () => 4 },
    {},
    { pagination },
  );

  function makeButton(roleIds) {
    const replies = [];
    const updates = [];
    return {
      replies,
      updates,
      interaction: {
        isButton: () => true,
        isRepliable: () => true,
        customId: nextCustomId,
        guildId: "expected-guild",
        channelId: "channel-1",
        user: { id: "support-user", tag: "support" },
        member: { roles: { cache: roleIds.map((id) => ({ id })) } },
        replied: false,
        deferred: false,
        async reply(payload) {
          this.replied = true;
          replies.push(payload);
        },
        async update(payload) {
          this.replied = true;
          updates.push(payload);
        },
      },
    };
  }

  try {
    const denied = makeButton([]);
    await handler(denied.interaction);
    assert.match(denied.replies[0].content, /belong to the support member/i);
    assert.ok(denied.replies[0].flags);

    const allowed = makeButton(["support-role"]);
    await handler(allowed.interaction);
    assert.equal(allowed.updates.length, 1);
    assert.match(allowed.updates[0].content, /Two: true/);
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("expanded YAML controls reply privately after revalidating owner and role", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lookupbot-context-role-"));
  const pagination = createResultPagination(
    { paginationTtlMs: 10_000 },
    { createSessionId: () => "contextControl01", now: () => 1_000 },
  );
  const entries = extractEntriesFromText(
    [
      "Root:",
      "  Before: true",
      "  Target:",
      "    Nested:",
      "      Value: two",
      "  After: false",
    ].join("\n"),
    "CMIPlugin/config.yml",
  );
  const entry = entries.find((candidate) => candidate.yamlPath === "Root.Target");
  const result = makeDisplayContext(entry, "cmi", (_pluginId, relativePath) => relativePath, {
    includeIndexedYamlContext: true,
  });
  result.related = [];
  const session = pagination.createSession({
    ownerId: "support-user",
    guildId: "expected-guild",
    channelId: "channel-1",
    pluginId: "cmi",
    cacheGeneration: 4,
    keyword: "target",
    results: [result],
    totalMentions: 1,
    fileCount: 1,
    pageSize: 1,
  });
  const contextMenu = session.payload.components[0].components[0];
  const handler = createTestInteractionHandler(
    makeConfig(workspaceRoot),
    { getGeneration: () => 4 },
    {},
    { pagination },
  );

  function makeSelection(roleIds) {
    const replies = [];
    return {
      replies,
      interaction: {
        isButton: () => false,
        isStringSelectMenu: () => true,
        isRepliable: () => true,
        customId: contextMenu.custom_id,
        values: [contextMenu.options[0].value],
        attachmentSizeLimit: 8 * 1024 * 1024,
        guildId: "expected-guild",
        channelId: "channel-1",
        user: { id: "support-user", tag: "support" },
        member: { roles: { cache: roleIds.map((id) => ({ id })) } },
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
    const denied = makeSelection([]);
    await handler(denied.interaction);
    assert.match(denied.replies[0].content, /belong to the support member/i);
    assert.ok(denied.replies[0].flags);

    const allowed = makeSelection(["support-role"]);
    await handler(allowed.interaction);
    assert.equal(allowed.replies.length, 1);
    assert.ok(allowed.replies[0].flags);
    assert.deepEqual(allowed.replies[0].allowedMentions, { parse: [] });
    assert.match(allowed.replies[0].content, /Expanded YAML Context/);
    assert.match(allowed.replies[0].content, /Nested:\n      Value: two/);

    await assert.rejects(
      () => fs.access(path.join(workspaceRoot, "logs/test-interactions.jsonl")),
      { code: "ENOENT" },
    );
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("the per-user window follows a user across different subcommands", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lookupbot-user-window-"));
  const config = makeConfig(workspaceRoot);
  config.security.commandUserRateLimit = 1;
  const handler = createTestInteractionHandler(config, {}, {});

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
  const handler = createTestInteractionHandler(config, searchCache, {});

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

test("commands emit a request ID and completion timing", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lookupbot-request-logging-"));
  const records = [];
  const commandMetrics = [];
  let tick = 100;
  const logger = {
    info(event, fields) {
      records.push({ level: "info", event, ...fields });
    },
    warn(event, fields) {
      records.push({ level: "warn", event, ...fields });
    },
    error(event, fields) {
      records.push({ level: "error", event, ...fields });
    },
  };

  try {
    const handler = createTestInteractionHandler(
      makeConfig(workspaceRoot),
      {
        getPluginSummary() {
          return {
            pluginId: "cmi",
            pluginLabel: "CMI",
            totalEntries: 1,
            totalFiles: 1,
            profileSummaries: [],
          };
        },
      },
      {},
      {
        logger,
        createRequestId: () => "request-fixed",
        monotonicNow: () => ++tick,
        metrics: {
          recordCommand(payload) {
            commandMetrics.push(payload);
          },
        },
      },
    );
    const interaction = {
      isChatInputCommand: () => true,
      isRepliable: () => true,
      commandName: "lookup",
      guildId: "expected-guild",
      channelId: "channel-1",
      user: { id: "support-1", tag: "support" },
      member: { roles: { cache: [{ id: "support-role" }] } },
      options: { getSubcommand: () => "stats" },
      replied: false,
      deferred: false,
      async deferReply() {
        this.deferred = true;
      },
      async editReply() {
        this.replied = true;
      },
    };

    await handler(interaction);

    const started = records.find((record) => record.event === "discord.command.started");
    const completed = records.find((record) => record.event === "discord.command.completed");
    assert.equal(started.requestId, "request-fixed");
    assert.equal(completed.requestId, "request-fixed");
    assert.equal(completed.outcome, "success");
    assert.ok(completed.durationMs > 0);
    assert.deepEqual(commandMetrics, [{ durationMs: completed.durationMs, outcome: "success" }]);

    const auditText = await fs.readFile(path.join(workspaceRoot, "logs/test-interactions.jsonl"), "utf8");
    const auditEntry = JSON.parse(auditText.trim());
    assert.equal(auditEntry.requestId, "request-fixed");
    assert.ok(auditEntry.elapsedMs > 0);
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
  const handler = createTestInteractionHandler(config, searchCache, versionService);

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

test("an admin can reload one profile without refreshing version data", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lookupbot-selective-reload-"));
  const config = makeConfig(workspaceRoot);
  config.plugins.cmi.profiles = { config: {} };
  const responses = [];
  let receivedScope;
  let versionPreparations = 0;
  const reloadMetrics = [];
  const searchCache = {
    async prepareReload(scope) {
      receivedScope = scope;
      return {
        scope: { type: "profile", ...scope },
        commit() {
          return {
            totalEntries: 2,
            totalFiles: 1,
            pluginSummaries: [
              {
                pluginId: "cmi",
                pluginLabel: "CMI",
                totalEntries: 2,
                totalFiles: 1,
                profileSummaries: [
                  { profileName: "config", entryCount: 2, fileCount: 1 },
                ],
              },
            ],
          };
        },
      };
    },
  };
  const versionService = {
    prepareReload() {
      versionPreparations += 1;
      throw new Error("version reload should not run");
    },
    getSnapshot() {
      return { errorCount: 0 };
    },
  };

  try {
    const handler = createTestInteractionHandler(config, searchCache, versionService, {
      metrics: {
        recordCommand() {},
        recordReload(payload) {
          reloadMetrics.push(payload);
        },
      },
    });
    const interaction = {
      isChatInputCommand: () => true,
      isRepliable: () => true,
      commandName: "lookup",
      guildId: "expected-guild",
      channelId: "channel-1",
      user: { id: "admin-1", tag: "admin" },
      member: { roles: { cache: [{ id: "admin-role" }] } },
      options: {
        getSubcommand: () => "reload",
        getString(name) {
          return name === "profile" ? "config" : null;
        },
      },
      replied: false,
      deferred: false,
      async deferReply() {
        this.deferred = true;
      },
      async editReply(payload) {
        this.replied = true;
        responses.push(payload);
      },
      async followUp(payload) {
        responses.push(payload);
      },
    };

    await handler(interaction);

    assert.deepEqual(receivedScope, { pluginId: "cmi", profileName: "config" });
    assert.equal(versionPreparations, 0);
    assert.match(responses[0].content, /Only the CMI config profile was refreshed/i);
    assert.equal(reloadMetrics.length, 1);
    assert.equal(reloadMetrics[0].outcome, "success");
    assert.equal(reloadMetrics[0].scope, "profile");
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

test("a selective reload leaves the version service untouched", async () => {
  let receivedScope;
  let versionPreparations = 0;
  const searchCache = {
    async prepareReload(scope) {
      receivedScope = scope;
      return {
        scope: { type: "profile", ...scope },
        commit() {
          return { totalEntries: 1, totalFiles: 1 };
        },
        discard() {},
      };
    },
  };
  const versionSnapshot = { catalog: { generatedAt: "unchanged" } };
  const versionService = {
    async prepareReload() {
      versionPreparations += 1;
      throw new Error("should not run");
    },
    getSnapshot() {
      return versionSnapshot;
    },
  };

  const result = await reloadServicesAtomically(searchCache, versionService, {
    pluginId: "cmi",
    profileName: "config",
  });

  assert.deepEqual(receivedScope, { pluginId: "cmi", profileName: "config" });
  assert.equal(versionPreparations, 0);
  assert.strictEqual(result.versionSnapshot, versionSnapshot);
  assert.equal(result.scope.type, "profile");
});
