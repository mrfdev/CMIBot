import { serviceLogger } from "./logger.js";
import { getVersionAttentionSummary } from "./versionCatalog.js";

const MAX_UPDATE_DETAILS = 6;

function toTimestamp(value) {
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

function discordTimestamp(timestamp) {
  return `<t:${Math.floor(timestamp / 1000)}:R>`;
}

function sanitizeAlertText(value, fallback, maxLength = 80) {
  const normalized = String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength)
    .replaceAll("@", "＠")
    .replace(/[`*_~|<>[\]\\]/g, "");
  return normalized || fallback;
}

function formatTrackedRelease(resource) {
  const version = sanitizeAlertText(resource?.version, "unknown", 48);
  const build = resource?.build == null ? Number.NaN : Number(resource.build);
  return Number.isSafeInteger(build) && build >= 0 ? `${version} build ${build}` : version;
}

function resolveUpdateDetail(snapshot, key) {
  if (key === "paper") {
    return {
      label: sanitizeAlertText(snapshot.catalog?.paper?.label, "Paper", 48),
      current: formatTrackedRelease(snapshot.catalog?.paper),
      latest: formatTrackedRelease(snapshot.paper),
    };
  }

  const separator = key.indexOf(":");
  const type = separator < 0 ? "" : key.slice(0, separator);
  const resourceId = separator < 0 ? "" : key.slice(separator + 1);
  if (type === "plugin") {
    const resource = snapshot.catalog?.plugins?.find((entry) => entry.id === resourceId);
    const upstream = snapshot.plugins?.get(resourceId);
    return {
      label: sanitizeAlertText(resource?.label, "Tracked plugin", 48),
      current: formatTrackedRelease(resource),
      latest: formatTrackedRelease(upstream),
    };
  }
  if (type === "companion") {
    const resource = snapshot.catalog?.companions?.find((entry) => entry.id === resourceId);
    const upstream = snapshot.companions?.get(resourceId);
    return {
      label: sanitizeAlertText(resource?.label, "Tracked companion", 48),
      current: formatTrackedRelease(resource),
      latest: formatTrackedRelease(upstream),
    };
  }
  return null;
}

function formatAttentionLines(attention) {
  const lines = [];
  if (attention.cleanDataStale) {
    lines.push("- The clean lookup snapshot is missing or older than its configured freshness limit.");
  }
  if (attention.upstreamOverdue) {
    lines.push("- The scheduled upstream version check is overdue.");
  }
  if (attention.upstreamFailureCount > 0) {
    lines.push(`- ${attention.upstreamFailureCount} upstream check(s) are unavailable or failed.`);
  }
  if (attention.retainedCount > 0 || attention.staleResourceCount > 0) {
    lines.push(
      `- ${Math.max(attention.retainedCount, attention.staleResourceCount)} last-known result(s) are being retained.`,
    );
  }
  if (attention.updateCount > 0) {
    const updateDetails = Array.isArray(attention.updateDetails) ? attention.updateDetails : [];
    lines.push(`- ${attention.updateCount} tracked update(s) are available:`);
    for (const update of updateDetails.slice(0, MAX_UPDATE_DETAILS)) {
      lines.push(`  - **${update.label}:** \`${update.current}\` → \`${update.latest}\``);
    }
    if (attention.updateCount > updateDetails.length) {
      lines.push(
        `  - ${attention.updateCount - updateDetails.length} additional update(s) omitted; run \`/lookup latest scope:all\` for the full list.`,
      );
    }
  }
  return lines;
}

function privacyFooter(now) {
  return `Checked ${discordTimestamp(now)}. Public tracked labels and release versions are shown; resource IDs, URLs, paths, hostnames, channel IDs, and raw errors are omitted.`;
}

export function evaluateAttention(snapshot, options = {}) {
  const now = Number(options.now ?? Date.now());
  const cleanDataMaxAgeMs = Math.max(1, Number(options.cleanDataMaxAgeMs) || 48 * 60 * 60 * 1000);
  const upstreamMaxAgeMs = Math.max(1, Number(options.upstreamMaxAgeMs) || 24 * 60 * 60 * 1000);
  const generatedAt = toTimestamp(snapshot?.catalog?.generatedAt);
  const checkedAt = toTimestamp(snapshot?.checkedAt);
  const versionAttention = getVersionAttentionSummary(snapshot);
  const allUpdateDetails = versionAttention.updateKeys
    .map((key) => resolveUpdateDetail(snapshot, key))
    .filter(Boolean);
  const updateDetails = allUpdateDetails.slice(0, MAX_UPDATE_DETAILS);
  const checkEnabled = Boolean(snapshot?.checkEnabled);
  const cleanDataStale = generatedAt === null || now - generatedAt > cleanDataMaxAgeMs;
  const upstreamOverdue = checkEnabled && (checkedAt === null || now - checkedAt > upstreamMaxAgeMs);
  const upstreamFailureCount = checkEnabled
    ? Math.max(Number(snapshot?.errorCount) || 0, versionAttention.unavailableKeys.length)
    : 0;
  const retainedCount = checkEnabled ? Number(snapshot?.retainedCount) || 0 : 0;
  const staleResourceCount = checkEnabled ? versionAttention.staleKeys.length : 0;
  const updateCount = checkEnabled ? versionAttention.updateKeys.length : 0;
  const needsAttention =
    cleanDataStale ||
    upstreamOverdue ||
    upstreamFailureCount > 0 ||
    retainedCount > 0 ||
    staleResourceCount > 0 ||
    updateCount > 0;

  return {
    needsAttention,
    cleanDataStale,
    upstreamOverdue,
    upstreamFailureCount,
    retainedCount,
    staleResourceCount,
    updateCount,
    updateDetails,
    generatedAt,
    checkedAt,
    fingerprint: JSON.stringify({
      cleanDataStale,
      upstreamOverdue,
      upstreamFailureCount,
      retainedCount,
      staleResourceCount,
      updateCount,
      updates: allUpdateDetails,
    }),
  };
}

export function formatAttentionMessage(attention, { recovery = false, now = Date.now() } = {}) {
  if (recovery) {
    return [
      "✅ **LookupBot data checks recovered**",
      "No stale snapshots, failed upstream checks, or tracked updates currently need attention.",
      `Checked ${discordTimestamp(now)}.`,
    ].join("\n");
  }

  const lines = ["⚠️ **LookupBot data attention needed**", ...formatAttentionLines(attention)];
  lines.push(privacyFooter(now));
  return lines.join("\n");
}

export function formatAttentionTestMessage(attention, { now = Date.now() } = {}) {
  const lines = [
    "🧪 **LookupBot admin alert test**",
    "Delivery to this private channel is working. This is a manual test, not a new incident.",
  ];
  if (attention.needsAttention) {
    lines.push("", "**Current data state:**", ...formatAttentionLines(attention));
  } else {
    lines.push("", "- Current data checks are healthy.");
  }
  lines.push(privacyFooter(now));
  return lines.join("\n");
}

export function createAttentionMonitor(config, versionService, dependencies = {}) {
  const logger = dependencies.logger ?? serviceLogger;
  const client = dependencies.client;
  const now = dependencies.now ?? (() => Date.now());
  const channelId = config.discord?.adminAlertChannelId;
  const settings = config.attention ?? {};
  const intervalMs = Math.max(1, Number(settings.intervalMs) || 15 * 60 * 1000);
  const reminderMs = Math.max(1, Number(settings.reminderMs) || 24 * 60 * 60 * 1000);
  const cleanDataMaxAgeMs = Math.max(
    1,
    Number(settings.cleanDataMaxAgeMs) || 48 * 60 * 60 * 1000,
  );
  const upstreamMaxAgeMs = Math.max(
    1,
    Number(settings.upstreamMaxAgeMs) || Math.max(60 * 60 * 1000, config.versions.checkIntervalMs * 2),
  );
  let timer = null;
  let inFlight = null;
  let lastAlertFingerprint = null;
  let lastSentAt = 0;

  async function sendMessage(content) {
    if (dependencies.sendMessage) {
      await dependencies.sendMessage(content);
      return;
    }
    const channel = await client?.channels.fetch(channelId);
    if (
      channel?.guildId !== config.discord.guildId ||
      !channel?.isTextBased?.() ||
      typeof channel.send !== "function"
    ) {
      throw new Error("The configured admin alert destination is not a text channel.");
    }
    await channel.send({
      content,
      allowedMentions: { parse: [] },
    });
  }

  async function performCheck() {
    if (!channelId) {
      return { status: "disabled" };
    }

    const checkedAt = Number(now());
    const attention = evaluateAttention(versionService.getSnapshot(), {
      now: checkedAt,
      cleanDataMaxAgeMs,
      upstreamMaxAgeMs,
    });

    if (attention.needsAttention) {
      const reminderDue = checkedAt - lastSentAt >= reminderMs;
      if (attention.fingerprint === lastAlertFingerprint && !reminderDue) {
        return { status: "unchanged", attention };
      }
      await sendMessage(formatAttentionMessage(attention, { now: checkedAt }));
      lastAlertFingerprint = attention.fingerprint;
      lastSentAt = checkedAt;
      logger.info("attention.alert_sent", {
        cleanDataStale: attention.cleanDataStale,
        upstreamOverdue: attention.upstreamOverdue,
        upstreamFailureCount: attention.upstreamFailureCount,
        retainedCount: attention.retainedCount,
        updateCount: attention.updateCount,
      });
      return { status: "alerted", attention };
    }

    if (lastAlertFingerprint !== null) {
      await sendMessage(formatAttentionMessage(attention, { recovery: true, now: checkedAt }));
      lastAlertFingerprint = null;
      lastSentAt = checkedAt;
      logger.info("attention.recovery_sent", { recovered: true });
      return { status: "recovered", attention };
    }

    return { status: "healthy", attention };
  }

  async function sendTestAlert() {
    if (!channelId) {
      return { status: "disabled" };
    }

    const checkedAt = Number(now());
    const attention = evaluateAttention(versionService.getSnapshot(), {
      now: checkedAt,
      cleanDataMaxAgeMs,
      upstreamMaxAgeMs,
    });
    try {
      await sendMessage(formatAttentionTestMessage(attention, { now: checkedAt }));
      logger.info("attention.test_sent", {
        needsAttention: attention.needsAttention,
        updateCount: attention.updateCount,
      });
      return { status: "sent", attention };
    } catch (error) {
      logger.warn("attention.test_failed", { errorName: error?.name || "Error" });
      return { status: "error" };
    }
  }

  function checkNow() {
    if (inFlight) {
      return inFlight;
    }
    inFlight = performCheck()
      .catch((error) => {
        logger.warn("attention.check_failed", { errorName: error?.name || "Error" });
        return { status: "error" };
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  }

  return {
    checkNow,
    sendTestAlert,
    start() {
      if (!channelId || timer) {
        return;
      }
      void checkNow();
      timer = setInterval(() => void checkNow(), intervalMs);
      timer.unref?.();
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}
