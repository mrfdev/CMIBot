import { createBoundedLruCache } from "./lruCache.js";
import { sanitizeForDisplay } from "./security.js";
import {
  createUpstreamResilience,
  parseRetryAfter,
  UpstreamHttpError,
} from "./upstreamResilience.js";
import {
  comparePluginRelease,
  compareVersions,
  formatPluginRelease,
} from "./versionComparison.js";
import {
  MAX_UPSTREAM_RESPONSE_BYTES,
  readBoundedResponseJson,
} from "./upstreamResponse.js";
import { formatInlineVersion, normalizeInlineVersion } from "./versionSafety.js";

const SPIGET_API_ROOT = "https://api.spiget.org/v2";
const PAPER_API_ROOT = "https://fill.papermc.io/v3/projects/paper";
const LUCKPERMS_METADATA_URL = "https://metadata.luckperms.net/data/all";
const MAX_CACHE_ENTRIES = 64;
const MAX_PENDING_RESOURCES = 12;
const MAX_RELEASES_PER_RESOURCE = 3;
const MAX_ITEMS_PER_RELEASE = 4;
const MAX_ITEMS_PER_REPORT = 40;
const MAX_ITEM_LENGTH = 220;
const FETCH_CONCURRENCY = 3;
const MINIMUM_CACHE_TTL_MS = 60_000;
const MAXIMUM_CACHE_TTL_MS = 15 * 60_000;

const TRUSTED_HISTORY_HOSTS = new Set([
  "ci.extendedclip.com",
  "github.com",
  "luckperms.net",
  "papermc.io",
  "www.spigotmc.org",
  "www.zrips.net",
  "zrips.net",
]);

const GENERIC_CHANGE_LINES = new Set([
  "assets",
  "changes",
  "changelog",
  "contributors",
  "full changelog",
  "new contributors",
  "notable changes",
  "other changes",
]);

function normalizeCacheTtl(value) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    return MAXIMUM_CACHE_TTL_MS;
  }
  return Math.max(MINIMUM_CACHE_TTL_MS, Math.min(MAXIMUM_CACHE_TTL_MS, parsed));
}

function decodeHtmlEntities(value) {
  const named = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"',
  };
  return String(value).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity) => {
    const lowered = entity.toLowerCase();
    if (lowered.startsWith("#x")) {
      const codePoint = Number.parseInt(lowered.slice(2), 16);
      return Number.isSafeInteger(codePoint) && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : "";
    }
    if (lowered.startsWith("#")) {
      const codePoint = Number.parseInt(lowered.slice(1), 10);
      return Number.isSafeInteger(codePoint) && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : "";
    }
    return named[lowered] ?? "";
  });
}

function stripHtml(value) {
  return decodeHtmlEntities(
    String(value)
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
      .replace(/<\s*br\s*\/?>/gi, "\n")
      .replace(/<\s*li\b[^>]*>/gi, "\n")
      .replace(/<\s*\/\s*(li|p|div|h[1-6])\s*>/gi, "\n")
      .replace(/<[^>]*>/g, " "),
  );
}

function decodeBase64Html(value) {
  const encoded = String(value ?? "").trim();
  if (
    !encoded ||
    encoded.length > MAX_UPSTREAM_RESPONSE_BYTES ||
    !/^[a-z0-9+/=\s]+$/i.test(encoded)
  ) {
    return "";
  }
  try {
    return Buffer.from(encoded, "base64").toString("utf8");
  } catch {
    return "";
  }
}

function sanitizeChangeLine(value) {
  let line = stripHtml(value)
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/^\s*(?:[-*+]\s+|#{1,6}\s+|>\s*)/, "")
    .replace(/[*_~|]/g, "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  line = sanitizeForDisplay(line);
  if (line.length > MAX_ITEM_LENGTH) {
    line = `${line.slice(0, MAX_ITEM_LENGTH - 1).trimEnd()}…`;
  }
  return line;
}

function collectChangeLines(value) {
  const lines = String(value ?? "").replace(/\r/g, "").split("\n");
  const output = [];
  const seen = new Set();
  let inCodeFence = false;
  for (const rawLine of lines) {
    if (/^\s*```/.test(rawLine)) {
      inCodeFence = !inCodeFence;
      continue;
    }
    if (inCodeFence || /^\s{4,}\S/.test(rawLine)) {
      continue;
    }
    const line = sanitizeChangeLine(rawLine);
    const lowered = line.toLowerCase().replace(/[:.!]+$/g, "");
    if (
      line.length < 4 ||
      GENERIC_CHANGE_LINES.has(lowered) ||
      /^full changelog\b/i.test(line) ||
      /^https?:/i.test(line) ||
      seen.has(lowered)
    ) {
      continue;
    }
    seen.add(lowered);
    output.push(line);
  }
  return output;
}

function boundedItems(lines) {
  return {
    items: lines.slice(0, MAX_ITEMS_PER_RELEASE).map((text) => ({ text })),
    omittedItemCount: Math.max(0, lines.length - MAX_ITEMS_PER_RELEASE),
  };
}

function extractVersion(value) {
  return String(value ?? "").match(/\d+(?:\.\d+)+(?:[-+][a-z0-9.-]+)?/i)?.[0] ?? "";
}

function releaseIsWithinRange(version, currentVersion, latestVersion) {
  return (
    version &&
    compareVersions(version, currentVersion) > 0 &&
    compareVersions(version, latestVersion) <= 0
  );
}

function safeHistoryUrl(value) {
  try {
    const url = new URL(String(value ?? ""));
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      !TRUSTED_HISTORY_HOSTS.has(url.hostname.toLowerCase())
    ) {
      return "";
    }
    return url.toString();
  } catch {
    return "";
  }
}

function getGithubRepository(source) {
  const repository = String(source?.repository ?? "").trim();
  if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(repository)) {
    return "";
  }
  const parts = repository.split("/");
  return parts.every((part) => ![".", ".."].includes(part)) ? repository : "";
}

function getHistoryUrl(resource) {
  if (resource.kind === "paper") {
    return "https://papermc.io/downloads/paper";
  }
  if (Number.isSafeInteger(resource.catalogEntry.resourceId)) {
    return `https://www.spigotmc.org/resources/${resource.catalogEntry.resourceId}/updates`;
  }
  if (resource.catalogEntry.versionSource?.type === "luckperms-metadata") {
    return "https://luckperms.net/download";
  }
  const repository = getGithubRepository(resource.catalogEntry.releaseNotesSource);
  if (repository) {
    return `https://github.com/${repository}/releases`;
  }
  return safeHistoryUrl(
    resource.catalogEntry.resourceUrl ||
    resource.catalogEntry.website ||
    resource.catalogEntry.projectUrl,
  );
}

function makeResource(kind, catalogEntry, upstream) {
  return {
    kind,
    id: String(catalogEntry.id),
    label: String(catalogEntry.label),
    catalogEntry,
    upstream,
    current: formatPluginRelease(catalogEntry.version, catalogEntry.build),
    latest: formatPluginRelease(upstream.version, upstream.build),
    historyUrl: "",
  };
}

function collectPendingResources(snapshot, plugin, scope) {
  if (!snapshot?.catalog) {
    return { status: "catalog-unavailable", resources: [], omittedResourceCount: 0 };
  }
  if (!snapshot.checkEnabled) {
    return { status: "checks-disabled", resources: [], omittedResourceCount: 0 };
  }

  const resources = [];
  const catalog = snapshot.catalog;
  const candidatePlugins = scope === "all"
    ? catalog.plugins
    : catalog.plugins.filter(
        (entry) => entry.contextId === plugin.id || entry.shared || entry.id === "cmilib",
      );

  for (const entry of candidatePlugins) {
    const upstream = snapshot.plugins.get(entry.id);
    if (upstream?.version && comparePluginRelease(entry, upstream) < 0) {
      resources.push(makeResource("plugin", entry, upstream));
    }
  }

  const paper = snapshot.paper;
  if (paper?.version && paper?.build) {
    const sameVersion = String(catalog.paper.version) === String(paper.version);
    const comparison = sameVersion
      ? Number(catalog.paper.build) - Number(paper.build)
      : compareVersions(catalog.paper.version, paper.version);
    if (comparison < 0) {
      resources.push(makeResource("paper", catalog.paper, paper));
    }
  }

  if (scope === "all") {
    for (const entry of catalog.companions ?? []) {
      const upstream = snapshot.companions.get(entry.id);
      if (entry.version && upstream?.version && compareVersions(entry.version, upstream.version) < 0) {
        resources.push(makeResource("companion", entry, upstream));
      }
    }
  }

  for (const resource of resources) {
    resource.historyUrl = getHistoryUrl(resource);
  }
  return {
    status: "ready",
    resources: resources.slice(0, MAX_PENDING_RESOURCES),
    omittedResourceCount: Math.max(0, resources.length - MAX_PENDING_RESOURCES),
  };
}

function parseSpigetUpdates(payload, resource) {
  if (!Array.isArray(payload)) {
    throw new Error("Spiget returned an unexpected release-history response.");
  }
  const releases = [];
  const seenVersions = new Set();
  for (const update of payload) {
    const version = extractVersion(update?.title);
    if (
      !releaseIsWithinRange(version, resource.catalogEntry.version, resource.upstream.version) ||
      seenVersions.has(version)
    ) {
      continue;
    }
    seenVersions.add(version);
    const decoded = decodeBase64Html(update.description);
    const details = boundedItems(collectChangeLines(stripHtml(decoded)));
    const updateId = Number(update.id);
    releases.push({
      version,
      url: Number.isSafeInteger(updateId) && updateId > 0
        ? `https://www.spigotmc.org/resources/${resource.catalogEntry.resourceId}/update?update=${updateId}`
        : resource.historyUrl,
      ...details,
    });
  }
  return releases
    .sort((left, right) => compareVersions(right.version, left.version))
    .slice(0, MAX_RELEASES_PER_RESOURCE);
}

function parseLuckPermsChanges(payload, resource) {
  if (!Array.isArray(payload?.changeLog)) {
    throw new Error("LuckPerms returned an unexpected changelog response.");
  }
  return payload.changeLog
    .filter((entry) =>
      releaseIsWithinRange(
        String(entry?.version ?? ""),
        resource.catalogEntry.version,
        resource.upstream.version,
      ),
    )
    .slice(0, MAX_RELEASES_PER_RESOURCE)
    .map((entry) => {
      const commit = String(entry?.commit ?? "");
      const commitUrl = /^[a-f0-9]{40}$/i.test(commit)
        ? `https://github.com/LuckPerms/LuckPerms/commit/${commit}`
        : "";
      const text = sanitizeChangeLine(entry?.title);
      return {
        version: String(entry.version),
        url: commitUrl || resource.historyUrl,
        items: text ? [{ text, url: commitUrl }] : [],
        omittedItemCount: 0,
      };
    });
}

function parseGithubReleases(payload, resource, repository) {
  if (!Array.isArray(payload)) {
    throw new Error("GitHub returned an unexpected releases response.");
  }
  const releases = [];
  for (const release of payload) {
    const version = extractVersion(release?.tag_name || release?.name);
    if (!releaseIsWithinRange(version, resource.catalogEntry.version, resource.upstream.version)) {
      continue;
    }
    const tag = String(release?.tag_name ?? "");
    const releaseUrl = tag && tag.length <= 100
      ? `https://github.com/${repository}/releases/tag/${encodeURIComponent(tag)}`
      : resource.historyUrl;
    releases.push({
      version,
      url: releaseUrl,
      ...boundedItems(collectChangeLines(release?.body)),
    });
  }
  return releases
    .sort((left, right) => compareVersions(right.version, left.version))
    .slice(0, MAX_RELEASES_PER_RESOURCE);
}

function parsePaperBuilds(payload, resource) {
  if (!Array.isArray(payload)) {
    throw new Error("Paper returned an unexpected build-history response.");
  }
  const currentBuild =
    String(resource.catalogEntry.version) === String(resource.upstream.version)
      ? Number(resource.catalogEntry.build)
      : 0;
  const latestBuild = Number(resource.upstream.build);
  return payload
    .filter((build) => Number(build?.id) > currentBuild && Number(build?.id) <= latestBuild)
    .sort((left, right) => Number(right.id) - Number(left.id))
    .slice(0, MAX_RELEASES_PER_RESOURCE)
    .map((build) => {
      const commits = Array.isArray(build.commits) ? build.commits : [];
      const items = commits
        .map((commit) => {
          const sha = String(commit?.sha ?? "");
          const text = sanitizeChangeLine(commit?.message);
          return text
            ? {
                text,
                url: /^[a-f0-9]{40}$/i.test(sha)
                  ? `https://github.com/PaperMC/Paper/commit/${sha}`
                  : "",
              }
            : null;
        })
        .filter(Boolean);
      return {
        version: `${resource.upstream.version} build ${Number(build.id)}`,
        url: resource.historyUrl,
        items: items.slice(0, MAX_ITEMS_PER_RELEASE),
        omittedItemCount: Math.max(0, items.length - MAX_ITEMS_PER_RELEASE),
      };
    });
}

async function mapWithConcurrency(values, concurrency, mapper) {
  const output = new Array(values.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      output[index] = await mapper(values[index], index);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, () => worker()),
  );
  return output;
}

function boundReportItems(changes) {
  let remaining = MAX_ITEMS_PER_REPORT;
  return changes.map((change) => ({
    ...change,
    releases: change.releases.map((release) => {
      const retained = release.items.slice(0, remaining);
      const omitted = release.items.length - retained.length;
      remaining -= retained.length;
      return {
        ...release,
        items: retained,
        omittedItemCount: release.omittedItemCount + omitted,
      };
    }),
  }));
}

export function createVersionChangesService(config, dependencies = {}) {
  const fetchImplementation = dependencies.fetch ?? ((...arguments_) => globalThis.fetch(...arguments_));
  const logger = dependencies.logger;
  const now = dependencies.now ?? (() => Date.now());
  const cacheTtlMs = normalizeCacheTtl(config.versions.checkIntervalMs);
  const cache = createBoundedLruCache(MAX_CACHE_ENTRIES);
  const pending = new Map();
  let requestSequence = 0;
  const resilience = createUpstreamResilience({
    maxAttempts: config.versions.retryMaxAttempts,
    baseDelayMs: config.versions.retryBaseDelayMs,
    maxDelayMs: config.versions.retryMaxDelayMs,
    failureThreshold: config.versions.circuitFailureThreshold,
    cooldownMs: config.versions.circuitCooldownMs,
    now,
    sleep: dependencies.sleep,
    random: dependencies.random,
    logger,
    metrics: dependencies.metrics,
  });

  async function fetchJson(resourceKey, url) {
    return resilience.execute(`release-notes:${resourceKey}`, async () => {
      const response = await fetchImplementation(url, {
        headers: {
          accept: "application/json",
          "user-agent": "LookupBot/0.1 (+https://github.com/mrfdev/CMIBot)",
        },
        redirect: "error",
        signal: AbortSignal.timeout(config.versions.requestTimeoutMs),
      });
      if (!response.ok) {
        await response.body?.cancel?.().catch(() => {});
        throw new UpstreamHttpError(response.status, {
          retryAfterMs: parseRetryAfter(response.headers?.get?.("retry-after"), Number(now())),
        });
      }
      return readBoundedResponseJson(response, {
        label: "Release metadata",
        maxBytes: MAX_UPSTREAM_RESPONSE_BYTES,
      });
    });
  }

  async function loadProvider(resource) {
    if (resource.kind === "paper") {
      const payload = await fetchJson(
        "paper",
        `${PAPER_API_ROOT}/versions/${encodeURIComponent(resource.upstream.version)}/builds`,
      );
      return parsePaperBuilds(payload, resource);
    }

    if (Number.isSafeInteger(resource.catalogEntry.resourceId)) {
      requestSequence += 1;
      const url = new URL(
        `${SPIGET_API_ROOT}/resources/${resource.catalogEntry.resourceId}/updates`,
      );
      url.searchParams.set("size", "50");
      url.searchParams.set("sort", "-date");
      url.searchParams.set("cacheBust", `${Number(now())}-${requestSequence}`);
      const payload = await fetchJson(`spiget:${resource.id}`, url.toString());
      return parseSpigetUpdates(payload, resource);
    }

    if (resource.catalogEntry.versionSource?.type === "luckperms-metadata") {
      const payload = await fetchJson(
        `luckperms:${resource.id}`,
        LUCKPERMS_METADATA_URL,
      );
      return parseLuckPermsChanges(payload, resource);
    }

    const repository = getGithubRepository(resource.catalogEntry.releaseNotesSource);
    if (repository) {
      const payload = await fetchJson(
        `github:${resource.id}`,
        `https://api.github.com/repos/${repository}/releases?per_page=20`,
      );
      return parseGithubReleases(payload, resource, repository);
    }

    return null;
  }

  function cacheKey(resource) {
    return `${resource.kind}:${resource.id}:${resource.current}:${resource.latest}`;
  }

  async function resolveResource(resource) {
    const key = cacheKey(resource);
    const cached = cache.get(key);
    if (cached.hit && cached.value.expiresAt > Number(now())) {
      return cached.value.change;
    }
    if (pending.has(key)) {
      return pending.get(key);
    }

    const operation = (async () => {
      let change;
      try {
        const releases = await loadProvider(resource);
        change = {
          ...resource,
          status: releases === null ? "link-only" : releases.length ? "available" : "link-only",
          releases: releases ?? [],
          error: false,
        };
      } catch {
        logger?.warn?.("versions.release_notes_unavailable", { providerAvailable: false });
        change = {
          ...resource,
          status: "unavailable",
          releases: [],
          error: true,
        };
      }
      cache.set(key, {
        expiresAt: Number(now()) + cacheTtlMs,
        change,
      });
      return change;
    })().finally(() => {
      pending.delete(key);
    });
    pending.set(key, operation);
    return operation;
  }

  async function resolve(snapshot, plugin, scope = "context") {
    const pendingResources = collectPendingResources(snapshot, plugin, scope);
    if (pendingResources.status !== "ready") {
      return {
        status: pendingResources.status,
        scope,
        pluginLabel: plugin.label,
        changes: [],
        omittedResourceCount: 0,
        errorCount: 0,
        releaseCount: 0,
        itemCount: 0,
      };
    }

    const changes = boundReportItems(
      await mapWithConcurrency(
        pendingResources.resources,
        FETCH_CONCURRENCY,
        resolveResource,
      ),
    );
    return {
      status: "ready",
      scope,
      pluginLabel: plugin.label,
      changes,
      omittedResourceCount: pendingResources.omittedResourceCount,
      errorCount: changes.filter((change) => change.error).length,
      releaseCount: changes.reduce((count, change) => count + change.releases.length, 0),
      itemCount: changes.reduce(
        (count, change) =>
          count + change.releases.reduce((subtotal, release) => subtotal + release.items.length, 0),
        0,
      ),
    };
  }

  return {
    clearCache: () => cache.clear(),
    resolve,
  };
}

function formatReleaseLink(label, url) {
  const safeUrl = safeHistoryUrl(url);
  return safeUrl ? `[${label}](<${safeUrl}>)` : label;
}

export function formatVersionChanges(report) {
  const lines = [
    "### Version Changes",
    report.scope === "all"
      ? "Scope: `all tracked resources`"
      : `Current context: \`${sanitizeForDisplay(String(report.pluginLabel ?? "unknown"))}\``,
  ];

  if (report.status === "catalog-unavailable") {
    lines.push("", "The clean-server version catalog is not available yet.");
    return lines.join("\n");
  }
  if (report.status === "checks-disabled") {
    lines.push("", "Upstream checks are disabled, so no trusted version diff can be calculated.");
    return lines.join("\n");
  }
  if (!report.changes.length) {
    lines.push("", "No tracked version changes are pending; the clean snapshot matches the latest checked versions.");
    return lines.join("\n");
  }

  for (const change of report.changes) {
    const stale = change.upstream.stale ? " **(latest is last known)**" : "";
    lines.push(
      "",
      `**${sanitizeForDisplay(change.label)}:** ${formatInlineVersion(change.current, "Current version")} → ${formatInlineVersion(change.latest, "Latest version")}${stale}`,
    );
    if (change.releases.length) {
      for (const release of change.releases) {
        lines.push(
          `- **${formatReleaseLink(normalizeInlineVersion(release.version, "Release version"), release.url)}**`,
        );
        for (const item of release.items) {
          const safeItemUrl = safeHistoryUrl(item.url);
          const commit = safeItemUrl ? ` ([commit](<${safeItemUrl}>))` : "";
          lines.push(`  - ${sanitizeForDisplay(item.text)}${commit}`);
        }
        if (release.omittedItemCount > 0) {
          lines.push(`  - _${release.omittedItemCount} additional change(s) omitted._`);
        }
      }
    } else if (change.status === "unavailable") {
      lines.push(
        `- Release details are temporarily unavailable${change.historyUrl ? `; ${formatReleaseLink("open release history", change.historyUrl)}` : ""}.`,
      );
    } else {
      lines.push(
        `- Structured notes are unavailable for this source${change.historyUrl ? `; ${formatReleaseLink("open release history", change.historyUrl)}` : ""}.`,
      );
    }
  }

  if (report.omittedResourceCount > 0) {
    lines.push("", `_${report.omittedResourceCount} additional updated resource(s) omitted._`);
  }
  if (report.errorCount > 0) {
    lines.push("", `_Release-note retrieval failed for ${report.errorCount} resource(s); version comparisons remain available._`);
  }
  return lines.join("\n");
}
