import assert from "node:assert/strict";
import test from "node:test";
import { createResultPagination } from "../src/discord/pagination.js";

function makeResults(count) {
  return Array.from({ length: count }, (_, index) => {
    const result = {
      displayPath: "CMIPlugin/CMI/config.yml",
      relativePath: "CMIPlugin/CMI/config.yml",
      yamlPath: `Setting.${index + 1}`,
      lineNumber: index + 1,
      snippet: `Setting.${index + 1}: true`,
      codeLanguage: "yml",
      sourceType: "yaml",
      related: [],
    };
    Object.defineProperty(result, "indexedYamlContext", {
      value: {
        document: { lines: [`Setting.${index + 1}: true`] },
        blockStartLine: 1,
        blockEndLine: 1,
      },
      enumerable: false,
    });
    return result;
  });
}

function makeSession(pagination, overrides = {}) {
  return pagination.createSession({
    ownerId: "owner-user",
    guildId: "guild-one",
    channelId: "channel-one",
    pluginId: "cmi",
    cacheGeneration: 7,
    keyword: "private query",
    results: makeResults(5),
    totalMentions: 8,
    fileCount: 1,
    allMatchedFiles: ["CMIPlugin/CMI/config.yml"],
    options: { layout: "default", showFileHints: false },
    pageSize: 2,
    ...overrides,
  });
}

function validContext(overrides = {}) {
  return {
    userId: "owner-user",
    guildId: "guild-one",
    channelId: "channel-one",
    pluginId: "cmi",
    cacheGeneration: 7,
    hasAccess: true,
    ...overrides,
  };
}

test("pagination uses opaque controls and owner-bound pages", () => {
  const pagination = createResultPagination(
    { paginationTtlMs: 10_000, paginationMaxResults: 100 },
    { createSessionId: () => "opaqueSession01", now: () => 1_000 },
  );
  const session = makeSession(pagination);
  const controls = session.payload.components[0].components;
  const contextMenu = session.payload.components[1].components[0];
  const nextCustomId = controls[2].custom_id;

  assert.match(nextCustomId, /^lookup-page:opaqueSession01:next$/);
  assert.doesNotMatch(nextCustomId, /private|query|CMIPlugin|owner-user|guild-one|channel-one/);
  assert.match(contextMenu.custom_id, /^lookup-context:opaqueSession01$/);
  assert.doesNotMatch(
    contextMenu.custom_id,
    /private|query|CMIPlugin|owner-user|guild-one|channel-one/,
  );
  assert.deepEqual(contextMenu.options.map((option) => option.value), ["0", "1"]);
  assert.equal(controls[0].disabled, true);
  assert.equal(controls[2].disabled, false);
  assert.match(session.payload.content, /Page 1\/3, showing results 1-2 of 5; top 5 of 8 matches retained/);

  assert.equal(
    pagination.resolveButton(nextCustomId, validContext({ userId: "different-user" })).status,
    "unauthorized",
  );
  const next = pagination.resolveButton(nextCustomId, validContext());
  assert.equal(next.status, "ok");
  assert.equal(next.pageNumber, 2);
  assert.match(next.payload.content, /Setting\.3/);
  assert.match(next.payload.content, /Page 2\/3, showing results 3-4 of 5/);
  assert.equal(next.payload.components[0].components[0].disabled, false);
  assert.deepEqual(
    next.payload.components[1].components[0].options.map((option) => option.value),
    ["2", "3"],
  );
});

test("expanded-context selections are owner-bound and limited to the visible page", () => {
  const pagination = createResultPagination(
    { paginationTtlMs: 10_000 },
    { createSessionId: () => "contextSession01", now: () => 1_000 },
  );
  const session = makeSession(pagination);
  const customId = session.payload.components[1].components[0].custom_id;

  assert.equal(
    pagination.resolveContextSelection(customId, "0", validContext({ userId: "other" })).status,
    "unauthorized",
  );
  assert.equal(
    pagination.resolveContextSelection(customId, "2", validContext()).status,
    "invalid-selection",
  );
  assert.equal(
    pagination.resolveContextSelection(customId, "../../etc/passwd", validContext()).status,
    "invalid-selection",
  );

  const selected = pagination.resolveContextSelection(customId, "1", validContext());
  assert.equal(selected.status, "ok");
  assert.equal(selected.resultNumber, 2);
  assert.equal(selected.result.yamlPath, "Setting.2");

  const nextCustomId = session.payload.components[0].components[2].custom_id;
  pagination.resolveButton(nextCustomId, validContext());
  assert.equal(
    pagination.resolveContextSelection(customId, "0", validContext()).status,
    "invalid-selection",
  );
  assert.equal(
    pagination.resolveContextSelection(customId, "2", validContext()).status,
    "ok",
  );
});

test("a single result can expose context without adding pagination buttons", () => {
  const pagination = createResultPagination(
    { paginationTtlMs: 10_000 },
    { createSessionId: () => "singleContext01", now: () => 1_000 },
  );
  const session = makeSession(pagination, {
    results: makeResults(1),
    totalMentions: 1,
    pageSize: 3,
  });

  assert.equal(session.payload.components.length, 1);
  assert.equal(session.payload.components[0].components[0].type, 3);
  assert.equal(session.payload.components[0].components[0].options.length, 1);
  assert.doesNotMatch(session.payload.content, /Page 1\/1/);
});

test("pagination invalidates changed contexts, cache generations, and expired sessions", () => {
  let now = 1_000;
  let sequence = 0;
  const pagination = createResultPagination(
    { paginationTtlMs: 1_000, paginationMaxSessions: 2 },
    {
      now: () => now,
      createSessionId: () => `sessionKey${++sequence}`,
    },
  );

  const first = makeSession(pagination);
  const firstNext = first.payload.components[0].components[2].custom_id;
  assert.equal(
    pagination.resolveButton(firstNext, validContext({ channelId: "another-channel" })).status,
    "invalid-context",
  );
  assert.equal(
    pagination.resolveButton(firstNext, validContext({ cacheGeneration: 8 })).status,
    "stale",
  );
  assert.equal(pagination.resolveButton(firstNext, validContext()).status, "expired");

  const second = makeSession(pagination);
  const secondNext = second.payload.components[0].components[2].custom_id;
  now = 2_000;
  assert.equal(pagination.resolveButton(secondNext, validContext()).status, "expired");
  assert.equal(pagination.getSessionCount(), 0);
});

test("pagination bounds retained results and in-memory session count", () => {
  let sequence = 0;
  const pagination = createResultPagination(
    { paginationMaxResults: 3, paginationMaxSessions: 2 },
    { createSessionId: () => `boundedKey${++sequence}`, now: () => 1_000 },
  );

  const first = makeSession(pagination);
  makeSession(pagination);
  makeSession(pagination);

  assert.equal(pagination.getSessionCount(), 2);
  const firstNext = first.payload.components[0].components[2].custom_id;
  assert.equal(pagination.resolveButton(firstNext, validContext()).status, "expired");
});
