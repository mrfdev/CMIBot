import { expandSearchQueries } from "./searchSynonyms.js";

const BRACE_TOKEN_PATTERN = /^\{[^{}\s]+\}$/;
const PERCENT_TOKEN_PATTERN = /^%[^%\s]+%$/;
const BRACKET_TOKEN_PATTERN = /^\[[^\]\s]+\]$/;
const MAX_SUGGESTION_CANDIDATES = 20_000;
const MAX_SUGGESTION_TEXT_LENGTH = 80;
const UNSAFE_SUGGESTION_PATTERN = /[`@\u0000-\u001f\u007f]/;

function normalize(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function compact(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function tokenize(value) {
  return normalize(value).split(/\s+/).filter(Boolean);
}

function splitIdentifierWords(value) {
  return String(value)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .match(/[a-z0-9]+/gi) ?? [];
}

function getMaximumSuggestionDistance(length) {
  if (length <= 3) {
    return 0;
  }
  if (length <= 5) {
    return 1;
  }
  if (length <= 9) {
    return 2;
  }
  if (length <= 16) {
    return 3;
  }
  return 4;
}

function boundedDamerauLevenshtein(left, right, maximumDistance) {
  if (left === right) {
    return 0;
  }
  if (!maximumDistance || Math.abs(left.length - right.length) > maximumDistance) {
    return maximumDistance + 1;
  }

  let previousPrevious = null;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);

  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = new Array(right.length + 1).fill(maximumDistance + 1);
    current[0] = leftIndex;
    const start = Math.max(1, leftIndex - maximumDistance);
    const end = Math.min(right.length, leftIndex + maximumDistance);
    let rowMinimum = current[0];

    for (let rightIndex = start; rightIndex <= end; rightIndex += 1) {
      const substitutionCost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
      current[rightIndex] = Math.min(
        previous[rightIndex] + 1,
        current[rightIndex - 1] + 1,
        previous[rightIndex - 1] + substitutionCost,
      );

      if (
        previousPrevious &&
        leftIndex > 1 &&
        rightIndex > 1 &&
        left[leftIndex - 1] === right[rightIndex - 2] &&
        left[leftIndex - 2] === right[rightIndex - 1]
      ) {
        current[rightIndex] = Math.min(current[rightIndex], previousPrevious[rightIndex - 2] + 1);
      }
      rowMinimum = Math.min(rowMinimum, current[rightIndex]);
    }

    if (rowMinimum > maximumDistance) {
      return maximumDistance + 1;
    }
    previousPrevious = previous;
    previous = current;
  }

  return previous[right.length];
}

function collectSuggestionCandidates(entries) {
  const candidates = new Map();

  function addCandidate(display, priority) {
    const trimmed = String(display ?? "").replace(/\s+/g, " ").trim();
    if (
      !trimmed ||
      trimmed.length > MAX_SUGGESTION_TEXT_LENGTH ||
      UNSAFE_SUGGESTION_PATTERN.test(trimmed)
    ) {
      return;
    }

    const normalized = compact(trimmed);
    if (normalized.length < 4 || normalized.length > 64) {
      return;
    }

    const existing = candidates.get(normalized);
    if (existing) {
      existing.frequency += 1;
      if (priority > existing.priority) {
        existing.display = trimmed;
        existing.priority = priority;
      }
      return;
    }
    if (candidates.size >= MAX_SUGGESTION_CANDIDATES) {
      return;
    }
    candidates.set(normalized, {
      display: trimmed,
      normalized,
      priority,
      frequency: 1,
    });
  }

  for (const entry of entries) {
    addCandidate(entry.key, 3);
    addCandidate(entry.yamlPath, 2);
    const keyParts = new Set([
      ...String(entry.yamlPath ?? "").split("."),
      String(entry.key ?? ""),
    ]);
    for (const keyPart of keyParts) {
      for (const word of splitIdentifierWords(keyPart)) {
        addCandidate(word, 1);
      }
    }
  }

  return [...candidates.values()];
}

function collectSuggestionTargets(query) {
  const rawTargets = [query, ...splitIdentifierWords(query)];
  const targets = [];
  const seen = new Set();
  for (const rawTarget of rawTargets) {
    const normalized = compact(rawTarget);
    if (normalized.length < 4 || normalized.length > 64 || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    targets.push(normalized);
  }
  return targets;
}

export function suggestSearchQueries(query, entries, { limit = 3 } = {}) {
  const targets = collectSuggestionTargets(query);
  if (!targets.length || !Array.isArray(entries) || !entries.length) {
    return [];
  }

  const ranked = [];
  for (const candidate of collectSuggestionCandidates(entries)) {
    let best = null;
    for (let targetIndex = 0; targetIndex < targets.length; targetIndex += 1) {
      const target = targets[targetIndex];
      if (candidate.normalized === target) {
        continue;
      }
      const longestLength = Math.max(target.length, candidate.normalized.length);
      const maximumDistance = getMaximumSuggestionDistance(longestLength);
      const distance = boundedDamerauLevenshtein(
        target,
        candidate.normalized,
        maximumDistance,
      );
      if (distance > maximumDistance || 1 - distance / longestLength < 0.7) {
        continue;
      }
      const match = {
        ...candidate,
        distance,
        distanceRatio: distance / longestLength,
        targetIndex,
        lengthDifference: Math.abs(target.length - candidate.normalized.length),
      };
      if (
        !best ||
        match.distanceRatio < best.distanceRatio ||
        (match.distanceRatio === best.distanceRatio && match.distance < best.distance) ||
        (match.distanceRatio === best.distanceRatio &&
          match.distance === best.distance &&
          match.targetIndex < best.targetIndex)
      ) {
        best = match;
      }
    }
    if (best) {
      ranked.push(best);
    }
  }

  const boundedLimit = Math.max(1, Math.min(5, Number(limit) || 3));
  return ranked
    .sort(
      (left, right) =>
        left.distanceRatio - right.distanceRatio ||
        left.distance - right.distance ||
        left.targetIndex - right.targetIndex ||
        right.priority - left.priority ||
        right.frequency - left.frequency ||
        left.lengthDifference - right.lengthDifference ||
        left.display.localeCompare(right.display, undefined, { sensitivity: "base" }),
    )
    .slice(0, boundedLimit)
    .map((candidate) => candidate.display);
}

function isSpecialTokenQuery(query) {
  const trimmed = query.trim();
  return BRACE_TOKEN_PATTERN.test(trimmed) || PERCENT_TOKEN_PATTERN.test(trimmed) || BRACKET_TOKEN_PATTERN.test(trimmed);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function countOccurrences(haystack, needle) {
  if (!needle) {
    return 0;
  }

  let count = 0;
  let cursor = 0;

  while (cursor <= haystack.length) {
    const nextIndex = haystack.indexOf(needle, cursor);
    if (nextIndex === -1) {
      break;
    }

    count += 1;
    cursor = nextIndex + needle.length;
  }

  return count;
}

function diceCoefficient(left, right) {
  if (!left || !right) {
    return 0;
  }

  if (left === right) {
    return 1;
  }

  const leftBigrams = new Map();
  for (let index = 0; index < left.length - 1; index += 1) {
    const chunk = left.slice(index, index + 2);
    leftBigrams.set(chunk, (leftBigrams.get(chunk) ?? 0) + 1);
  }

  let overlap = 0;
  for (let index = 0; index < right.length - 1; index += 1) {
    const chunk = right.slice(index, index + 2);
    const count = leftBigrams.get(chunk) ?? 0;
    if (count > 0) {
      leftBigrams.set(chunk, count - 1);
      overlap += 1;
    }
  }

  return (2 * overlap) / (left.length + right.length - 2);
}

function scoreEntry(query, entry) {
  const normalizedQuery = normalize(query);
  const rawQuery = query.trim().toLowerCase();
  const compactQuery = compact(query);
  const tokens = tokenize(query);
  const text = entry.searchText;
  const compactText = compact(text);
  const key = normalize(entry.key);
  const path = normalize(entry.yamlPath);
  const comments = entry.comments
    .map((line) => line.replace(/^\s*#\s?/, ""))
    .join("\n")
    .toLowerCase();

  let score = 0;
  score += countOccurrences(text, normalizedQuery) * 40;
  score += countOccurrences(key, normalizedQuery) * 50;
  score += countOccurrences(path, normalizedQuery) * 35;
  score += countOccurrences(comments, normalizedQuery) * 60;

  if (rawQuery && entry.key.toLowerCase() === rawQuery) {
    score += 300;
  }

  if (tokens.length > 1 && compactQuery && compactText.includes(compactQuery)) {
    score += 120;
  }

  for (const token of tokens) {
    if (key.includes(token)) {
      score += 22;
    }
    if (path.includes(token)) {
      score += 15;
    }
    if (text.includes(token)) {
      score += 10;
    }
    if (comments.includes(token)) {
      score += 18;
    }

    const similarity = Math.max(diceCoefficient(token, key), diceCoefficient(token, path));
    if (similarity >= 0.72) {
      score += similarity * 20;
    }
  }

  if (text.includes(normalizedQuery)) {
    score += 25;
  }

  if (!entry.value) {
    score -= 18;
  }

  return score;
}

function matchesPhrase(entry, normalizedQuery, compactQuery) {
  if (!normalizedQuery) {
    return false;
  }

  if (entry.searchText.includes(normalizedQuery)) {
    return true;
  }

  return compactQuery ? compact(entry.searchText).includes(compactQuery) : false;
}

function matchesWholeText(value, normalizedQuery) {
  if (!normalizedQuery) {
    return false;
  }

  const normalizedValue = normalize(value);
  if (!normalizedValue) {
    return false;
  }

  const pattern = new RegExp(`(?:^|\\s)${escapeRegExp(normalizedQuery)}(?:\\s|$)`, "i");
  return pattern.test(normalizedValue);
}

function matchesWholeEntry(entry, normalizedQuery) {
  return matchesWholeText(entry.searchText, normalizedQuery);
}

function getDirectSynonymPriority(entry, normalizedQuery) {
  if (matchesWholeEntry(entry, normalizedQuery)) {
    return 3;
  }
  if (normalizedQuery.length >= 2 && !normalizedQuery.includes(" ")) {
    return tokenize(entry.searchText).some((token) => token.startsWith(normalizedQuery)) ? 2 : 0;
  }
  return 0;
}

function rankSingleQuery(query, entries, { mode = "exact" } = {}) {
  const normalizedQuery = normalize(query);
  const rawQuery = query.trim().toLowerCase();
  const tokens = tokenize(query).filter((token) => token.length >= 3);
  const compactQuery = compact(query);
  const isPhraseQuery = tokens.length > 1;
  const specialTokenQuery = isSpecialTokenQuery(query);

  let candidatePool = entries;

  if (specialTokenQuery) {
    const exactTokenMatches = entries.filter((entry) => entry.key.toLowerCase() === rawQuery);
    if (exactTokenMatches.length) {
      candidatePool = exactTokenMatches;
    } else {
      const tokenMatches = entries.filter((entry) => entry.searchText.includes(rawQuery));
      candidatePool = tokenMatches.length ? tokenMatches : entries;
    }
  } else if (mode === "broad") {
    const broadMatches = entries.filter((entry) => {
      if (entry.searchText.includes(normalizedQuery)) {
        return true;
      }

      return tokens.some((token) => entry.searchText.includes(token));
    });

    candidatePool = broadMatches.length ? broadMatches : entries;
  } else if (mode === "whole") {
    const wholeMatches = entries.filter((entry) => matchesWholeEntry(entry, normalizedQuery));
    if (wholeMatches.length) {
      candidatePool = wholeMatches;
    } else {
      candidatePool = [];
    }
  } else if (isPhraseQuery) {
    const phraseMatches = entries.filter((entry) => matchesPhrase(entry, normalizedQuery, compactQuery));
    if (phraseMatches.length) {
      candidatePool = phraseMatches;
    } else {
      const allTokenMatches = entries.filter((entry) => tokens.every((token) => entry.searchText.includes(token)));
      candidatePool = allTokenMatches;
    }
  } else {
    const strongMatches = entries.filter((entry) => {
      if (entry.searchText.includes(normalizedQuery)) {
        return true;
      }

      return tokens.some((token) => entry.searchText.includes(token));
    });

    candidatePool = strongMatches.length ? strongMatches : entries;
  }

  const rankedMatches = candidatePool
    .map((entry) => ({
      entry,
      score: scoreEntry(query, entry),
    }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.entry.relativePath.localeCompare(right.entry.relativePath));

  return rankedMatches;
}

export function lexicalSearchWithStats(query, entries, { limit = 20, mode = "exact", synonyms = {} } = {}) {
  const queryVariants = expandSearchQueries(query, synonyms);
  const firstMatches = rankSingleQuery(queryVariants[0], entries, { mode });

  if (queryVariants.length === 1) {
    return {
      matches: firstMatches.slice(0, limit),
      totalMatches: firstMatches.length,
      matchedFiles: [...new Set(firstMatches.map((item) => item.entry.relativePath))],
      synonymApplied: false,
      queryVariantCount: 1,
    };
  }

  const matchesByEntry = new Map();
  const mergeMatches = (items, getPriority) => {
    for (const item of items) {
      const previous = matchesByEntry.get(item.entry);
      const priority = getPriority(item);
      if (priority <= 0) {
        continue;
      }
      if (
        !previous ||
        priority > previous.priority ||
        (priority === previous.priority && item.score > previous.score)
      ) {
        matchesByEntry.set(item.entry, { ...item, priority });
      }
    }
  };

  const normalizedOriginalQuery = normalize(queryVariants[0]);
  mergeMatches(firstMatches, (item) => getDirectSynonymPriority(item.entry, normalizedOriginalQuery));
  for (const expandedQuery of queryVariants.slice(1)) {
    mergeMatches(rankSingleQuery(expandedQuery, entries, { mode }), () => 1);
  }

  const rankedMatches = [...matchesByEntry.values()]
    .sort(
      (left, right) =>
        right.priority - left.priority ||
        right.score - left.score ||
        left.entry.relativePath.localeCompare(right.entry.relativePath) ||
        left.entry.lineNumber - right.entry.lineNumber ||
        left.entry.yamlPath.localeCompare(right.entry.yamlPath),
    )
    .map(({ entry, score, priority }) => ({ entry, score, synonymPriority: priority }));

  return {
    matches: rankedMatches.slice(0, limit),
    totalMatches: rankedMatches.length,
    matchedFiles: [...new Set(rankedMatches.map((item) => item.entry.relativePath))],
    synonymApplied: true,
    queryVariantCount: queryVariants.length,
  };
}

export function lexicalSearch(query, entries, options = {}) {
  return lexicalSearchWithStats(query, entries, options).matches;
}

export function orderMatchesForDisplay(items) {
  const fileOrder = new Map();

  for (const item of items) {
    if (!fileOrder.has(item.entry.relativePath)) {
      fileOrder.set(item.entry.relativePath, fileOrder.size);
    }
  }

  return [...items].sort((left, right) => {
    const priorityDifference = (right.synonymPriority ?? 0) - (left.synonymPriority ?? 0);
    if (priorityDifference !== 0) {
      return priorityDifference;
    }

    const leftFileOrder = fileOrder.get(left.entry.relativePath) ?? Number.MAX_SAFE_INTEGER;
    const rightFileOrder = fileOrder.get(right.entry.relativePath) ?? Number.MAX_SAFE_INTEGER;

    if (leftFileOrder !== rightFileOrder) {
      return leftFileOrder - rightFileOrder;
    }

    if (left.entry.lineNumber !== right.entry.lineNumber) {
      return left.entry.lineNumber - right.entry.lineNumber;
    }

    return left.entry.yamlPath.localeCompare(right.entry.yamlPath);
  });
}
