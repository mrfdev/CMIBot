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

function formatIndexedFileExamples(entries) {
  const preferredNames = new Map([
    ["config.yml", 0],
    ["generalconfig.yml", 1],
    ["titleconfig.yml", 2],
  ]);
  const fileNames = [...new Set(entries.map((entry) => entry.relativePath.replace(/\\/g, "/").split("/").at(-1)))]
    .filter(Boolean)
    .sort((left, right) => {
      const leftRank = preferredNames.get(left.toLowerCase()) ?? (left.startsWith("_") ? 100 : 10);
      const rightRank = preferredNames.get(right.toLowerCase()) ?? (right.startsWith("_") ? 100 : 10);
      return leftRank - rightRank || left.localeCompare(right, undefined, { sensitivity: "base" });
    })
    .slice(0, 3);

  return fileNames.length ? ` Try ${fileNames.map((name) => `\`${name}\``).join(", ")}.` : "";
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
      reason: "Please use only an indexed file name or plugin-relative config path.",
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
      reason: `That file filter does not match an indexed ${profileLabel} file.${formatIndexedFileExamples(entries)}`,
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

function normalizePositiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function normalizeBucketLimit(value, fallback = 10_000) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}

export function createCooldownManager({ now = () => Date.now(), maxBuckets = 10_000 } = {}) {
  const state = new Map();
  const bucketLimit = normalizeBucketLimit(maxBuckets);
  let checksSinceCleanup = 0;

  function getKey(userId, bucket) {
    return `${userId}:${bucket}`;
  }

  function pruneExpired(nowMs) {
    for (const [key, expiresAt] of state) {
      if (expiresAt <= nowMs) {
        state.delete(key);
      }
    }
  }

  function makeRoom(nowMs) {
    pruneExpired(nowMs);
    while (state.size >= bucketLimit) {
      const oldestKey = state.keys().next().value;
      if (oldestKey === undefined) {
        break;
      }
      state.delete(oldestKey);
    }
  }

  return {
    check(userId, bucket, cooldownSeconds) {
      const durationSeconds = normalizePositiveNumber(cooldownSeconds);
      if (!durationSeconds) {
        return { allowed: true, retryAfterSeconds: 0 };
      }

      const nowMs = now();
      const key = getKey(userId, bucket);
      const expiresAt = state.get(key) ?? 0;
      if (expiresAt > nowMs) {
        return {
          allowed: false,
          retryAfterSeconds: Math.ceil((expiresAt - nowMs) / 1000),
        };
      }

      checksSinceCleanup += 1;
      if (checksSinceCleanup >= 100) {
        pruneExpired(nowMs);
        checksSinceCleanup = 0;
      }
      if (!state.has(key) && state.size >= bucketLimit) {
        makeRoom(nowMs);
      }

      state.delete(key);
      state.set(key, nowMs + durationSeconds * 1000);
      return {
        allowed: true,
        retryAfterSeconds: 0,
      };
    },
  };
}

export function createSlidingWindowRateLimiter({ now = () => Date.now(), maxBuckets = 10_000 } = {}) {
  const state = new Map();
  const bucketLimit = normalizeBucketLimit(maxBuckets);
  let checksSinceCleanup = 0;

  function normalizeRule(rule) {
    const maxRequests = Math.floor(normalizePositiveNumber(rule?.maxRequests));
    const windowSeconds = normalizePositiveNumber(rule?.windowSeconds);
    if (!rule?.key || !maxRequests || !windowSeconds) {
      return null;
    }

    return {
      key: String(rule.key),
      scope: rule.scope || "rate-limit",
      maxRequests,
      windowMs: windowSeconds * 1000,
    };
  }

  function activeTimestamps(entry, nowMs, windowMs) {
    const cutoff = nowMs - windowMs;
    return entry?.timestamps.filter((timestamp) => timestamp > cutoff) ?? [];
  }

  function pruneExpired(nowMs) {
    for (const [key, entry] of state) {
      const timestamps = activeTimestamps(entry, nowMs, entry.windowMs);
      if (!timestamps.length) {
        state.delete(key);
      } else {
        entry.timestamps = timestamps;
      }
    }
  }

  function makeRoom(nowMs) {
    pruneExpired(nowMs);
    while (state.size >= bucketLimit) {
      let oldestKey;
      let oldestSeenAt = Number.POSITIVE_INFINITY;
      for (const [key, entry] of state) {
        if (entry.lastSeenAt < oldestSeenAt) {
          oldestKey = key;
          oldestSeenAt = entry.lastSeenAt;
        }
      }
      if (oldestKey === undefined) {
        break;
      }
      state.delete(oldestKey);
    }
  }

  function checkMany(rules) {
    const normalizedRules = rules.map(normalizeRule).filter(Boolean);
    if (!normalizedRules.length) {
      return { allowed: true, retryAfterSeconds: 0, scope: "" };
    }

    const nowMs = now();
    const preparedRules = normalizedRules.map((rule) => {
      const entry = state.get(rule.key);
      return {
        ...rule,
        timestamps: activeTimestamps(entry, nowMs, rule.windowMs),
      };
    });
    const deniedRule = preparedRules.find((rule) => rule.timestamps.length >= rule.maxRequests);

    if (deniedRule) {
      const retryAt = deniedRule.timestamps[0] + deniedRule.windowMs;
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((retryAt - nowMs) / 1000)),
        scope: deniedRule.scope,
      };
    }

    checksSinceCleanup += 1;
    if (checksSinceCleanup >= 100) {
      pruneExpired(nowMs);
      checksSinceCleanup = 0;
    }

    for (const rule of preparedRules) {
      if (!state.has(rule.key) && state.size >= bucketLimit) {
        makeRoom(nowMs);
      }
      state.delete(rule.key);
      state.set(rule.key, {
        timestamps: [...rule.timestamps, nowMs],
        windowMs: rule.windowMs,
        lastSeenAt: nowMs,
      });
    }

    return { allowed: true, retryAfterSeconds: 0, scope: "" };
  }

  return {
    check(key, maxRequests, windowSeconds, scope = "rate-limit") {
      return checkMany([{ key, maxRequests, windowSeconds, scope }]);
    },
    checkMany,
  };
}
