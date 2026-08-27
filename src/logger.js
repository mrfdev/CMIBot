import { AsyncLocalStorage } from "node:async_hooks";

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]+/g;
const AUTHORIZATION_TOKEN = /\b(Bot|Bearer)\s+[A-Za-z0-9._~-]+/gi;
const COMMON_API_TOKEN = /\b(?:sk-[A-Za-z0-9_-]{8,}|AIza[A-Za-z0-9_-]{12,})\b/g;
const DISCORD_TOKEN = /\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{20,}\b/g;
const ABSOLUTE_PATH = /(?:\/(?:Users|home|private|var|etc|opt|tmp)(?:\/[^\s"'`]+)+|[A-Za-z]:\\[^\s"'`]+)/g;
const DISCORD_SNOWFLAKE = /\b\d{17,20}\b/g;
const SAFE_FIELD_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const SENSITIVE_FIELD_NAME = /(?:authorization|channelid|guildid|host|hostname|password|path|secret|token|userid|usertag)/i;
const MAX_STRING_LENGTH = 1000;

function isSafeFieldName(value) {
  return SAFE_FIELD_NAME.test(value) && !SENSITIVE_FIELD_NAME.test(value);
}

export function sanitizeLogText(value) {
  return String(value)
    .replace(CONTROL_CHARACTERS, " ")
    .replace(AUTHORIZATION_TOKEN, "$1 <redacted>")
    .replace(COMMON_API_TOKEN, "<redacted>")
    .replace(DISCORD_TOKEN, "<redacted>")
    .replace(ABSOLUTE_PATH, "<path>")
    .replace(DISCORD_SNOWFLAKE, "<id>")
    .slice(0, MAX_STRING_LENGTH);
}

function normalizeError(error) {
  return {
    errorName: sanitizeLogText(error?.name || "Error"),
    errorMessage: sanitizeLogText(error?.message || String(error)),
    ...(typeof error?.code === "string" || typeof error?.code === "number"
      ? { errorCode: sanitizeLogText(error.code) }
      : {}),
  };
}

function normalizeValue(value, depth = 0) {
  if (value == null || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string" || typeof value === "bigint") {
    return sanitizeLogText(value);
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  if (value instanceof Error) {
    return normalizeError(value);
  }
  if (Array.isArray(value)) {
    return value.slice(0, 25).map((item) => normalizeValue(item, depth + 1));
  }
  if (typeof value === "object" && depth < 3) {
    const normalized = {};
    for (const [key, item] of Object.entries(value)) {
      if (isSafeFieldName(key)) {
        normalized[key] = normalizeValue(item, depth + 1);
      }
    }
    return normalized;
  }
  return sanitizeLogText(value);
}

function normalizeFields(fields) {
  const normalized = {};
  for (const [key, value] of Object.entries(fields ?? {})) {
    if (!isSafeFieldName(key) || value === undefined) {
      continue;
    }
    if (value instanceof Error) {
      Object.assign(normalized, normalizeError(value));
    } else {
      normalized[key] = normalizeValue(value);
    }
  }
  return normalized;
}

export function createServiceLogger({
  now = () => new Date(),
  stdout = (line) => console.log(line),
  stderr = (line) => console.error(line),
} = {}) {
  const contextStorage = new AsyncLocalStorage();

  function emit(level, event, fields = {}) {
    const timestamp = now();
    const record = {
      timestamp: timestamp instanceof Date ? timestamp.toISOString() : new Date(timestamp).toISOString(),
      level,
      event: sanitizeLogText(event),
      ...normalizeFields(contextStorage.getStore()),
      ...normalizeFields(fields),
    };
    const line = JSON.stringify(record);
    (level === "info" ? stdout : stderr)(line);
    return record;
  }

  return {
    info(event, fields) {
      return emit("info", event, fields);
    },
    warn(event, fields) {
      return emit("warn", event, fields);
    },
    error(event, fields) {
      return emit("error", event, fields);
    },
    withContext(fields, callback) {
      return contextStorage.run(normalizeFields(fields), callback);
    },
  };
}

export const serviceLogger = createServiceLogger();
