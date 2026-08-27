import { performance } from "node:perf_hooks";
import OpenAI from "openai";
import { serviceLogger } from "./logger.js";

function extractFirstJsonObject(value) {
  const start = value.indexOf("{");
  const end = value.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    return null;
  }

  return value.slice(start, end + 1);
}

export class AiReranker {
  constructor({ apiKey, model }, { metrics } = {}) {
    this.model = model;
    this.client = new OpenAI({ apiKey });
    this.metrics = metrics;
  }

  recordUsage(operation, startedAt, outcome, usage = {}) {
    this.metrics?.recordAi({
      operation,
      durationMs: performance.now() - startedAt,
      outcome,
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      totalTokens: usage.total_tokens,
    });
  }

  async rerank(query, candidateItems) {
    if (candidateItems.length < 2) {
      return candidateItems;
    }

    const startedAt = performance.now();
    let usage;
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
      usage = response.usage;

      const rawText = response.output_text?.trim() || "";
      const jsonText = extractFirstJsonObject(rawText);
      if (!jsonText) {
        this.recordUsage("rerank", startedAt, "success", usage);
        return candidateItems;
      }

      const parsed = JSON.parse(jsonText);
      const rankedIds = Array.isArray(parsed.ranked_ids) ? parsed.ranked_ids.map(String) : [];
      if (!rankedIds.length) {
        this.recordUsage("rerank", startedAt, "success", usage);
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

      this.recordUsage("rerank", startedAt, "success", usage);
      return [...ranked, ...itemById.values()];
    } catch (error) {
      this.recordUsage("rerank", startedAt, "error", usage);
      serviceLogger.warn("ai.rerank_failed", { error });
      return candidateItems;
    }
  }

  async summarize(query, candidateItems, { profileName = "lookup" } = {}) {
    if (!candidateItems.length) {
      return null;
    }

    const startedAt = performance.now();
    let usage;
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
      usage = response.usage;

      const summary = response.output_text?.trim() || "";
      this.recordUsage("summary", startedAt, "success", usage);
      return summary || null;
    } catch (error) {
      this.recordUsage("summary", startedAt, "error", usage);
      serviceLogger.warn("ai.summary_failed", { error });
      return null;
    }
  }
}
