import OpenAI from "openai";

function extractFirstJsonObject(value) {
  const start = value.indexOf("{");
  const end = value.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    return null;
  }

  return value.slice(start, end + 1);
}

export class AiReranker {
  constructor({ apiKey, model }) {
    this.model = model;
    this.client = new OpenAI({ apiKey });
  }

  async rerank(query, candidateItems) {
    if (candidateItems.length < 2) {
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
      console.warn(`[LookupBot] OpenAI rerank failed: ${message}`);
      return candidateItems;
    }
  }

  async summarize(query, candidateItems, { profileName = "lookup" } = {}) {
    if (!candidateItems.length) {
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
      console.warn(`[LookupBot] OpenAI summary failed: ${message}`);
      return null;
    }
  }
}
