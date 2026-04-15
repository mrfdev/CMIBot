const UNSUPPORTED_QUERY_PATTERN = /[`@]/;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;
const BRACE_TOKEN_PATTERN = /^\{[^{}\s]+\}$/;
const PERCENT_TOKEN_PATTERN = /^%[^%\s]+%$/;
const BRACKET_TOKEN_PATTERN = /^\[[^\]\s]+\]$/;
const FILE_FILTER_PATTERN = /^[a-z0-9._/-]+$/i;

function normalizeWhitespace(value) {
  return value.replace(/\s+/g, " ").trim();
}

function isSpecialSearchToken(token) {
  return BRACE_TOKEN_PATTERN.test(token) || PERCENT_TOKEN_PATTERN.test(token) || BRACKET_TOKEN_PATTERN.test(token);
}

function isSpecialSearchQuery(query) {
  const tokens = query.split(/\s+/).filter(Boolean);
  return tokens.length > 0 && tokens.every(isSpecialSearchToken);
}

export function sanitizeForDisplay(value) {
  return value.replace(/`/g, "'").replace(/@/g, "@\u200b");
}

export function normalizeQuery(rawQuery) {
  return normalizeWhitespace(rawQuery);
}

export function validateQuery(rawQuery, securityConfig) {
  const query = normalizeQuery(rawQuery);
  const lowered = query.toLowerCase();
  const compactAlphanumeric = lowered.replace(/[^a-z0-9]+/g, "");
  const specialSearchQuery = isSpecialSearchQuery(query);

  if (!query) {
    return {
      ok: false,
      reason: "Please provide a search keyword.",
      normalizedQuery: "",
    };
  }

  if (CONTROL_CHARACTER_PATTERN.test(query)) {
    return {
      ok: false,
      reason: "That search contains unsupported control characters.",
      normalizedQuery: query,
    };
  }

  if (UNSUPPORTED_QUERY_PATTERN.test(query)) {
    return {
      ok: false,
      reason: "That search contains unsupported characters like `@` or backticks.",
      normalizedQuery: query,
    };
  }

  if (!compactAlphanumeric) {
    return {
      ok: false,
      reason: "Please use at least one letter or number in the search.",
      normalizedQuery: query,
    };
  }

  const allowlisted = securityConfig.queryAllowlist.includes(lowered);
  if (!allowlisted && !specialSearchQuery && compactAlphanumeric.length < securityConfig.queryMinLength) {
    return {
      ok: false,
      reason: `Please use a more specific search term with at least ${securityConfig.queryMinLength} letters or numbers.`,
      normalizedQuery: query,
    };
  }

  if (query.length > securityConfig.queryMaxLength) {
    return {
      ok: false,
      reason: `Please keep searches under ${securityConfig.queryMaxLength} characters.`,
      normalizedQuery: query,
    };
  }

  if (!allowlisted && !specialSearchQuery && securityConfig.queryBlocklist.includes(lowered)) {
    return {
      ok: false,
      reason: "That search is too broad to be useful. Please use a more specific term.",
      normalizedQuery: query,
    };
  }

  return {
    ok: true,
    reason: "",
    normalizedQuery: query,
  };
}

function normalizeFileFilter(rawFileFilter) {
  return normalizeWhitespace(rawFileFilter).replace(/\\/g, "/").replace(/^\.\/+/, "");
}

export function resolveFileFilter(rawFileFilter, entries, { profileLabel = "indexed" } = {}) {
  if (!rawFileFilter) {
    return {
      ok: true,
      reason: "",
      normalizedFilter: "",
      matchedPaths: [],
      filteredEntries: entries,
    };
  }

  const normalizedFilter = normalizeFileFilter(rawFileFilter);

  if (!normalizedFilter) {
    return {
      ok: false,
      reason: "Please provide a file name to filter by.",
      normalizedFilter,
      matchedPaths: [],
      filteredEntries: [],
    };
  }

  if (CONTROL_CHARACTER_PATTERN.test(normalizedFilter)) {
    return {
      ok: false,
      reason: "That file filter contains unsupported control characters.",
      normalizedFilter,
      matchedPaths: [],
      filteredEntries: [],
    };
  }

  const segments = normalizedFilter.split("/").filter(Boolean);
  if (
    normalizedFilter.startsWith("/") ||
    segments.some((segment) => segment === "." || segment === "..") ||
    !FILE_FILTER_PATTERN.test(normalizedFilter)
  ) {
    return {
      ok: false,
      reason: "Please use only an indexed file name like Chat.yml, config.yml, or a plugin-relative config path.",
      normalizedFilter,
      matchedPaths: [],
      filteredEntries: [],
    };
  }

  const normalizedPaths = [...new Set(entries.map((entry) => entry.relativePath.replace(/\\/g, "/")))];
  const loweredFilter = normalizedFilter.toLowerCase();
  const matchedPaths = normalizedPaths.filter((relativePath) => {
    const loweredPath = relativePath.toLowerCase();
    const baseName = loweredPath.slice(loweredPath.lastIndexOf("/") + 1);
    return loweredPath === loweredFilter || baseName === loweredFilter || loweredPath.endsWith(`/${loweredFilter}`);
  });

  if (!matchedPaths.length) {
    return {
      ok: false,
      reason: `That file filter does not match an indexed ${profileLabel} file. Try Chat.yml, config.yml, or a plugin-relative config path.`,
      normalizedFilter,
      matchedPaths: [],
      filteredEntries: [],
    };
  }

  const matchedPathSet = new Set(matchedPaths);
  return {
    ok: true,
    reason: "",
    normalizedFilter,
    matchedPaths,
    filteredEntries: entries.filter((entry) => matchedPathSet.has(entry.relativePath.replace(/\\/g, "/"))),
  };
}

export function createCooldownManager() {
  const state = new Map();

  function getKey(userId, bucket) {
    return `${userId}:${bucket}`;
  }

  return {
    check(userId, bucket, cooldownSeconds) {
      if (!cooldownSeconds) {
        return { allowed: true, retryAfterSeconds: 0 };
      }

      const now = Date.now();
      const key = getKey(userId, bucket);
      const expiresAt = state.get(key) ?? 0;
      if (expiresAt > now) {
        return {
          allowed: false,
          retryAfterSeconds: Math.ceil((expiresAt - now) / 1000),
        };
      }

      state.set(key, now + cooldownSeconds * 1000);
      return {
        allowed: true,
        retryAfterSeconds: 0,
      };
    },
  };
}
