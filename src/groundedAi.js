import { performance } from "node:perf_hooks";
import { AiUsageLedger } from "./aiUsage.js";
import { toProviderEvidence } from "./aiSafety.js";
import { serviceLogger } from "./logger.js";
import { OllamaError, OllamaProvider } from "./ollama.js";

const SAFE_REASON_CODES = new Set([
  "busy",
  "daily-limit",
  "disabled",
  "invalid-answer",
  "invalid-answer-json",
  "invalid-citations",
  "invalid-json",
  "invalid-response",
  "model-missing",
  "monthly-limit",
  "no-evidence",
  "response-too-large",
  "service-unavailable",
  "timeout",
  "unsafe-answer",
]);

function fallbackAnswer(evidence, reason) {
  if (!evidence.length) {
    return {
      answer: "I could not find enough indexed evidence in this plugin context to answer safely. Try a more specific question or a regular lookup command.",
      citations: [],
      confidence: "low",
      generated: false,
      provider: "lexical",
      reason: "no-evidence",
    };
  }
  const explanation = reason === "busy"
    ? "Local answer generation is busy, so here is the closest indexed evidence instead."
    : reason === "daily-limit" || reason === "monthly-limit"
      ? "The local resource limit has been reached, so here is the closest indexed evidence instead."
      : "Local answer generation is unavailable, so here is the closest indexed evidence instead.";
  return {
    answer: explanation,
    citations: evidence.slice(0, 3).map((item) => item.id),
    confidence: "low",
    generated: false,
    provider: "lexical",
    reason,
  };
}

function safeReason(error) {
  const code = error instanceof OllamaError ? error.code : "service-unavailable";
  return SAFE_REASON_CODES.has(code) ? code : "service-unavailable";
}

export class GroundedAiService {
  constructor(config, {
    workspaceRoot,
    fetchImpl,
    metrics,
    logger = serviceLogger,
    provider,
    usageLedger,
    monotonicNow = () => performance.now(),
  } = {}) {
    this.config = config;
    this.metrics = metrics;
    this.logger = logger;
    this.monotonicNow = monotonicNow;
    this.provider = provider ?? new OllamaProvider({
      ...config.ollama,
      requestTimeoutMs: config.requestTimeoutMs,
      statusTimeoutMs: config.statusTimeoutMs,
      maxOutputTokens: config.maxOutputTokens,
    }, { fetchImpl });
    this.usage = usageLedger ?? new AiUsageLedger({
      workspaceRoot,
      statePath: config.usageStatePath,
      dailyRequestLimit: config.dailyRequestLimit,
      monthlyRequestLimit: config.monthlyRequestLimit,
    });
    this.busy = false;
    this.lastOutcome = "not-run";
  }

  recordMetrics({ operation, durationMs, outcome, inputTokens = 0, outputTokens = 0, provider }) {
    this.metrics?.recordAi({
      operation,
      durationMs,
      outcome,
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      provider,
      estimatedCostMicrousd: 0,
    });
  }

  async answer({ question, evidence, operation = "answer" }) {
    if (!this.config.enabled || !this.config.ollama.enabled) {
      return fallbackAnswer(evidence, "disabled");
    }
    if (!evidence.length) {
      return fallbackAnswer(evidence, "no-evidence");
    }
    if (this.busy) {
      this.recordMetrics({ operation, durationMs: 0, outcome: "rejected", provider: "lexical" });
      return fallbackAnswer(evidence, "busy");
    }

    this.busy = true;
    let allowance;
    try {
      allowance = await this.usage.canRequest();
    } catch {
      allowance = { allowed: false, reason: "daily-limit" };
    }
    if (!allowance.allowed) {
      this.recordMetrics({ operation, durationMs: 0, outcome: "rejected", provider: "lexical" });
      this.busy = false;
      return fallbackAnswer(evidence, allowance.reason);
    }

    const startedAt = this.monotonicNow();
    try {
      const generated = await this.provider.generate({
        question,
        evidence: toProviderEvidence(evidence),
      });
      const inputTokens = generated.usage?.inputTokens ?? 0;
      const outputTokens = generated.usage?.outputTokens ?? 0;
      this.recordMetrics({
        operation,
        durationMs: this.monotonicNow() - startedAt,
        outcome: "success",
        inputTokens,
        outputTokens,
        provider: "ollama",
      });
      await this.usage.record({ generated: true, inputTokens, outputTokens }).catch(() => {
        this.logger.warn("ai.usage_persistence_failed", { outcome: "error" });
      });
      this.lastOutcome = "ready";
      return {
        ...generated,
        generated: true,
        provider: "ollama",
        reason: "ready",
      };
    } catch (error) {
      const reason = safeReason(error);
      this.recordMetrics({
        operation,
        durationMs: this.monotonicNow() - startedAt,
        outcome: "error",
        provider: "ollama",
      });
      await this.usage.record({ generated: false }).catch(() => {
        this.logger.warn("ai.usage_persistence_failed", { outcome: "error" });
      });
      this.lastOutcome = reason;
      this.logger.warn("ai.local_generation_unavailable", { reasonCode: reason });
      return fallbackAnswer(evidence, reason);
    } finally {
      this.busy = false;
    }
  }

  async getStatus() {
    const [providerStatus, usage] = await Promise.all([
      this.config.enabled && this.config.ollama.enabled
        ? this.provider.status()
        : Promise.resolve({ ready: false, reason: "disabled" }),
      this.usage.getSnapshot().catch(() => null),
    ]);
    return {
      mode: "zero-cost-local-only",
      enabled: this.config.enabled,
      providerReady: providerStatus.ready,
      providerReason: providerStatus.reason,
      fallbackReady: true,
      externalProvidersEnabled: false,
      paidBudgetUsd: 0,
      busy: this.busy,
      lastOutcome: this.lastOutcome,
      usage,
    };
  }
}

export function createFallbackGroundedAnswer(evidence, reason = "disabled") {
  return fallbackAnswer(evidence, reason);
}
