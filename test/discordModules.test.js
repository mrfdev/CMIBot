import assert from "node:assert/strict";
import test from "node:test";
import { buildCommandData } from "../src/discord/commands.js";
import {
  formatIndexedCategoriesMessage,
  formatIndexedFilesMessage,
  isSafeIndexedRelativePath,
  listSafeIndexedFiles,
} from "../src/discord/browse.js";
import {
  getCommandAvailability,
  hasRole,
  resolveCanonicalSubcommand,
  resolveChannelContext,
} from "../src/discord/context.js";
import { formatBytes, formatDuration } from "../src/discord/debug.js";
import { formatHelpMessage } from "../src/discord/help.js";
import { createResultPagination } from "../src/discord/pagination.js";
import {
  formatResultsMessage,
  splitDiscordMessages,
  truncateDiscordMessage,
} from "../src/discord/results.js";
import { handleSearchInteraction } from "../src/discord/searchInteraction.js";
import { resolveReloadScope } from "../src/discord/safety.js";
import { extractEntriesFromText } from "../src/yamlIndex.js";

function makePlugin(id = "cmi", label = "CMI") {
  return {
    id,
    label,
    profiles: {
      material: {
        defaultResultLimit: 25,
      },
    },
    commandAvailability: {
      config: "ready",
      language: "ready",
      placeholder: "ready",
      material: "ready",
      command: "ready",
      permission: "ready",
      faq: "ready",
      tabcomplete: "ready",
    },
  };
}

function makeConfig() {
  const cmi = makePlugin();
  const jobs = makePlugin("jobs", "Jobs");
  return {
    search: {
      defaultResultLimit: 3,
    },
    openai: {
      enabled: false,
    },
    discord: {
      allowedRoleIds: ["support-role"],
      adminRoleIds: ["admin-role"],
      aiRoleIds: ["admin-role"],
      testChannelIds: ["test-channel"],
      testDefaultContext: "cmi",
      pluginChannelIds: {
        cmi: ["cmi-channel"],
        jobs: ["jobs-channel"],
      },
    },
    plugins: { cmi, jobs },
  };
}

test("slash command schema keeps aliases, limits, and safe config filters", () => {
  const [command] = buildCommandData(makeConfig());
  assert.equal(command.name, "lookup");

  const subcommands = new Map(command.options.map((option) => [option.name, option]));
  assert.ok(subcommands.has("language"));
  assert.ok(subcommands.has("lang"));
  assert.ok(subcommands.has("command"));
  assert.ok(subcommands.has("cmd"));
  assert.ok(subcommands.has("permission"));
  assert.ok(subcommands.has("perm"));
  assert.ok(subcommands.has("health"));
  assert.ok(subcommands.has("alerts-test"));
  assert.ok(subcommands.has("files"));
  assert.ok(subcommands.has("categories"));

  const configOptions = new Map(subcommands.get("config").options.map((option) => [option.name, option]));
  assert.ok(configOptions.has("file"));
  assert.equal(configOptions.get("limit").max_value, 15);

  const materialOptions = new Map(subcommands.get("material").options.map((option) => [option.name, option]));
  assert.equal(materialOptions.get("limit").max_value, 25);

  const debugContexts = subcommands.get("debug").options.find((option) => option.name === "context").choices;
  assert.deepEqual(
    debugContexts.map((choice) => choice.value),
    ["auto", "cmi", "jobs"],
  );

  const reloadOptions = new Map(subcommands.get("reload").options.map((option) => [option.name, option]));
  assert.deepEqual(
    reloadOptions.get("plugin").choices.map((choice) => choice.value),
    ["current", "cmi", "jobs"],
  );
  assert.deepEqual(
    reloadOptions.get("profile").choices.map((choice) => choice.value),
    ["material"],
  );
  assert.deepEqual(
    subcommands.get("files").options[0].choices.map((choice) => choice.value),
    ["material"],
  );
});

test("indexed-file browsing allows only cached plugin-relative non-sensitive paths", () => {
  const allowedRoots = ["CMIPlugin", "CMILibPlugin"];
  assert.equal(isSafeIndexedRelativePath("CMIPlugin/CMI/config.yml", allowedRoots), true);
  assert.equal(isSafeIndexedRelativePath("CMILibPlugin/data/commands.log", allowedRoots), false);
  assert.equal(isSafeIndexedRelativePath("../etc/passwd", allowedRoots), false);
  assert.equal(isSafeIndexedRelativePath("/etc/passwd", allowedRoots), false);
  assert.equal(isSafeIndexedRelativePath("CMIPlugin/private/secret.key", allowedRoots), false);
  assert.equal(isSafeIndexedRelativePath("CMIPlugin/private/token.yml", allowedRoots), false);
  assert.equal(isSafeIndexedRelativePath("CMIPlugin/secrets/config.yml", allowedRoots), false);
  assert.equal(isSafeIndexedRelativePath("OtherPlugin/config.yml", allowedRoots), false);

  const listing = listSafeIndexedFiles(
    [
      { relativePath: "CMIPlugin/CMI/config.yml" },
      { relativePath: "CMIPlugin/CMI/config.yml" },
      { relativePath: "CMIPlugin/private/credentials.json" },
      { relativePath: "../etc/passwd" },
    ],
    { allowedRoots },
  );
  assert.deepEqual(listing.files, ["CMIPlugin/CMI/config.yml"]);
  assert.equal(listing.totalFileCount, 1);
  assert.equal(listing.rejectedCount, 2);

  const filesMessage = formatIndexedFilesMessage(makePlugin(), listing, "config");
  assert.match(filesMessage, /CMIPlugin\/CMI\/config\.yml/);
  assert.doesNotMatch(filesMessage, /credentials|passwd/i);

  const categoriesMessage = formatIndexedCategoriesMessage(makePlugin(), {
    profileSummaries: [{ profileName: "config", entryCount: 12, fileCount: 2 }],
  });
  assert.match(categoriesMessage, /`config`: 12 entries in 2 files/);
});

test("reload scope defaults to all and profile-only selection uses the current context", () => {
  const config = makeConfig();

  assert.deepEqual(resolveReloadScope(config, "cmi"), {});
  assert.deepEqual(resolveReloadScope(config, "cmi", "current", ""), {
    pluginId: "cmi",
    profileName: "",
  });
  assert.deepEqual(resolveReloadScope(config, "jobs", "", "material"), {
    pluginId: "jobs",
    profileName: "material",
  });
  assert.throws(
    () => resolveReloadScope(config, "jobs", "jobs", "config"),
    /does not provide the requested profile/i,
  );
});

test("channel routing and aliases resolve independently from the interaction handler", () => {
  const config = makeConfig();
  const overrides = new Map();

  assert.equal(resolveCanonicalSubcommand("lang"), "language");
  assert.equal(resolveCanonicalSubcommand("cmd"), "command");
  assert.equal(resolveCanonicalSubcommand("perm"), "permission");
  assert.equal(resolveCanonicalSubcommand("faq"), "faq");

  assert.equal(resolveChannelContext("cmi-channel", config, overrides).pluginId, "cmi");
  assert.equal(resolveChannelContext("jobs-channel", config, overrides).pluginId, "jobs");
  assert.equal(resolveChannelContext("test-channel", config, overrides).pluginId, "cmi");

  overrides.set("test-channel", "jobs");
  const testContext = resolveChannelContext("test-channel", config, overrides);
  assert.equal(testContext.pluginId, "jobs");
  assert.equal(testContext.overridePluginId, "jobs");
  assert.equal(resolveChannelContext("other-channel", config, overrides).plugin, null);
});

test("role and command availability checks remain ID based", () => {
  const member = {
    roles: {
      cache: [{ id: "support-role", name: "renamed-role" }],
    },
  };

  assert.equal(hasRole(member, { roleIds: ["support-role"] }), true);
  assert.equal(hasRole(member, { roleIds: ["renamed-role"] }), false);
  assert.equal(getCommandAvailability(makePlugin(), "config"), "ready");
  assert.equal(getCommandAvailability(makePlugin(), "unknown"), "unsupported");
});

test("help formatting stays context aware after extraction", () => {
  const config = makeConfig();
  const context = resolveChannelContext("cmi-channel", config, new Map());
  const member = {
    roles: {
      cache: [{ id: "support-role" }],
    },
  };

  const message = formatHelpMessage(config, member, context, "lookup");
  assert.match(message, /Current context: `CMI`/);
  assert.match(message, /`\/lookup language\|lang <keyword>`/);
  assert.match(message, /`limit: 1-15`/);
  assert.match(message, /summary: true\|false.*disabled/i);
});

test("result formatting keeps internal metadata out of public headings", () => {
  const result = {
    displayPath: "data/placeholders.log",
    yamlPath: "%cmi_user_balance%",
    lineNumber: 10,
    comments: ["# Clean users balance"],
    snippet: "# Clean users balance\n%cmi_user_balance%",
    codeLanguage: "yml",
    sourceType: "log",
    related: [],
  };
  const message = formatResultsMessage("balance", [result], 1, 1, "", ["CMIPlugin/data/placeholders.log"], {
    layout: "placeholder",
    profile: {
      referenceLabel: "placeholders",
      referenceUrl: "https://www.zrips.net/cmi/placeholders/",
    },
  });

  assert.match(message, /Found \[1\] mention for \[placeholders\]/);
  assert.doesNotMatch(message, /data\/placeholders\.log/);
  assert.match(message, /```yml/);
});

test("result formatting presents commit-pinned source links without exposing raw paths", () => {
  const revision = "abcdef1234567890abcdef1234567890abcdef12";
  const sourceUrl = `https://github.com/mrfdev/CMIBot/blob/${revision}/CMIPlugin/data/commands.log#L10`;
  const message = formatResultsMessage(
    "balance",
    [
      {
        displayPath: "private-display-path",
        relativePath: "CMIPlugin/data/commands.log",
        yamlPath: "/cmi balance",
        lineNumber: 10,
        snippet: "/cmi balance",
        codeLanguage: "text",
        sourceType: "log",
        sourceUrl,
        related: [],
      },
    ],
    1,
    1,
    "",
    ["CMIPlugin/data/commands.log"],
    { layout: "command" },
  );

  assert.match(message, new RegExp(`blob/${revision}/CMIPlugin/data/commands\\.log#L10`));
  assert.match(message, /source line 10/);
  assert.doesNotMatch(message, /private-display-path/);
});

test("Discord output helpers enforce message-size boundaries", () => {
  const message = ["### First", "a".repeat(30), "### Second", "b".repeat(30)].join("\n");
  const chunks = splitDiscordMessages(message, 45);

  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.length <= 45));
  assert.equal(truncateDiscordMessage("short"), "short");
  assert.match(truncateDiscordMessage("x".repeat(2100)), /Trimmed to fit Discord message limits/);
  assert.equal(formatBytes(1024), "1.00 KB");
  assert.equal(formatDuration(90_000), "1m 30s");
});

test("the extracted search lifecycle applies context synonyms and audits a formatted result", async () => {
  const entries = extractEntriesFromText(
    ["# Enables support for DynMap web chat", "DynMapChat: false"].join("\n"),
    "CMIPlugin/CMI/Settings/Chat.yml",
  );
  const responses = [];
  const auditEvents = [];
  const searchMetrics = [];
  const plugin = makePlugin();
  plugin.profiles.config = {
    defaultResultLimit: 3,
    maxResultLimit: 15,
    entryLabel: "YAML entries",
  };
  const interaction = {
    user: { id: "support-user" },
    member: { roles: { cache: [{ id: "support-role" }] } },
    options: {
      getString(name) {
        return {
          keyword: "webmap",
          file: "",
          mode: "exact",
        }[name] ?? null;
      },
      getInteger: () => null,
      getBoolean: () => false,
    },
    async deferReply() {},
    async editReply(payload) {
      responses.push(payload);
    },
    async reply(payload) {
      responses.push(payload);
    },
  };

  await handleSearchInteraction({
    interaction,
    subcommand: "config",
    canonicalSubcommand: "config",
    context: { plugin, pluginId: "cmi" },
    config: {
      search: {
        defaultResultLimit: 3,
        maxResultLimit: 15,
        synonymsByPlugin: {
          cmi: {
            webmap: ["dynmap"],
          },
        },
      },
      security: {
        queryAllowlist: [],
        queryBlocklist: [],
        queryMinLength: 2,
        queryMaxLength: 100,
        queryDebugErrors: false,
        lookupCooldownSeconds: 0,
        summaryCooldownSeconds: 0,
      },
      discord: { aiRoleIds: ["admin-role"] },
      formatDisplayPath: (_pluginId, relativePath) => `~/plugins/${relativePath.replace(/^CMIPlugin\//, "")}`,
    },
    searchCache: {
      getEntries: () => entries,
    },
    aiEnabled: false,
    resolveAiReranker: async () => null,
    cooldowns: {
      check: () => ({ allowed: true, retryAfterSeconds: 0 }),
    },
    logEvent: async (_interaction, payload) => auditEvents.push(payload),
    logRateLimitEvent: async () => {},
    metrics: {
      recordSearch(payload) {
        searchMetrics.push(payload);
      },
    },
  });

  assert.equal(responses.length, 1);
  assert.match(responses[0].content, /Found \[1\] mention/);
  assert.match(responses[0].content, /DynMapChat: false/);
  assert.equal(auditEvents.at(-1).outcome, "success");
  assert.equal(auditEvents.at(-1).totalMentions, 1);
  assert.equal(auditEvents.at(-1).synonymApplied, true);
  assert.equal(auditEvents.at(-1).queryVariantCount, 2);
  assert.equal(searchMetrics.length, 1);
  assert.equal(searchMetrics[0].outcome, "success");
  assert.equal(searchMetrics[0].resultCount, 1);
  assert.equal("query" in searchMetrics[0], false);
});

test("an empty Discord search offers scoped suggestions without auditing their text", async () => {
  const entries = extractEntriesFromText("Teleport: true", "CMIPlugin/CMI/config.yml");
  const responses = [];
  const auditEvents = [];
  const plugin = makePlugin();
  plugin.profiles.config = {
    defaultResultLimit: 3,
    maxResultLimit: 15,
    entryLabel: "YAML entries",
  };
  const interaction = {
    user: { id: "support-user" },
    member: { roles: { cache: [{ id: "support-role" }] } },
    options: {
      getString(name) {
        return {
          keyword: "teleprot",
          file: "",
          mode: "exact",
        }[name] ?? null;
      },
      getInteger: () => null,
      getBoolean: () => false,
    },
    async deferReply() {},
    async editReply(payload) {
      responses.push(payload);
    },
    async reply(payload) {
      responses.push(payload);
    },
  };

  await handleSearchInteraction({
    interaction,
    subcommand: "config",
    canonicalSubcommand: "config",
    context: { plugin, pluginId: "cmi" },
    config: {
      search: {
        defaultResultLimit: 3,
        maxResultLimit: 15,
        synonymsByPlugin: {},
      },
      security: {
        queryAllowlist: [],
        queryBlocklist: [],
        queryMinLength: 2,
        queryMaxLength: 100,
        queryDebugErrors: false,
        lookupCooldownSeconds: 0,
        summaryCooldownSeconds: 0,
      },
      discord: { aiRoleIds: ["admin-role"] },
      formatDisplayPath: (_pluginId, relativePath) => relativePath,
    },
    searchCache: {
      getEntries: () => entries,
    },
    aiEnabled: false,
    resolveAiReranker: async () => null,
    cooldowns: {
      check: () => ({ allowed: true, retryAfterSeconds: 0 }),
    },
    logEvent: async (_interaction, payload) => auditEvents.push(payload),
    logRateLimitEvent: async () => {},
    metrics: { recordSearch() {} },
  });

  assert.equal(responses.length, 1);
  assert.match(responses[0].content, /No YAML entries matched `teleprot`/);
  assert.match(responses[0].content, /Did you mean: `Teleport`\?/);
  assert.equal(auditEvents.at(-1).outcome, "empty");
  assert.equal(auditEvents.at(-1).suggestionCount, 1);
  assert.equal("suggestions" in auditEvents.at(-1), false);
});

test("Discord search retains bounded matches behind opaque pagination controls", async () => {
  const entries = extractEntriesFromText(
    Array.from({ length: 8 }, (_, index) => `Setting${index + 1}: true`).join("\n"),
    "CMIPlugin/CMI/config.yml",
  );
  const responses = [];
  const rerankSizes = [];
  const plugin = makePlugin();
  plugin.debugRoots = ["CMIPlugin"];
  plugin.profiles.config = {
    defaultResultLimit: 2,
    maxResultLimit: 15,
    entryLabel: "YAML entries",
  };
  plugin.commandAvailability.config = "ready";
  const pagination = createResultPagination(
    { paginationMaxResults: 5, paginationTtlMs: 10_000 },
    { createSessionId: () => "searchSession01", now: () => 1_000 },
  );
  const interaction = {
    guildId: "guild-one",
    channelId: "channel-one",
    user: { id: "support-user" },
    member: { roles: { cache: [{ id: "support-role" }] } },
    options: {
      getString(name) {
        return { keyword: "setting", file: "", mode: "exact" }[name] ?? null;
      },
      getInteger: () => 2,
      getBoolean: () => false,
    },
    async deferReply() {},
    async editReply(payload) {
      responses.push(payload);
    },
  };

  await handleSearchInteraction({
    interaction,
    subcommand: "config",
    canonicalSubcommand: "config",
    context: { plugin, pluginId: "cmi" },
    config: {
      search: {
        defaultResultLimit: 2,
        maxResultLimit: 15,
        paginationMaxResults: 5,
        sourceLinksEnabled: false,
        synonymsByPlugin: {},
      },
      security: {
        queryAllowlist: [],
        queryBlocklist: [],
        queryMinLength: 2,
        queryMaxLength: 100,
        queryDebugErrors: false,
        lookupCooldownSeconds: 0,
        summaryCooldownSeconds: 0,
      },
      discord: { aiRoleIds: ["support-role"] },
      sharedDebugRoots: [],
      formatDisplayPath: (_pluginId, relativePath) => relativePath,
    },
    searchCache: {
      getEntries: () => entries,
      getGeneration: () => 9,
    },
    aiEnabled: true,
    resolveAiReranker: async () => ({
      async rerank(_keyword, matches) {
        rerankSizes.push(matches.length);
        return matches;
      },
    }),
    cooldowns: { check: () => ({ allowed: true, retryAfterSeconds: 0 }) },
    logEvent: async () => {},
    logRateLimitEvent: async () => {},
    metrics: { recordSearch() {} },
    pagination,
  });

  assert.deepEqual(rerankSizes, [5]);
  assert.equal(responses.length, 1);
  assert.match(responses[0].content, /Page 1\/3/);
  const nextCustomId = responses[0].components[0].components[2].custom_id;
  assert.match(nextCustomId, /^lookup-page:searchSession01:next$/);
  assert.doesNotMatch(nextCustomId, /setting|CMIPlugin|support-user/);

  const next = pagination.resolveButton(nextCustomId, {
    userId: "support-user",
    guildId: "guild-one",
    channelId: "channel-one",
    pluginId: "cmi",
    cacheGeneration: 9,
    hasAccess: true,
  });
  assert.equal(next.status, "ok");
  assert.match(next.payload.content, /Page 2\/3/);
});
