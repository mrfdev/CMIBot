import { redactIndexedEvidence } from "./redaction.js";
import { lexicalSearchWithStats } from "./search.js";
import { buildPinnedSourceUrl } from "./sourceLinks.js";
import { isSafeIndexedRelativePath } from "./discord/browse.js";

const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;
const PRIVATE_KEY_PATTERN = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/i;
const AUTHORIZATION_TOKEN_PATTERN = /\b(?:Bot|Bearer)\s+[A-Za-z0-9._~+/-]{8,}/i;
const COMMON_API_TOKEN_PATTERN = /\b(?:sk-[A-Za-z0-9_-]{8,}|AIza[A-Za-z0-9_-]{12,})\b/;
const DISCORD_TOKEN_PATTERN = /\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{20,}\b/;
const DISCORD_SNOWFLAKE_PATTERN = /\b\d{17,20}\b/;
const ABSOLUTE_PRIVATE_PATH_PATTERN = /(?:^|\s)(?:\/(?:Users|home|private|var|etc|opt|tmp)(?:\/[^\s"'`]+)+|[A-Za-z]:\\[^\s"'`]+)/;
const TRAVERSAL_PATTERN = /(?:^|[\s\\/])\.\.(?:[\\/]|$)/;
const SENSITIVE_ASSIGNMENT_PATTERN =
  /\b(?:password|passwd|secret|token|credentials?|authorization|api[-_. ]?key|private[-_. ]?key|access[-_. ]?key|client[-_. ]?secret)\b\s*[:=]\s*["']?[^\s"']{6,}/i;
const QUESTION_STOP_WORDS = new Set([
  "about", "after", "also", "and", "are", "can", "could", "does", "for", "from", "have",
  "how", "into", "is", "it", "make", "me", "of", "on", "or", "please", "set", "should", "that",
  "the", "their", "this", "to", "use", "what", "when", "where", "which", "with", "would", "you",
]);

function normalizeQuestion(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

export function validateAiQuestion(rawQuestion, { maxQuestionLength = 320 } = {}) {
  const question = normalizeQuestion(rawQuestion);
  if (!question) {
    return { ok: false, question: "", reason: "Please provide a question." };
  }
  if (CONTROL_CHARACTER_PATTERN.test(question)) {
    return { ok: false, question, reason: "That question contains unsupported control characters." };
  }
  if (question.length > maxQuestionLength) {
    return {
      ok: false,
      question,
      reason: `Please keep questions under ${maxQuestionLength} characters.`,
    };
  }
  if (
    PRIVATE_KEY_PATTERN.test(question) ||
    AUTHORIZATION_TOKEN_PATTERN.test(question) ||
    COMMON_API_TOKEN_PATTERN.test(question) ||
    DISCORD_TOKEN_PATTERN.test(question) ||
    DISCORD_SNOWFLAKE_PATTERN.test(question) ||
    ABSOLUTE_PRIVATE_PATH_PATTERN.test(question) ||
    TRAVERSAL_PATTERN.test(question) ||
    SENSITIVE_ASSIGNMENT_PATTERN.test(question)
  ) {
    return {
      ok: false,
      question,
      reason: "That question looks like it may contain a secret, private identifier, or private filesystem path. Remove it and try again.",
    };
  }
  if (!/[a-z0-9]/i.test(question)) {
    return { ok: false, question, reason: "Please include at least one letter or number." };
  }
  return { ok: true, question, reason: "" };
}

export function buildAiRetrievalQuery(question) {
  const terms = normalizeQuestion(question)
    .toLowerCase()
    .match(/[a-z0-9_.:%{}\[\]-]+/g) ?? [];
  const useful = [];
  const seen = new Set();
  for (const term of terms) {
    const normalized = term.replace(/^[^a-z0-9%{\[]+|[^a-z0-9%}\]]+$/gi, "");
    const compact = normalized.replace(/[^a-z0-9]/gi, "");
    if (
      !normalized ||
      compact.length < 3 ||
      QUESTION_STOP_WORDS.has(normalized) ||
      seen.has(normalized)
    ) {
      continue;
    }
    seen.add(normalized);
    useful.push(normalized);
    if (useful.length >= 10) {
      break;
    }
  }
  return useful.join(" ") || normalizeQuestion(question);
}

function safeYamlPath(value) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f`@]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180) || "indexed entry";
}

function truncateEvidence(value, maximumLength) {
  const text = String(value).trim();
  if (text.length <= maximumLength) {
    return text;
  }
  const candidate = text.slice(0, Math.max(1, maximumLength - 1));
  const newline = candidate.lastIndexOf("\n");
  return `${(newline >= maximumLength / 2 ? candidate.slice(0, newline) : candidate).trimEnd()}…`;
}

export function prepareGroundedEvidence(items, {
  config,
  plugin,
  runtimeInfo,
  maxItems = config.ai.maxEvidenceItems,
  maxSnippetChars = config.ai.maxEvidenceChars,
} = {}) {
  const allowedRoots = [
    ...(plugin.debugRoots ?? []),
    ...(config.sharedDebugRoots ?? []).flatMap((root) => root.directories ?? []),
  ];
  const evidence = [];
  const identities = new Set();

  for (const item of items ?? []) {
    const entry = item?.entry;
    if (
      !entry ||
      !isSafeIndexedRelativePath(entry.relativePath, allowedRoots, { allowIndexedLogs: true }) ||
      !Number.isSafeInteger(entry.lineNumber) ||
      entry.lineNumber < 1
    ) {
      continue;
    }
    const identity = `${entry.relativePath}\u0000${entry.lineNumber}\u0000${entry.yamlPath}`;
    if (identities.has(identity)) {
      continue;
    }
    identities.add(identity);

    const redaction = redactIndexedEvidence(entry.snippet ?? "");
    const snippet = truncateEvidence(redaction.text, maxSnippetChars);
    if (!snippet) {
      continue;
    }
    const sourceUrl = buildPinnedSourceUrl({
      enabled: config.search.sourceLinksEnabled,
      repositoryUrl: config.search.sourceRepositoryUrl,
      revision: runtimeInfo?.fullRevision,
      relativePath: entry.relativePath,
      lineNumber: entry.lineNumber,
      allowedRoots,
    });
    evidence.push({
      id: `E${evidence.length + 1}`,
      profileName: safeYamlPath(item.profileName),
      yamlPath: safeYamlPath(entry.yamlPath),
      lineNumber: entry.lineNumber,
      snippet,
      sourceUrl,
      redacted: redaction.redacted,
    });
    if (evidence.length >= maxItems) {
      break;
    }
  }
  return evidence;
}

export function collectGroundedEvidence({ question, plugin, config, searchCache, runtimeInfo }) {
  const query = buildAiRetrievalQuery(question);
  const candidates = [];
  for (const profileName of Object.keys(plugin.profiles ?? {})) {
    let entries;
    try {
      entries = searchCache.getEntries(plugin.id, profileName);
    } catch {
      continue;
    }
    const result = lexicalSearchWithStats(query, entries, {
      limit: Math.max(6, config.ai.maxEvidenceItems * 2),
      mode: "broad",
      synonyms: config.search.synonymsByPlugin?.[plugin.id] ?? {},
    });
    for (const match of result.matches) {
      candidates.push({ ...match, profileName });
    }
  }
  candidates.sort(
    (left, right) =>
      right.score - left.score ||
      left.profileName.localeCompare(right.profileName) ||
      left.entry.relativePath.localeCompare(right.entry.relativePath) ||
      left.entry.lineNumber - right.entry.lineNumber,
  );
  return prepareGroundedEvidence(candidates, { config, plugin, runtimeInfo });
}

export function toProviderEvidence(evidence) {
  return (evidence ?? []).map(({ id, profileName, yamlPath, snippet }) => ({
    id,
    profile: profileName,
    entry: yamlPath,
    snippet,
  }));
}
