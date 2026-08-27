import { randomBytes } from "node:crypto";
import { NO_MENTIONS } from "./constants.js";
import { formatResultsMessage, truncateDiscordMessage } from "./results.js";

const CUSTOM_ID_PREFIX = "lookup-page:";
const CONTEXT_CUSTOM_ID_PREFIX = "lookup-context:";
const SESSION_ID_PATTERN = /^[a-z0-9_-]{8,32}$/i;
const CUSTOM_ID_PATTERN = /^lookup-page:([a-z0-9_-]{8,32}):(prev|next)$/i;
const CONTEXT_CUSTOM_ID_PATTERN = /^lookup-context:([a-z0-9_-]{8,32})$/i;
const CONTEXT_SELECTION_PATTERN = /^(?:0|[1-9]\d{0,2})$/;

function clampInteger(value, minimum, maximum, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed)
    ? Math.max(minimum, Math.min(maximum, parsed))
    : fallback;
}

function createDefaultSessionId() {
  return randomBytes(12).toString("base64url");
}

function makeCustomId(sessionId, action) {
  return `${CUSTOM_ID_PREFIX}${sessionId}:${action}`;
}

function parseCustomId(customId) {
  const match = typeof customId === "string" ? customId.match(CUSTOM_ID_PATTERN) : null;
  return match ? { sessionId: match[1], action: match[2].toLowerCase() } : null;
}

function parseContextCustomId(customId) {
  const match = typeof customId === "string" ? customId.match(CONTEXT_CUSTOM_ID_PATTERN) : null;
  return match ? { sessionId: match[1] } : null;
}

function sanitizeSelectText(value, fallback, maximumLength = 100) {
  const sanitized = String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replaceAll("`", "'")
    .replaceAll("@", "@\u200b")
    .replace(/\s+/g, " ")
    .trim();
  return (sanitized || fallback).slice(0, maximumLength);
}

function hasIndexedYamlContext(result) {
  return Boolean(result?.indexedYamlContext);
}

function buildPaginationRow(session) {
  return session.totalPages > 1
    ? {
      type: 1,
      components: [
        {
          type: 2,
          style: 2,
          custom_id: makeCustomId(session.id, "prev"),
          label: "Previous",
          disabled: session.pageIndex === 0,
        },
        {
          type: 2,
          style: 2,
          custom_id: `${CUSTOM_ID_PREFIX}${session.id}:status`,
          label: `${session.pageIndex + 1} / ${session.totalPages}`,
          disabled: true,
        },
        {
          type: 2,
          style: 1,
          custom_id: makeCustomId(session.id, "next"),
          label: "Next",
          disabled: session.pageIndex >= session.totalPages - 1,
        },
      ],
    }
    : null;
}

function buildContextRow(session, pageResults, startIndex) {
  const options = pageResults.flatMap((result, pageIndex) => {
    if (!hasIndexedYamlContext(result)) {
      return [];
    }

    const resultIndex = startIndex + pageIndex;
    return [{
      label: sanitizeSelectText(result.yamlPath, `Result ${resultIndex + 1}`),
      value: String(resultIndex),
      description: sanitizeSelectText(
        `Result ${resultIndex + 1}, matched at line ${result.lineNumber}`,
        `Result ${resultIndex + 1}`,
      ),
    }];
  }).slice(0, 25);

  if (!options.length) {
    return null;
  }

  return {
    type: 1,
    components: [{
      type: 3,
      custom_id: `${CONTEXT_CUSTOM_ID_PREFIX}${session.id}`,
      placeholder: "Show full YAML block and surrounding context",
      min_values: 1,
      max_values: 1,
      options,
    }],
  };
}

function buildComponents(session, pageResults, startIndex) {
  return [
    buildPaginationRow(session),
    buildContextRow(session, pageResults, startIndex),
  ].filter(Boolean);
}

function renderSession(session) {
  const startIndex = session.pageIndex * session.pageSize;
  const endIndex = Math.min(session.results.length, startIndex + session.pageSize);
  const pageResults = session.results.slice(startIndex, endIndex);
  const formatOptions = { ...session.options };
  if (session.totalPages > 1) {
    formatOptions.pagination = {
      pageNumber: session.pageIndex + 1,
      totalPages: session.totalPages,
      startResult: startIndex + 1,
      endResult: endIndex,
      availableResultCount: session.results.length,
    };
  }
  const content = formatResultsMessage(
    session.keyword,
    pageResults,
    session.totalMentions,
    session.fileCount,
    session.pageIndex === 0 ? session.aiSummary : "",
    session.allMatchedFiles,
    formatOptions,
  );

  return {
    content: truncateDiscordMessage(content),
    components: buildComponents(session, pageResults, startIndex),
    allowedMentions: NO_MENTIONS,
  };
}

export function createResultPagination(settings = {}, dependencies = {}) {
  const now = dependencies.now ?? (() => Date.now());
  const createSessionId = dependencies.createSessionId ?? createDefaultSessionId;
  const ttlMs = clampInteger(settings.paginationTtlMs, 1_000, 60 * 60 * 1000, 10 * 60 * 1000);
  const maxSessions = clampInteger(settings.paginationMaxSessions, 1, 1_000, 200);
  const maxResults = clampInteger(settings.paginationMaxResults, 2, 250, 100);
  const sessions = new Map();

  function pruneExpired(timestamp = Number(now())) {
    for (const [sessionId, session] of sessions) {
      if (timestamp >= session.expiresAt) {
        sessions.delete(sessionId);
      }
    }
  }

  function allocateSessionId() {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const candidate = String(createSessionId());
      if (SESSION_ID_PATTERN.test(candidate) && !sessions.has(candidate)) {
        return candidate;
      }
    }
    throw new Error("Could not allocate a pagination session.");
  }

  function createSession(input) {
    const timestamp = Number(now());
    pruneExpired(timestamp);
    while (sessions.size >= maxSessions) {
      sessions.delete(sessions.keys().next().value);
    }

    const results = [...(input.results ?? [])].slice(0, maxResults);
    const pageSize = clampInteger(input.pageSize, 1, 25, 3);
    const id = allocateSessionId();
    const session = {
      id,
      ownerId: String(input.ownerId),
      guildId: String(input.guildId),
      channelId: String(input.channelId),
      pluginId: String(input.pluginId),
      cacheGeneration: Number(input.cacheGeneration) || 0,
      keyword: String(input.keyword),
      results,
      totalMentions: Number(input.totalMentions) || results.length,
      fileCount: Number(input.fileCount) || 0,
      aiSummary: String(input.aiSummary || ""),
      allMatchedFiles: [...(input.allMatchedFiles ?? [])],
      options: { ...(input.options ?? {}) },
      pageSize,
      pageIndex: 0,
      totalPages: Math.max(1, Math.ceil(results.length / pageSize)),
      expiresAt: timestamp + ttlMs,
    };
    sessions.set(id, session);
    return {
      sessionId: id,
      payload: renderSession(session),
    };
  }

  function resolveSession(sessionId, context) {
    const timestamp = Number(now());
    pruneExpired(timestamp);
    const session = sessions.get(sessionId);
    if (!session) {
      return { status: "expired" };
    }
    if (String(context.userId) !== session.ownerId || !context.hasAccess) {
      return { status: "unauthorized" };
    }
    if (
      String(context.guildId) !== session.guildId ||
      String(context.channelId) !== session.channelId ||
      String(context.pluginId) !== session.pluginId
    ) {
      return { status: "invalid-context" };
    }
    if ((Number(context.cacheGeneration) || 0) !== session.cacheGeneration) {
      sessions.delete(session.id);
      return { status: "stale" };
    }

    return { status: "ok", session };
  }

  function resolveButton(customId, context) {
    const parsed = parseCustomId(customId);
    if (!parsed) {
      return { status: "ignored" };
    }

    const resolved = resolveSession(parsed.sessionId, context);
    if (resolved.status !== "ok") {
      return resolved;
    }
    const { session } = resolved;

    session.pageIndex = Math.max(
      0,
      Math.min(
        session.totalPages - 1,
        session.pageIndex + (parsed.action === "next" ? 1 : -1),
      ),
    );
    return {
      status: "ok",
      action: parsed.action,
      pageNumber: session.pageIndex + 1,
      payload: renderSession(session),
    };
  }

  function resolveContextSelection(customId, selectedValue, context) {
    const parsed = parseContextCustomId(customId);
    if (!parsed) {
      return { status: "ignored" };
    }
    const resolved = resolveSession(parsed.sessionId, context);
    if (resolved.status !== "ok") {
      return resolved;
    }
    if (!CONTEXT_SELECTION_PATTERN.test(String(selectedValue ?? ""))) {
      return { status: "invalid-selection" };
    }

    const { session } = resolved;
    const resultIndex = Number(selectedValue);
    const startIndex = session.pageIndex * session.pageSize;
    const endIndex = Math.min(session.results.length, startIndex + session.pageSize);
    const result = session.results[resultIndex];
    if (
      resultIndex < startIndex ||
      resultIndex >= endIndex ||
      !hasIndexedYamlContext(result)
    ) {
      return { status: "invalid-selection" };
    }

    return {
      status: "ok",
      result,
      resultNumber: resultIndex + 1,
    };
  }

  return {
    createSession,
    resolveButton,
    resolveContextSelection,
    isPaginationButton(interaction) {
      return Boolean(interaction?.isButton?.() && parseCustomId(interaction.customId));
    },
    isContextSelect(interaction) {
      return Boolean(
        interaction?.isStringSelectMenu?.() && parseContextCustomId(interaction.customId),
      );
    },
    hasExpandableResults(results) {
      return (results ?? []).some(hasIndexedYamlContext);
    },
    getMaxResults() {
      return maxResults;
    },
    getSessionCount() {
      pruneExpired();
      return sessions.size;
    },
  };
}
