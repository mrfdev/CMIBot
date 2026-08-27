import { MessageFlags } from "discord.js";
import {
  collectGroundedEvidence,
  validateAiQuestion,
} from "../aiSafety.js";
import { createFallbackGroundedAnswer } from "../groundedAi.js";
import { sanitizeForDisplay } from "../security.js";
import { hasRole } from "./context.js";
import { NO_MENTIONS } from "./constants.js";

const DISCORD_MESSAGE_LIMIT = 2_000;

function getSafeSourceUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      url.hostname.toLowerCase() === "github.com" &&
      !url.username &&
      !url.password
      ? url.href
      : "";
  } catch {
    return "";
  }
}

function formatCitation(evidence) {
  const label = `\`${evidence.id}\` \`${sanitizeForDisplay(evidence.profileName)}\` · \`${sanitizeForDisplay(evidence.yamlPath)}\``;
  const sourceUrl = getSafeSourceUrl(evidence.sourceUrl);
  return sourceUrl
    ? `- ${label} · [source line ${evidence.lineNumber}](<${sourceUrl}>)`
    : `- ${label} · indexed line ${evidence.lineNumber}`;
}

export function formatGroundedAnswerMessage(result, evidence) {
  const sourceById = new Map(evidence.map((item) => [item.id, item]));
  const cited = [...new Set(result.citations ?? [])]
    .map((id) => sourceById.get(id))
    .filter(Boolean);
  const heading = result.generated ? "### Local Grounded Answer" : "### Indexed Evidence Fallback";
  const disclosure = result.generated
    ? `_Generated locally from the cited indexed evidence. Confidence: ${result.confidence}._`
    : "_Deterministic fallback. No AI service received the question or evidence._";
  const answer = sanitizeForDisplay(result.answer).slice(0, 1_000);
  const lines = [heading, answer];
  if (cited.length) {
    lines.push("", "Sources:");
    for (const item of cited) {
      const citation = formatCitation(item);
      const candidate = [...lines, citation, "", disclosure].join("\n");
      if (candidate.length > DISCORD_MESSAGE_LIMIT) {
        break;
      }
      lines.push(citation);
    }
  }
  lines.push("", disclosure);
  return lines.join("\n").slice(0, DISCORD_MESSAGE_LIMIT);
}

function formatCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

export function formatAiStatusMessage(status) {
  const localState = !status.enabled
    ? "disabled"
    : status.busy
      ? "busy"
      : status.providerReady
        ? "ready"
        : status.providerReason === "model-missing"
          ? "local model not installed"
          : "local service unavailable";
  const lines = [
    "### Local AI Status",
    "Mode: `zero-cost, local-only, evidence-grounded`",
    `Local generation: \`${localState}\``,
    "Cited lexical fallback: `ready`",
    "External providers: `disabled and unsupported`",
    "Paid budget: `$0.00 hard limit`",
  ];
  if (status.usage) {
    lines.push(
      `Today (UTC): \`${formatCount(status.usage.today.requests)}/${formatCount(status.usage.dailyRequestLimit) || "unlimited"} attempts, ${formatCount(status.usage.today.generated)} generated, ${formatCount(status.usage.today.inputTokens + status.usage.today.outputTokens)} tokens\``,
      `This month (UTC): \`${formatCount(status.usage.month.requests)}/${formatCount(status.usage.monthlyRequestLimit) || "unlimited"} attempts, ${formatCount(status.usage.month.generated)} generated, ${formatCount(status.usage.month.inputTokens + status.usage.month.outputTokens)} tokens\``,
    );
  }
  lines.push("", "_Only aggregate counters are retained. Questions, prompts, identities, routes, endpoints, hostnames, and private paths are omitted._");
  return lines.join("\n");
}

export async function handleAskInteraction({
  interaction,
  subcommand,
  context,
  config,
  searchCache,
  runtimeInfo,
  resolveAiService,
  cooldowns,
  logEvent,
  logRateLimitEvent,
}) {
  if (!hasRole(interaction.member, { roleIds: config.discord.aiRoleIds })) {
    await logEvent(interaction, {
      subcommand,
      outcome: "denied",
      reason: "ai-role",
      detectedContext: context.pluginId,
    });
    await interaction.reply({
      content: "Only the configured AI role can use private grounded answers.",
      flags: MessageFlags.Ephemeral,
      allowedMentions: NO_MENTIONS,
    });
    return;
  }

  const validation = validateAiQuestion(
    interaction.options.getString("question", true),
    { maxQuestionLength: config.ai.maxQuestionLength },
  );
  if (!validation.ok) {
    await logEvent(interaction, {
      subcommand,
      questionLength: validation.question.length,
      outcome: "rejected",
      reason: "unsafe-ai-question",
      detectedContext: context.pluginId,
    });
    await interaction.reply({
      content: validation.reason,
      flags: MessageFlags.Ephemeral,
      allowedMentions: NO_MENTIONS,
    });
    return;
  }

  const cooldown = cooldowns.check(
    interaction.user.id,
    `${context.pluginId}:ai-question`,
    config.security.aiQuestionCooldownSeconds,
  );
  if (!cooldown.allowed) {
    await logRateLimitEvent(interaction, `ai-question:${interaction.user.id}`, {
      subcommand,
      questionLength: validation.question.length,
      outcome: "rejected",
      reason: `ai-question-cooldown:${cooldown.retryAfterSeconds}`,
      detectedContext: context.pluginId,
    });
    await interaction.reply({
      content: `Please wait ${cooldown.retryAfterSeconds}s before asking another grounded question.`,
      flags: MessageFlags.Ephemeral,
      allowedMentions: NO_MENTIONS,
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const evidence = collectGroundedEvidence({
      question: validation.question,
      plugin: context.plugin,
      config,
      searchCache,
      runtimeInfo,
    });
    const service = await resolveAiService();
    const result = service
      ? await service.answer({ question: validation.question, evidence, operation: "answer" })
      : createFallbackGroundedAnswer(evidence, "disabled");
    await logEvent(interaction, {
      subcommand,
      questionLength: validation.question.length,
      evidenceCount: evidence.length,
      aiGenerated: result.generated,
      aiProvider: result.provider,
      aiReason: result.reason,
      outcome: evidence.length ? "success" : "empty",
      detectedContext: context.pluginId,
    });
    await interaction.editReply({
      content: formatGroundedAnswerMessage(result, evidence),
      allowedMentions: NO_MENTIONS,
    });
  } catch {
    await logEvent(interaction, {
      subcommand,
      questionLength: validation.question.length,
      outcome: "error",
      reason: "grounded-answer-failed",
      detectedContext: context.pluginId,
    });
    await interaction.editReply({
      content: "The private grounded answer could not be prepared safely.",
      allowedMentions: NO_MENTIONS,
    });
  }
}
