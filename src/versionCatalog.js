import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { serviceLogger } from "./logger.js";
import { validateVersionCatalog } from "./startupValidation.js";
import { createVersionChangesService } from "./versionChanges.js";
import {
  comparePluginRelease,
  compareVersions,
  formatPluginRelease,
} from "./versionComparison.js";
import {
  createUpstreamResilience,
  parseRetryAfter,
  UpstreamHttpError,
} from "./upstreamResilience.js";

const SPIGET_API_ROOT = "https://api.spiget.org/v2";
const PAPER_API_ROOT = "https://fill.papermc.io/v3/projects/paper";
const PERSISTED_STATE_SCHEMA_VERSION = 1;
const MAX_PERSISTED_STATE_BYTES = 1024 * 1024;
const DISPLAY_ORDER = [
  "paper",
  "cmi",
  "cmilib",
  "jobs",
  "residence",
  "trademe",
  "svis",
  "mfm",
  "tryme",
  "bottledexp",
  "luckperms",
  "placeholderapi",
  "vault",
];

function formatDiscordTimestamp(value, style = "R") {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) {
    return "unknown";
  }
  return `<t:${Math.floor(timestamp / 1000)}:${style}>`;
}

function linkedLabel(label, url) {
  return url ? `[${label}](<${url}>)` : label;
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseZripsListingVersion(content, source, label) {
  const pattern = new RegExp(
    `file=${escapeRegex(source.filePrefix)}([0-9]+(?:\\.[0-9]+)+)\\.jar`,
    "gi",
  );
  const versions = [...content.matchAll(pattern)].map((match) => match[1]);
  if (versions.length === 0) {
    throw new Error(`${label} returned no downloadable version.`);
  }
  return {
    version: versions.reduce((latest, candidate) =>
      compareVersions(candidate, latest) > 0 ? candidate : latest,
    ),
  };
}

function countRetainedUpstreams(snapshot) {
  return (
    (snapshot.paper?.stale ? 1 : 0) +
    [...snapshot.plugins.values()].filter((entry) => entry.stale).length +
    [...snapshot.companions.values()].filter((entry) => entry.stale).length
  );
}

function formatFreshnessSuffix(upstream) {
  return upstream?.stale ? "; **last known, refresh unavailable**" : "";
}

export function getVersionAttentionSummary(snapshot) {
  if (!snapshot?.catalog || !snapshot.checkEnabled) {
    return {
      updateKeys: [],
      unavailableKeys: [],
      staleKeys: [],
    };
  }

  const updateKeys = [];
  const unavailableKeys = [];
  const staleKeys = [];
  const { catalog } = snapshot;

  if (!snapshot.paper?.build) {
    unavailableKeys.push("paper");
  } else {
    if (snapshot.paper.stale) {
      staleKeys.push("paper");
    }
    const sameVersion = String(catalog.paper.version) === String(snapshot.paper.version);
    const comparison = sameVersion
      ? Number(catalog.paper.build ?? 0) - Number(snapshot.paper.build)
      : compareVersions(catalog.paper.version, snapshot.paper.version);
    if (comparison < 0) {
      updateKeys.push("paper");
    }
  }

  for (const plugin of (catalog.plugins ?? []).filter(
    (entry) => entry.resourceId || entry.versionSource,
  )) {
    const upstream = snapshot.plugins?.get(plugin.id);
    if (!upstream?.version) {
      unavailableKeys.push(`plugin:${plugin.id}`);
      continue;
    }
    if (upstream.stale) {
      staleKeys.push(`plugin:${plugin.id}`);
    }
    if (comparePluginRelease(plugin, upstream) < 0) {
      updateKeys.push(`plugin:${plugin.id}`);
    }
  }

  for (const companion of (catalog.companions ?? []).filter((entry) => entry.versionSource)) {
    const upstream = snapshot.companions?.get(companion.id);
    if (!upstream?.version) {
      unavailableKeys.push(`companion:${companion.id}`);
      continue;
    }
    if (upstream.stale) {
      staleKeys.push(`companion:${companion.id}`);
    }
    if (companion.version && compareVersions(companion.version, upstream.version) < 0) {
      updateKeys.push(`companion:${companion.id}`);
    }
  }

  return {
    updateKeys: updateKeys.sort(),
    unavailableKeys: unavailableKeys.sort(),
    staleKeys: staleKeys.sort(),
  };
}

function formatPluginVersionLine(plugin, upstream, checkEnabled) {
  const label = linkedLabel(plugin.label, plugin.resourceUrl || plugin.website);
  const prefix = `- **${label}:** clean snapshot \`${formatPluginRelease(plugin.version, plugin.build)}\``;

  if (!plugin.resourceId && !plugin.versionSource) {
    return `${prefix} (snapshot only)`;
  }
  if (!checkEnabled) {
    return `${prefix} (upstream checks disabled)`;
  }
  if (!upstream?.version) {
    return `${prefix} (upstream unavailable)`;
  }

  const comparison = comparePluginRelease(plugin, upstream);
  const status = comparison === 0 ? "current" : comparison < 0 ? "**update available**" : "snapshot newer than upstream listing";
  return `${prefix} | upstream \`${formatPluginRelease(upstream.version, upstream.build)}\` (${status}${formatFreshnessSuffix(upstream)})`;
}

function formatPaperVersionLine(paper, upstream, checkEnabled) {
  const label = linkedLabel(paper.label, paper.projectUrl);
  const localBuild = paper.build == null ? "unknown" : paper.build;
  const localChannel = paper.channel && paper.channel !== "unknown" ? ` ${paper.channel}` : "";
  const prefix = `- **${label}:** clean snapshot \`${paper.version} build ${localBuild}${localChannel}\``;

  if (!checkEnabled) {
    return `${prefix} (upstream checks disabled)`;
  }
  if (!upstream?.build) {
    return `${prefix} (upstream unavailable)`;
  }

  const localMatchesVersion = String(paper.version) === String(upstream.version);
  const comparison = localMatchesVersion ? Number(localBuild) - Number(upstream.build) : compareVersions(paper.version, upstream.version);
  const status = comparison === 0 ? "current" : comparison < 0 ? "**update available**" : "snapshot newer than upstream listing";
  return `${prefix} | upstream \`${upstream.version} build ${upstream.build} ${upstream.channel}\` (${status}${formatFreshnessSuffix(upstream)})`;
}

function formatCompanionVersionLine(companion, upstream, checkEnabled) {
  const label = linkedLabel(companion.label, companion.resourceUrl);
  const local = companion.version ? `local artifact \`${companion.version}\`` : "not stored locally";
  const prefix = `- **${label}:** ${local}`;

  if (!checkEnabled) {
    return `${prefix} (upstream checks disabled)`;
  }
  if (!upstream?.version) {
    return `${prefix} (upstream unavailable)`;
  }
  if (!companion.version) {
    return `${prefix} | upstream \`${upstream.version}\` (upstream only${formatFreshnessSuffix(upstream)})`;
  }

  const comparison = compareVersions(companion.version, upstream.version);
  const status = comparison === 0 ? "current" : comparison < 0 ? "**update available**" : "local artifact newer than upstream listing";
  return `${prefix} | upstream \`${upstream.version}\` (${status}${formatFreshnessSuffix(upstream)})`;
}

function formatPublicPluginVersionLine(plugin, upstream) {
  const label = linkedLabel(plugin.label, plugin.resourceUrl || plugin.website);
  const freshness = upstream.stale ? " **(last known; live refresh unavailable)**" : "";
  return `- **${label}:** \`${upstream.version}\`${freshness}`;
}

function orderPlugins(plugins) {
  const order = new Map(DISPLAY_ORDER.map((id, index) => [id, index]));
  return [...plugins].sort((left, right) => {
    const leftOrder = order.get(left.id) ?? Number.MAX_SAFE_INTEGER;
    const rightOrder = order.get(right.id) ?? Number.MAX_SAFE_INTEGER;
    return leftOrder - rightOrder || left.label.localeCompare(right.label);
  });
}

export function formatLatestVersions(snapshot, plugin, scope = "context") {
  if (!snapshot.catalog) {
    return "The clean-server version catalog is not available yet. Run `npm run refresh:data` first.";
  }

  const { catalog } = snapshot;
  const lines = [
    "### Latest Versions",
    scope === "all" ? "Scope: `all tracked resources`" : `Current context: \`${plugin.label}\``,
  ];

  if (scope === "all") {
    const allPlugins = orderPlugins(catalog.plugins);
    const zripsPlugins = allPlugins.filter((entry) => entry.tracked);
    const thirdPartyPlugins = allPlugins.filter((entry) => !entry.tracked);

    lines.push("", "**Zrips plugin resources:**");
    for (const entry of zripsPlugins) {
      lines.push(formatPluginVersionLine(entry, snapshot.plugins.get(entry.id), snapshot.checkEnabled));
    }

    lines.push("", "**CMI companion resources:**");
    for (const companion of catalog.companions) {
      lines.push(formatCompanionVersionLine(companion, snapshot.companions.get(companion.id), snapshot.checkEnabled));
    }

    lines.push("", "**Paper and third-party resources:**");
    lines.push(formatPaperVersionLine(catalog.paper, snapshot.paper, snapshot.checkEnabled));
    for (const entry of thirdPartyPlugins) {
      lines.push(formatPluginVersionLine(entry, snapshot.plugins.get(entry.id), snapshot.checkEnabled));
    }
  } else {
    const contextPlugins = orderPlugins(
      catalog.plugins.filter((entry) => entry.contextId === plugin.id || entry.shared || entry.id === "cmilib"),
    );
    for (const entry of contextPlugins) {
      lines.push(formatPluginVersionLine(entry, snapshot.plugins.get(entry.id), snapshot.checkEnabled));
    }
    lines.push(formatPaperVersionLine(catalog.paper, snapshot.paper, snapshot.checkEnabled));
  }

  lines.push("", `Clean data generated ${formatDiscordTimestamp(catalog.generatedAt)}.`);
  if (snapshot.checkEnabled) {
    const retainedCount = snapshot.retainedCount ?? countRetainedUpstreams(snapshot);
    lines.push(
      snapshot.checkedAt
        ? `Upstream refresh attempted ${formatDiscordTimestamp(snapshot.checkedAt)} via Spiget, Paper, project metadata/CI, Zrips, and GitHub${snapshot.errorCount ? `; ${snapshot.errorCount} check(s) failed${retainedCount ? ` and ${retainedCount} last-known result(s) were retained` : ""}` : ""}.`
        : "The first upstream version check has not completed yet.",
    );
  } else {
    lines.push("Scheduled upstream checks are disabled in bot config.");
  }
  return lines.join("\n");
}

export function formatLatestVersionMessages(snapshot, plugin, scope = "context") {
  const message = formatLatestVersions(snapshot, plugin, scope);
  if (scope !== "all") {
    return [message];
  }

  const companionHeading = "\n**CMI companion resources:**";
  const boundary = message.indexOf(companionHeading);
  if (boundary < 0) {
    return [message];
  }
  return [message.slice(0, boundary), message.slice(boundary + 1)];
}

export function formatPublicLatestVersions(snapshot, plugin) {
  if (!snapshot.catalog) {
    throw new Error("The version catalog is not available yet.");
  }
  if (!snapshot.checkEnabled) {
    throw new Error("Upstream version checks are disabled.");
  }

  const contextPlugin = snapshot.catalog.plugins.find((entry) => entry.contextId === plugin.id);
  const cmilib = snapshot.catalog.plugins.find((entry) => entry.id === "cmilib");

  if (!contextPlugin) {
    throw new Error(`No tracked upstream resource is configured for ${plugin.label}.`);
  }
  if (!cmilib) {
    throw new Error("No tracked upstream resource is configured for CMILib.");
  }

  const plugins = [contextPlugin, cmilib];
  const unavailable = plugins.filter((entry) => !snapshot.plugins.get(entry.id)?.version);
  if (unavailable.length) {
    throw new Error(
      `Latest upstream ${unavailable.length === 1 ? "version is" : "versions are"} currently unavailable for ${unavailable
        .map((entry) => entry.label)
        .join(" and ")}.`,
    );
  }

  const lines = [`### Latest ${contextPlugin.label} & CMILib Versions`];
  for (const entry of plugins) {
    lines.push(formatPublicPluginVersionLine(entry, snapshot.plugins.get(entry.id)));
  }
  const retained = plugins.filter((entry) => snapshot.plugins.get(entry.id)?.stale);
  if (retained.length) {
    lines.push(
      "",
      `A live refresh failed for ${retained.map((entry) => entry.label).join(" and ")}; the marked ${retained.length === 1 ? "version is" : "versions are"} the last successfully checked result.`,
    );
  }
  lines.push(
    "",
    `We recommend updating both plugins to these ${retained.length ? "latest known" : "current"} releases before troubleshooting version-related issues.`,
  );
  return lines.join("\n");
}

export function formatVersionServiceSummary(snapshot) {
  const pluginCount = snapshot.catalog?.plugins.length ?? 0;
  const companionCount = snapshot.catalog?.companions.length ?? 0;
  const inventory = `${pluginCount} plugins${companionCount ? ` and ${companionCount} companion resources` : ""}`;
  if (!snapshot.checkEnabled) {
    return `Loaded clean-server versions for ${inventory}; scheduled upstream checks are disabled.`;
  }
  const retainedCount = snapshot.retainedCount ?? countRetainedUpstreams(snapshot);
  const checkedCount =
    [...snapshot.plugins.values(), ...snapshot.companions.values()].filter((entry) => entry.version && !entry.stale).length +
    (snapshot.paper?.build && !snapshot.paper.stale ? 1 : 0);
  return `Loaded clean-server versions for ${inventory}; ${checkedCount} upstream version checks succeeded${snapshot.errorCount ? ` and ${snapshot.errorCount} failed` : ""}${retainedCount ? `; ${retainedCount} last-known result${retainedCount === 1 ? "" : "s"} retained` : ""}.`;
}

export function createVersionService(config, dependencies = {}) {
  const logger = dependencies.logger ?? serviceLogger;
  const metrics = dependencies.metrics;
  const now = dependencies.now ?? (() => Date.now());
  const fetchImplementation =
    dependencies.fetch ?? ((...arguments_) => globalThis.fetch(...arguments_));
  const versionChangesService = createVersionChangesService(config, {
    fetch: fetchImplementation,
    logger,
    metrics,
    now,
    sleep: dependencies.sleep,
    random: dependencies.random,
  });
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
    metrics,
  });
  let activeState = {
    catalog: null,
    paper: null,
    plugins: new Map(),
    companions: new Map(),
    checkedAt: null,
    errorCount: 0,
  };
  let timer = null;
  let inFlight = null;
  let persistenceQueue = Promise.resolve();
  let upstreamRequestSequence = 0;
  const catalogPath = path.resolve(config.workspaceRoot, config.versions.catalogPath);
  const statePath = path.resolve(
    config.workspaceRoot,
    config.versions.statePath || "logs/upstream-versions.json",
  );

  function getCacheBustedUrl(value) {
    const url = new URL(value);
    upstreamRequestSequence += 1;
    url.searchParams.set("cacheBust", `${Number(now())}-${upstreamRequestSequence}`);
    return url.toString();
  }

  function getSpigetLatestUrl(resourceId) {
    // Spiget and Zrips listings can remain cached after a plugin release.
    return getCacheBustedUrl(`${SPIGET_API_ROOT}/resources/${resourceId}/versions/latest`);
  }

  async function fetchUpstream(resourceKey, url, bodyType) {
    return resilience.execute(resourceKey, async () => {
      const response = await fetchImplementation(url, {
        headers: {
          accept: "application/json",
          "user-agent": "LookupBot/0.1 (+https://github.com/mrfdev/CMIBot)",
        },
        signal: AbortSignal.timeout(config.versions.requestTimeoutMs),
      });
      if (!response.ok) {
        throw new UpstreamHttpError(response.status, {
          retryAfterMs: parseRetryAfter(response.headers?.get?.("retry-after"), Number(now())),
        });
      }
      return bodyType === "json" ? response.json() : response.text();
    });
  }

  function fetchJson(resourceKey, url) {
    return fetchUpstream(resourceKey, url, "json");
  }

  function fetchText(resourceKey, url) {
    return fetchUpstream(resourceKey, url, "text");
  }

  function createEmptyState(catalog = null) {
    return {
      catalog,
      paper: null,
      plugins: new Map(),
      companions: new Map(),
      checkedAt: null,
      errorCount: 0,
    };
  }

  function sanitizePersistedVersion(value, { requireBuild = false } = {}) {
    if (!value || typeof value !== "object" || !value.version) {
      return null;
    }

    const record = {
      version: String(value.version),
      stale: true,
    };
    if (value.build != null) {
      const build = Number(value.build);
      if (Number.isFinite(build) && build >= 0) {
        record.build = build;
      }
    }
    if (requireBuild && record.build == null) {
      return null;
    }
    if (typeof value.channel === "string" && value.channel) {
      record.channel = value.channel;
    }
    if (typeof value.lastSuccessfulCheckAt === "string" && value.lastSuccessfulCheckAt) {
      record.lastSuccessfulCheckAt = value.lastSuccessfulCheckAt;
    }
    return record;
  }

  function serializeVersion(value) {
    if (!value?.version) {
      return null;
    }

    return {
      version: String(value.version),
      ...(value.build != null ? { build: Number(value.build) } : {}),
      ...(value.channel ? { channel: String(value.channel) } : {}),
      ...(value.lastSuccessfulCheckAt
        ? { lastSuccessfulCheckAt: String(value.lastSuccessfulCheckAt) }
        : {}),
    };
  }

  function serializePersistentState(state) {
    return {
      schemaVersion: PERSISTED_STATE_SCHEMA_VERSION,
      savedAt: new Date().toISOString(),
      paper: serializeVersion(state.paper),
      plugins: Object.fromEntries(
        [...state.plugins.entries()]
          .map(([id, value]) => [id, serializeVersion(value)])
          .filter(([, value]) => value),
      ),
      companions: Object.fromEntries(
        [...state.companions.entries()]
          .map(([id, value]) => [id, serializeVersion(value)])
          .filter(([, value]) => value),
      ),
    };
  }

  async function readPersistentState(catalog) {
    if (!config.versions.checkEnabled) {
      return createEmptyState(catalog);
    }

    try {
      const file = await fs.readFile(statePath);
      if (file.byteLength > MAX_PERSISTED_STATE_BYTES) {
        throw new Error(`state file exceeds ${MAX_PERSISTED_STATE_BYTES} bytes`);
      }
      const parsed = JSON.parse(file.toString("utf8"));
      if (parsed.schemaVersion !== PERSISTED_STATE_SCHEMA_VERSION) {
        throw new Error(`unsupported schema version ${parsed.schemaVersion ?? "unknown"}`);
      }

      const state = createEmptyState(catalog);
      const paper = sanitizePersistedVersion(parsed.paper, { requireBuild: true });
      if (paper && String(paper.version) === String(config.versions.paperVersion)) {
        state.paper = paper;
      }

      const trackedPluginIds = new Set(
        catalog.plugins
          .filter((entry) => entry.resourceId || entry.versionSource)
          .map((entry) => entry.id),
      );
      for (const id of trackedPluginIds) {
        const record = sanitizePersistedVersion(parsed.plugins?.[id]);
        if (record) {
          state.plugins.set(id, record);
        }
      }

      const trackedCompanionIds = new Set(
        catalog.companions
          .filter((entry) => entry.versionSource)
          .map((entry) => entry.id),
      );
      for (const id of trackedCompanionIds) {
        const record = sanitizePersistedVersion(parsed.companions?.[id]);
        if (record) {
          state.companions.set(id, record);
        }
      }
      return state;
    } catch (error) {
      if (error.code !== "ENOENT") {
        logger.warn("versions.persisted_state_ignored", { error });
      }
      return createEmptyState(catalog);
    }
  }

  function queuePersistentStateWrite(state) {
    if (!config.versions.checkEnabled) {
      return persistenceQueue;
    }

    const content = `${JSON.stringify(serializePersistentState(state), null, 2)}\n`;
    persistenceQueue = persistenceQueue
      .catch(() => {})
      .then(async () => {
        const temporaryPath = `${statePath}.${process.pid}.tmp`;
        await fs.mkdir(path.dirname(statePath), { recursive: true });
        try {
          await fs.writeFile(temporaryPath, content, { encoding: "utf8", mode: 0o600 });
          await fs.rename(temporaryPath, statePath);
        } finally {
          await fs.rm(temporaryPath, { force: true }).catch(() => {});
        }
      })
      .catch((error) => {
        logger.warn("versions.persist_failed", { error });
      });
    return persistenceQueue;
  }

  function getSnapshot(state = activeState) {
    return {
      catalog: state.catalog,
      paper: state.paper,
      plugins: new Map(state.plugins),
      companions: new Map(state.companions),
      checkedAt: state.checkedAt,
      errorCount: state.errorCount,
      retainedCount: countRetainedUpstreams(state),
      checkEnabled: config.versions.checkEnabled,
    };
  }

  async function readLocalCatalog() {
    const parsed = JSON.parse(await fs.readFile(catalogPath, "utf8"));
    const catalog = {
      ...parsed,
      companions: parsed.companions ?? [],
    };
    return validateVersionCatalog(catalog, config, {
      requireGeneratedAt: false,
      requireConfiguredContexts: Boolean(config.plugins),
    });
  }

  async function checkPaper() {
    const builds = await fetchJson(
      "paper",
      `${PAPER_API_ROOT}/versions/${encodeURIComponent(config.versions.paperVersion)}/builds`,
    );
    if (!Array.isArray(builds)) {
      throw new Error("Paper returned an unexpected builds response.");
    }
    const allowedChannels = new Set(config.versions.paperChannels);
    const latest = builds
      .filter((build) => allowedChannels.has(String(build.channel).toUpperCase()))
      .sort((left, right) => Number(right.id) - Number(left.id))[0];
    if (!latest) {
      throw new Error(`No Paper builds matched channels ${config.versions.paperChannels.join(", ")}.`);
    }
    return {
      version: config.versions.paperVersion,
      build: Number(latest.id),
      channel: String(latest.channel).toUpperCase(),
    };
  }

  async function checkPlugin(plugin) {
    const source = plugin.versionSource;
    const resourceKey = `plugin:${plugin.id}`;
    if (source?.type === "zrips-listing") {
      const content = await fetchText(resourceKey, getCacheBustedUrl(source.url));
      return parseZripsListingVersion(content, source, plugin.label);
    }

    if (plugin.resourceId) {
      const latest = await fetchJson(
        resourceKey,
        getSpigetLatestUrl(plugin.resourceId),
      );
      if (!latest?.name) {
        throw new Error(`${plugin.label} returned no latest version name.`);
      }
      return { version: String(latest.name) };
    }

    if (source?.type === "luckperms-metadata") {
      const metadata = await fetchJson(resourceKey, source.url);
      if (!metadata?.version) {
        throw new Error(`${plugin.label} returned no latest version.`);
      }
      return { version: String(metadata.version) };
    }

    if (source?.type === "jenkins-artifact") {
      const build = await fetchJson(resourceKey, source.url);
      const artifactPattern = new RegExp(source.artifactPattern, "i");
      const artifact = build?.artifacts?.find((entry) => artifactPattern.test(String(entry.fileName)));
      const match = artifact?.fileName?.match(artifactPattern);
      if (!Number.isFinite(Number(build?.number)) || !match?.[1]) {
        throw new Error(`${plugin.label} returned no successful plugin artifact.`);
      }
      return {
        version: match[1],
        build: Number(build.number),
      };
    }

    throw new Error(`${plugin.label} has no supported upstream version source.`);
  }

  async function checkCompanion(companion) {
    const source = companion.versionSource;
    const resourceKey = `companion:${companion.id}`;

    if (source.type === "github-pom") {
      const content = await fetchText(resourceKey, source.url);
      const pattern = new RegExp(
        `<artifactId>\\s*${escapeRegex(source.artifactId)}\\s*</artifactId>\\s*<version>\\s*([^<]+?)\\s*</version>`,
        "i",
      );
      const match = content.match(pattern);
      if (!match) {
        throw new Error(`${companion.label} returned no project version.`);
      }
      return { version: match[1].trim() };
    }

    if (source.type === "zrips-listing") {
      const content = await fetchText(resourceKey, getCacheBustedUrl(source.url));
      return parseZripsListingVersion(content, source, companion.label);
    }

    throw new Error(`${companion.label} has unsupported version source ${source.type}.`);
  }

  async function buildState(catalog, previousState = activeState) {
    const nextState = {
      catalog,
      paper: null,
      plugins: new Map(),
      companions: new Map(),
      checkedAt: null,
      errorCount: 0,
    };

    if (!config.versions.checkEnabled) {
      return nextState;
    }

    const startedAt = performance.now();
    const trackedPlugins = catalog.plugins.filter((entry) => entry.resourceId || entry.versionSource);
    const trackedCompanions = catalog.companions.filter((entry) => entry.versionSource);
    const results = await Promise.allSettled([
      checkPaper(),
      ...trackedPlugins.map((entry) => checkPlugin(entry)),
      ...trackedCompanions.map((entry) => checkCompanion(entry)),
    ]);
    const checkedAt = new Date().toISOString();
    const paperResult = results[0];
    if (paperResult.status === "fulfilled") {
      nextState.paper = {
        ...paperResult.value,
        stale: false,
        lastSuccessfulCheckAt: checkedAt,
      };
    } else {
      nextState.errorCount += 1;
      if (
        previousState.paper?.build &&
        String(previousState.paper.version) === String(config.versions.paperVersion)
      ) {
        nextState.paper = {
          ...previousState.paper,
          stale: true,
        };
      }
    }

    for (let index = 0; index < trackedPlugins.length; index += 1) {
      const result = results[index + 1];
      const plugin = trackedPlugins[index];
      if (result.status === "fulfilled") {
        nextState.plugins.set(plugin.id, {
          ...result.value,
          stale: false,
          lastSuccessfulCheckAt: checkedAt,
        });
      } else {
        nextState.errorCount += 1;
        const previous = previousState.plugins.get(plugin.id);
        if (previous?.version) {
          nextState.plugins.set(plugin.id, {
            ...previous,
            stale: true,
          });
        }
      }
    }

    const companionOffset = 1 + trackedPlugins.length;
    for (let index = 0; index < trackedCompanions.length; index += 1) {
      const result = results[companionOffset + index];
      const companion = trackedCompanions[index];
      if (result.status === "fulfilled") {
        nextState.companions.set(companion.id, {
          ...result.value,
          stale: false,
          lastSuccessfulCheckAt: checkedAt,
        });
      } else {
        nextState.errorCount += 1;
        const previous = previousState.companions.get(companion.id);
        if (previous?.version) {
          nextState.companions.set(companion.id, {
            ...previous,
            stale: true,
          });
        }
      }
    }

    nextState.checkedAt = checkedAt;
    metrics?.recordUpstream({
      durationMs: performance.now() - startedAt,
      outcome: nextState.errorCount ? "error" : "success",
      resourceCount: results.length,
      errorCount: nextState.errorCount,
      retainedCount: countRetainedUpstreams(nextState),
    });
    return nextState;
  }

  function createReloadTransaction(nextState) {
    let settled = false;

    return {
      snapshot: getSnapshot(nextState),
      commit() {
        if (settled) {
          throw new Error("Version catalog reload transaction has already been settled.");
        }

        activeState = nextState;
        versionChangesService.clearCache();
        settled = true;
        void queuePersistentStateWrite(nextState);
        return getSnapshot();
      },
      discard() {
        settled = true;
      },
    };
  }

  async function prepareReload() {
    const catalog = await readLocalCatalog();
    const previousState = activeState.catalog ? activeState : await readPersistentState(catalog);
    return createReloadTransaction(await buildState(catalog, previousState));
  }

  async function refreshUpstream() {
    if (!config.versions.checkEnabled) {
      return getSnapshot();
    }
    if (inFlight) {
      return inFlight;
    }

    inFlight = (async () => {
      const catalog = activeState.catalog ?? (await readLocalCatalog());
      const previousState = activeState.catalog ? activeState : await readPersistentState(catalog);
      const nextState = await buildState(catalog, previousState);
      activeState = nextState;
      await queuePersistentStateWrite(nextState);
      return getSnapshot();
    })().finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  async function start() {
    const transaction = await prepareReload();
    const snapshot = transaction.commit();
    if (config.versions.checkEnabled) {
      timer = setInterval(() => {
        void refreshUpstream()
          .then((refreshedSnapshot) => {
            logger.info("versions.scheduled_refresh_completed", {
              checkedAt: refreshedSnapshot.checkedAt,
              errorCount: refreshedSnapshot.errorCount,
              retainedCount: refreshedSnapshot.retainedCount,
            });
          })
          .catch((error) => {
            logger.error("versions.scheduled_refresh_failed", { error });
          });
      }, config.versions.checkIntervalMs);
      timer.unref();
    }
    return snapshot;
  }

  return {
    start,
    async reload() {
      const transaction = await prepareReload();
      return transaction.commit();
    },
    prepareReload,
    refreshUpstream,
    getSnapshot,
    getVersionChanges(plugin, scope = "context") {
      return versionChangesService.resolve(getSnapshot(), plugin, scope);
    },
    flushPersistence() {
      return persistenceQueue;
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}
