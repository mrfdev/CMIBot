import path from "node:path";
import { isSafeIndexedRelativePath, listSafeIndexedFiles } from "./browse.js";

export const AUTOCOMPLETE_CHOICE_LIMIT = 25;
const DISCORD_CHOICE_TEXT_LIMIT = 100;
const MAX_KEYWORD_CANDIDATES = 20_000;
const UNSAFE_CHOICE_PATTERN = /[`@\u0000-\u001f\u007f]/;

function normalizeChoiceText(value, maximumLength = DISCORD_CHOICE_TEXT_LIMIT) {
  const normalized = String(value ?? "").replace(/\s+/g, " ").trim();
  if (
    !normalized ||
    normalized.length > maximumLength ||
    UNSAFE_CHOICE_PATTERN.test(normalized)
  ) {
    return "";
  }
  return normalized;
}

function normalizeForMatch(value) {
  return String(value ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

function compactForMatch(value) {
  return normalizeForMatch(value).replace(/[^a-z0-9]+/g, "");
}

function splitIdentifierWords(value) {
  return String(value ?? "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .match(/[a-z0-9]+/gi) ?? [];
}

function collectKeywordCandidates(entries, maximumLength) {
  const candidates = new Map();

  function addCandidate(rawValue, priority) {
    const value = normalizeChoiceText(rawValue, maximumLength);
    if (!value) {
      return;
    }

    const identity = normalizeForMatch(value);
    const current = candidates.get(identity);
    if (current) {
      current.frequency += 1;
      current.priority = Math.max(current.priority, priority);
      return;
    }
    if (candidates.size >= MAX_KEYWORD_CANDIDATES) {
      return;
    }

    candidates.set(identity, {
      name: value,
      value,
      priority,
      frequency: 1,
      matchTerms: [identity, compactForMatch(value)],
    });
  }

  for (const entry of entries ?? []) {
    addCandidate(entry?.key, 4);
    addCandidate(entry?.yamlPath, 3);

    const leaf = String(entry?.yamlPath ?? "").split(".").at(-1);
    addCandidate(leaf, 2);

    const wordSources = new Set([entry?.key, leaf]);
    for (const source of wordSources) {
      for (const word of splitIdentifierWords(source)) {
        if (word.length >= 3) {
          addCandidate(word, 1);
        }
      }
    }
  }

  return [...candidates.values()];
}

function collectFileCandidates(entries, allowedRoots) {
  const listing = listSafeIndexedFiles(entries, {
    allowedRoots,
    maxFiles: 250,
  });

  return listing.files.flatMap((file) => {
    const value = normalizeChoiceText(file);
    if (!value) {
      return [];
    }
    const baseName = path.posix.basename(value);
    return [{
      name: value,
      value,
      priority: 1,
      frequency: 1,
      matchTerms: [normalizeForMatch(value), normalizeForMatch(baseName)],
    }];
  });
}

function getMatchRank(candidate, focusedValue) {
  if (!focusedValue) {
    return 5;
  }

  const compactFocused = compactForMatch(focusedValue);
  let bestRank = Number.POSITIVE_INFINITY;
  for (const term of candidate.matchTerms) {
    if (term === focusedValue) {
      bestRank = Math.min(bestRank, 0);
    } else if (term.startsWith(focusedValue)) {
      bestRank = Math.min(bestRank, 1);
    } else if (term.split(/[^a-z0-9]+/).some((part) => part.startsWith(focusedValue))) {
      bestRank = Math.min(bestRank, 2);
    } else if (term.includes(focusedValue)) {
      bestRank = Math.min(bestRank, 3);
    } else if (compactFocused && compactForMatch(term).includes(compactFocused)) {
      bestRank = Math.min(bestRank, 4);
    }
  }
  return bestRank;
}

export function buildAutocompleteIndex(entries, {
  allowedRoots = [],
  maximumKeywordLength = DISCORD_CHOICE_TEXT_LIMIT,
} = {}) {
  const safeKeywordLength = Math.max(
    1,
    Math.min(DISCORD_CHOICE_TEXT_LIMIT, Number(maximumKeywordLength) || DISCORD_CHOICE_TEXT_LIMIT),
  );
  const safeEntries = (entries ?? []).filter((entry) =>
    isSafeIndexedRelativePath(entry?.relativePath, allowedRoots, { allowIndexedLogs: true }),
  );
  return {
    keyword: collectKeywordCandidates(safeEntries, safeKeywordLength),
    file: collectFileCandidates(entries, allowedRoots),
  };
}

export function selectAutocompleteChoices(index, optionName, focusedValue, {
  limit = AUTOCOMPLETE_CHOICE_LIMIT,
} = {}) {
  const candidates = index?.[optionName];
  if (!Array.isArray(candidates)) {
    return [];
  }

  const focused = normalizeForMatch(focusedValue).slice(0, DISCORD_CHOICE_TEXT_LIMIT);
  const boundedLimit = Math.max(1, Math.min(AUTOCOMPLETE_CHOICE_LIMIT, Number(limit) || AUTOCOMPLETE_CHOICE_LIMIT));
  return candidates
    .map((candidate) => ({ candidate, rank: getMatchRank(candidate, focused) }))
    .filter((item) => Number.isFinite(item.rank))
    .sort(
      (left, right) =>
        left.rank - right.rank ||
        right.candidate.priority - left.candidate.priority ||
        right.candidate.frequency - left.candidate.frequency ||
        left.candidate.name.length - right.candidate.name.length ||
        left.candidate.name.localeCompare(right.candidate.name, undefined, { sensitivity: "base" }),
    )
    .slice(0, boundedLimit)
    .map(({ candidate }) => ({ name: candidate.name, value: candidate.value }));
}
