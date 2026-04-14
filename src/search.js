import OpenAI from "openai";

const BRACE_TOKEN_PATTERN = /^\{[^{}\s]+\}$/;
const PERCENT_TOKEN_PATTERN = /^%[^%\s]+%$/;
const BRACKET_TOKEN_PATTERN = /^\[[^\]\s]+\]$/;

function normalize(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function compact(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function tokenize(value) {
  return normalize(value).split(/\s+/).filter(Boolean);
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

function extractFirstJsonObject(value) {
  const start = value.indexOf("{");
  const end = value.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    return null;
  }

  return value.slice(start, end + 1);
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

export function lexicalSearch(query, entries, { limit = 20, mode = "exact" } = {}) {
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

  return candidatePool
    .map((entry) => ({
      entry,
      score: scoreEntry(query, entry),
    }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.entry.relativePath.localeCompare(right.entry.relativePath))
    .slice(0, limit);
}

export function orderMatchesForDisplay(items) {
  const fileOrder = new Map();

  for (const item of items) {
    if (!fileOrder.has(item.entry.relativePath)) {
      fileOrder.set(item.entry.relativePath, fileOrder.size);
    }
  }

  return [...items].sort((left, right) => {
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

export class AiReranker {
  constructor({ enabled, apiKey, model }) {
    this.model = model;
    this.client = enabled && apiKey ? new OpenAI({ apiKey }) : null;
  }

  get enabled() {
    return Boolean(this.client);
  }

  async rerank(query, candidateItems) {
    if (!this.client || candidateItems.length < 2) {
      return candidateItems;
    }

    try {
      const payload = {
        query,
        candidates: candidateItems.map((item, index) => ({
          id: String(index),
          path: item.entry.relativePath,
          yamlPath: item.entry.yamlPath,
          lineNumber: item.entry.lineNumber,
          snippet: item.entry.snippet,
        })),
      };

      const response = await this.client.responses.create({
        model: this.model,
        input: [
          {
            role: "system",
            content:
              "You rank YAML configuration matches for a Discord support bot. Prefer entries whose comment text or setting name best answers the search keyword. Return JSON only.",
          },
          {
            role: "user",
            content: JSON.stringify({
              instructions: {
                output: {
                  ranked_ids: ["candidate ids ordered from best to worst"],
                },
              },
              data: payload,
            }),
          },
        ],
      });

      const rawText = response.output_text?.trim() || "";
      const jsonText = extractFirstJsonObject(rawText);
      if (!jsonText) {
        return candidateItems;
      }

      const parsed = JSON.parse(jsonText);
      const rankedIds = Array.isArray(parsed.ranked_ids) ? parsed.ranked_ids.map(String) : [];
      if (!rankedIds.length) {
        return candidateItems;
      }

      const itemById = new Map(candidateItems.map((item, index) => [String(index), item]));
      const ranked = [];

      for (const rankedId of rankedIds) {
        const item = itemById.get(rankedId);
        if (item) {
          ranked.push(item);
          itemById.delete(rankedId);
        }
      }

      return [...ranked, ...itemById.values()];
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[CMIBot] OpenAI rerank failed: ${message}`);
      return candidateItems;
    }
  }

  async summarize(query, candidateItems, { profileName = "lookup" } = {}) {
    if (!this.client || !candidateItems.length) {
      return null;
    }

    try {
      const payload = {
        profileName,
        query,
        candidates: candidateItems.map((item) => ({
          path: item.entry.relativePath,
          yamlPath: item.entry.yamlPath,
          lineNumber: item.entry.lineNumber,
          snippet: item.entry.snippet,
        })),
      };

      const response = await this.client.responses.create({
        model: this.model,
        input: [
          {
            role: "system",
            content:
              "You write short support summaries for YAML configuration search results. Use only the provided snippets. Do not invent settings or behavior. Keep it to 1-2 concise sentences.",
          },
          {
            role: "user",
            content: JSON.stringify({
              instructions:
                "Summarize why these YAML results are relevant to the query. Mention the likely section or setting focus. Plain text only.",
              data: payload,
            }),
          },
        ],
      });

      const summary = response.output_text?.trim() || "";
      return summary || null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[CMIBot] OpenAI summary failed: ${message}`);
      return null;
    }
  }
}
