import assert from "node:assert/strict";
import test from "node:test";
import { ApplicationCommandOptionType } from "discord.js";
import { buildCommandData } from "../src/discord/commands.js";
import {
  AUTOCOMPLETE_CHOICE_LIMIT,
  buildAutocompleteIndex,
  selectAutocompleteChoices,
} from "../src/discord/autocomplete.js";
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
    ai: {
      enabled: false,
      maxQuestionLength: 320,
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
  assert.ok(subcommands.has("ask"));
  assert.ok(subcommands.has("ai-status"));
  assert.ok(subcommands.has("alerts-test"));
  assert.ok(subcommands.has("files"));
  assert.ok(subcommands.has("categories"));

  const configOptions = new Map(subcommands.get("config").options.map((option) => [option.name, option]));
  assert.ok(configOptions.has("file"));
  for (const searchSubcommand of [
    "config",
    "language",
    "lang",
    "placeholder",
    "material",
    "command",
    "cmd",
    "permission",
    "perm",
    "faq",
    "tabcomplete",
  ]) {
    const keyword = subcommands
      .get(searchSubcommand)
      .options.find((option) => option.name === "keyword");
    const related = subcommands
      .get(searchSubcommand)
      .options.find((option) => option.name === "related");
    assert.equal(keyword.autocomplete, true);
    assert.equal(related.type, ApplicationCommandOptionType.Boolean);
    assert.equal(related.required, false);
  }
  assert.equal(configOptions.get("file").autocomplete, true);
  assert.equal(configOptions.get("limit").max_value, 15);

  const materialOptions = new Map(subcommands.get("material").options.map((option) => [option.name, option]));
  assert.equal(materialOptions.get("limit").max_value, 25);

  const latestOptions = new Map(subcommands.get("latest").options.map((option) => [option.name, option]));
  assert.equal(latestOptions.get("changes").type, ApplicationCommandOptionType.Boolean);
  assert.equal(latestOptions.get("changes").required, false);

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

test("autocomplete offers bounded safe index metadata without inspecting entry values", () => {
  const entries = [
    {
      relativePath: "CMIPlugin/CMI/config.yml",
      key: "TeleportEnabled",
      yamlPath: "Commands.Teleport.Enabled",
      value: "private-value-must-not-appear",
      searchText: "private-value-must-not-appear",
    },
    {
      relativePath: "CMIPlugin/CMI/Settings/Chat.yml",
      key: "ChatFormat",
      yamlPath: "Chat.GeneralFormat",
      value: "another-private-value",
      searchText: "another-private-value",
    },
    {
      relativePath: "CMIPlugin/private/secret.key",
      key: "@everyone",
      yamlPath: "Unsafe.Secret",
      value: "never-show-this",
      searchText: "never-show-this",
    },
    ...Array.from({ length: 40 }, (_, index) => ({
      relativePath: "CMIPlugin/CMI/config.yml",
      key: `TeleportOption${index}`,
      yamlPath: `Commands.Teleport.Option${index}`,
      value: "ignored",
      searchText: "ignored",
    })),
  ];
  const index = buildAutocompleteIndex(entries, {
    allowedRoots: ["CMIPlugin"],
    maximumKeywordLength: 80,
  });
  const keywordChoices = selectAutocompleteChoices(index, "keyword", "teleport");
  const fileChoices = selectAutocompleteChoices(index, "file", "chat");
  const serialized = JSON.stringify({ keywordChoices, fileChoices });

  assert.equal(keywordChoices.length, AUTOCOMPLETE_CHOICE_LIMIT);
  assert.match(keywordChoices[0].value, /teleport/i);
  assert.deepEqual(fileChoices, [{
    name: "CMIPlugin/CMI/Settings/Chat.yml",
    value: "CMIPlugin/CMI/Settings/Chat.yml",
  }]);
  assert.doesNotMatch(serialized, /private-value|another-private-value|never-show|secret\.key|@everyone/i);
  assert.ok(keywordChoices.every((choice) => choice.name.length <= 100 && choice.value.length <= 100));
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
  assert.match(message, /latest changes:true/);
  assert.match(message, /related: true\|false.*matching references across supported profiles/i);
  assert.match(message, /cmd balance related:true/);
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

test("result formatting labels safe cross-profile references compactly", () => {
  const message = formatResultsMessage(
    "balance",
    [
      {
        displayPath: "private-command-index.log",
        yamlPath: "/cmi balance (playerName)",
        lineNumber: 10,
        snippet: "/cmi balance (playerName)",
        codeLanguage: "text",
        sourceType: "log",
        related: [
          {
            profileName: "permission",
            yamlPath: "cmi.command.balance",
            lineNumber: 20,
          },
          {
            profileName: "faq",
            yamlPath: "CMI Economy Manager",
            lineNumber: 30,
            comments: ["# URL: https://example.com/economy"],
          },
        ],
      },
    ],
    1,
    1,
    "",
    ["CMIPlugin/data/commands.log"],
    { layout: "command" },
  );

  assert.match(message, /Related:\n- \*\*permission:\*\* `cmi\.command\.balance` \(line 20\)/);
  assert.match(message, /\n- \*\*FAQ:\*\* `CMI Economy Manager` \(\[open\]/);
  assert.doesNotMatch(message, /Related:.* · /);
  assert.doesNotMatch(message, /private-command-index/);
});

test("long related command output retains only complete source links when trimmed", () => {
  const revision = "abcdef1234567890abcdef1234567890abcdef12";
  const makeSourceUrl = (file, line) =>
    `https://github.com/mrfdev/CMIBot/blob/${revision}/CMIPlugin/data/${file}#L${line}`;
  const results = Array.from({ length: 3 }, (_, resultIndex) => ({
    displayPath: "private-command-index.log",
    yamlPath: `/cmi balance example ${resultIndex + 1}`,
    lineNumber: 100 + resultIndex,
    snippet: `/cmi balance example ${resultIndex + 1}\n${"description ".repeat(18)}`,
    codeLanguage: "text",
    sourceType: "log",
    sourceUrl: makeSourceUrl("commands.log", 100 + resultIndex),
    related: Array.from({ length: 4 }, (_, referenceIndex) => ({
      profileName: referenceIndex % 2 === 0 ? "permission" : "config",
      yamlPath: `cmi.command.balance.example.${resultIndex + 1}.${referenceIndex + 1}`,
      lineNumber: 200 + referenceIndex,
      sourceUrl: makeSourceUrl(
        referenceIndex % 2 === 0 ? "permissions.log" : "config.yml",
        200 + referenceIndex,
      ),
    })),
  }));
  const formatted = formatResultsMessage(
    "balance",
    results,
    results.length,
    1,
    "",
    ["CMIPlugin/data/commands.log"],
    { layout: "command" },
  );
  const truncated = truncateDiscordMessage(formatted);

  assert.ok(formatted.length > 2000);
  assert.ok(truncated.length <= 2000);
  assert.match(truncated, /Related:\n- \*\*permission:/);
  assert.doesNotMatch(truncated, /<https?:\/\/[^\s>]*(?:\s|$)/);
  assert.equal(
    (truncated.match(/\]\(<https?:\/\//g) ?? []).length,
    (truncated.match(/>\)/g) ?? []).length,
  );
});

test("material result formatting includes opt-in related references", () => {
  const message = formatResultsMessage(
    "stone",
    [
      {
        yamlPath: "STONE",
        related: [
          {
            profileName: "language",
            yamlPath: "STONE",
            lineNumber: 42,
          },
        ],
      },
    ],
    1,
    1,
    "",
    [],
    { layout: "materialList" },
  );

  assert.match(message, /- `STONE`/);
  assert.match(message, /Related:\n    - \*\*language:\*\* `STONE` \(line 42\)/);
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

test("Discord truncation never leaves a partial hidden link that can create an embed", () => {
  const sourceUrl =
    "https://github.com/mrfdev/CMIBot/blob/abcdef1234567890abcdef1234567890abcdef12/CMIPlugin/data/commands.log#L154";
  const message = `source line 154\n${"x".repeat(1859)}[source](<${sourceUrl}>)\n${"y".repeat(300)}`;
  const truncated = truncateDiscordMessage(message);

  assert.ok(truncated.length <= 2000);
  assert.match(truncated, /Trimmed to fit Discord message limits/);
  assert.match(truncated, /^source line 154/);
  assert.doesNotMatch(truncated, /<https?:\/\/[^\s>]*(?:\s|$)/);
});

test("Discord truncation closes an open code fence before the trim notice", () => {
  const message = `### Result\n\`\`\`text\n${"x".repeat(2100)}\n\`\`\``;
  const truncated = truncateDiscordMessage(message);

  assert.equal((truncated.match(/```/g) ?? []).length, 2);
  assert.match(truncated, /```\n\n_\(Trimmed to fit Discord message limits\.\)_$/);
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
    resolveAiService: async () => null,
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
    resolveRelatedReferences() {
      assert.fail("default searches must not resolve cross-profile references");
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

test("Discord related searches resolve safe cross-profile references only", async () => {
  const commandEntries = extractEntriesFromText(
    "/cmi balance: Check a player's balance",
    "CMIPlugin/data/commands.yml",
  );
  const responses = [];
  const auditEvents = [];
  const plugin = makePlugin();
  plugin.debugRoots = ["CMIPlugin"];
  plugin.profiles.command = {
    defaultResultLimit: 3,
    maxResultLimit: 15,
    entryLabel: "command entries",
  };
  const interaction = {
    user: { id: "support-user" },
    member: { roles: { cache: [{ id: "support-role" }] } },
    options: {
      getString(name) {
        return { keyword: "balance", mode: "exact" }[name] ?? null;
      },
      getInteger: () => null,
      getBoolean(name) {
        return name === "related";
      },
    },
    async deferReply() {},
    async editReply(payload) {
      responses.push(payload);
    },
  };

  await handleSearchInteraction({
    interaction,
    subcommand: "command",
    canonicalSubcommand: "command",
    context: { plugin, pluginId: "cmi" },
    config: {
      search: {
        defaultResultLimit: 3,
        maxResultLimit: 15,
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
      discord: { aiRoleIds: ["admin-role"] },
      sharedDebugRoots: [],
      formatDisplayPath: (_pluginId, relativePath) => relativePath,
    },
    searchCache: { getEntries: () => commandEntries },
    aiEnabled: false,
    resolveAiService: async () => null,
    cooldowns: { check: () => ({ allowed: true, retryAfterSeconds: 0 }) },
    logEvent: async (_interaction, payload) => auditEvents.push(payload),
    logRateLimitEvent: async () => {},
    metrics: { recordSearch() {} },
    resolveRelatedReferences(options) {
      assert.equal(options.sourceProfileName, "command");
      assert.equal(options.query, "balance");
      assert.equal(options.maxReferences, 6);
      return [
        {
          profileName: "permission",
          entry: {
            relativePath: "CMIPlugin/data/permissions.log",
            yamlPath: "cmi.command.balance",
            lineNumber: 20,
          },
        },
        {
          profileName: "faq",
          entry: {
            relativePath: "CMIPlugin/data/faq.log",
            yamlPath: "CMI Economy Manager",
            lineNumber: 30,
          },
        },
        {
          profileName: "permission",
          entry: {
            relativePath: "CMIPlugin/private/secret.key",
            yamlPath: "must-not-appear",
            lineNumber: 1,
          },
        },
      ];
    },
  });

  assert.equal(responses.length, 1);
  assert.match(responses[0].content, /\*\*permission:\*\* `cmi\.command\.balance`/);
  assert.match(responses[0].content, /\*\*FAQ:\*\* `CMI Economy Manager`/);
  assert.doesNotMatch(responses[0].content, /must-not-appear|secret\.key/);
  assert.equal(auditEvents.at(-1).relatedReferenceCount, 2);
});

test("Discord search offers YAML expansion only for safe indexed paths", async () => {
  async function runSearch(relativePath, sessionId) {
    const entries = extractEntriesFromText("Root:\n  Setting: needle", relativePath);
    const responses = [];
    const plugin = makePlugin();
    plugin.debugRoots = ["CMIPlugin"];
    plugin.profiles.config = {
      defaultResultLimit: 3,
      maxResultLimit: 15,
      entryLabel: "YAML entries",
    };
    const pagination = createResultPagination(
      { paginationMaxResults: 5, paginationTtlMs: 10_000 },
      { createSessionId: () => sessionId, now: () => 1_000 },
    );
    const interaction = {
      guildId: "guild-one",
      channelId: "channel-one",
      user: { id: "support-user" },
      member: { roles: { cache: [{ id: "support-role" }] } },
      options: {
        getString(name) {
          return { keyword: "needle", file: "", mode: "exact" }[name] ?? null;
        },
        getInteger: () => null,
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
          defaultResultLimit: 3,
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
        discord: { aiRoleIds: ["admin-role"] },
        sharedDebugRoots: [],
        formatDisplayPath: (_pluginId, pathValue) => pathValue,
      },
      searchCache: {
        getEntries: () => entries,
        getGeneration: () => 3,
      },
      aiEnabled: false,
      resolveAiService: async () => null,
      cooldowns: { check: () => ({ allowed: true, retryAfterSeconds: 0 }) },
      logEvent: async () => {},
      logRateLimitEvent: async () => {},
      metrics: { recordSearch() {} },
      pagination,
    });

    return { response: responses[0], pagination };
  }

  const safe = await runSearch("CMIPlugin/CMI/config.yml", "safeContext01");
  assert.equal(safe.response.components.length, 1);
  assert.equal(safe.response.components[0].components[0].type, 3);
  assert.match(safe.response.components[0].components[0].custom_id, /^lookup-context:/);

  const selected = safe.pagination.resolveContextSelection(
    safe.response.components[0].components[0].custom_id,
    safe.response.components[0].components[0].options[0].value,
    {
      userId: "support-user",
      guildId: "guild-one",
      channelId: "channel-one",
      pluginId: "cmi",
      cacheGeneration: 3,
      hasAccess: true,
    },
  );
  assert.equal(selected.status, "ok");
  assert.ok(selected.result.indexedYamlContext);

  const sensitive = await runSearch("CMIPlugin/private/token.yml", "unsafeContext01");
  assert.equal(sensitive.response.components, undefined);
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
    resolveAiService: async () => null,
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
    resolveAiService: async () => {
      assert.fail("ordinary searches must not load or call local AI");
    },
    cooldowns: { check: () => ({ allowed: true, retryAfterSeconds: 0 }) },
    logEvent: async () => {},
    logRateLimitEvent: async () => {},
    metrics: { recordSearch() {} },
    pagination,
  });

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
