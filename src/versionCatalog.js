import fs from "node:fs/promises";
import path from "node:path";

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

function compareVersions(left, right) {
  const toParts = (value) =>
    String(value)
      .split(/[.-]/)
      .map((part) => (/^\d+$/.test(part) ? Number(part) : part.toLowerCase()));
  const leftParts = toParts(left);
  const rightParts = toParts(right);
  const length = Math.max(leftParts.length, rightParts.length);

  for (let index = 0; index < length; index += 1) {
    const leftPart = leftParts[index] ?? 0;
    const rightPart = rightParts[index] ?? 0;
    if (leftPart === rightPart) {
      continue;
    }
    if (typeof leftPart === "number" && typeof rightPart === "number") {
      return leftPart > rightPart ? 1 : -1;
    }
    return String(leftPart).localeCompare(String(rightPart));
  }
  return 0;
}

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

async function fetchResponse(url, timeoutMs) {
  const response = await fetch(url, {
    headers: {
      accept: "application/json",
      "user-agent": "LookupBot/0.1 (+https://github.com/mrfdev/CMIBot)",
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  return response;
}

async function fetchJson(url, timeoutMs) {
  return (await fetchResponse(url, timeoutMs)).json();
}

async function fetchText(url, timeoutMs) {
  return (await fetchResponse(url, timeoutMs)).text();
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function formatPluginRelease(version, build) {
  return build == null ? String(version) : `${version} build ${build}`;
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

function comparePluginRelease(plugin, upstream) {
  const versionComparison = compareVersions(plugin.version, upstream.version);
  if (versionComparison !== 0) {
    return versionComparison;
  }
  if (plugin.build == null || upstream.build == null) {
    return 0;
  }
  return Number(plugin.build) - Number(upstream.build);
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

export function createVersionService(config) {
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
  let spigetRequestSequence = 0;
  const catalogPath = path.resolve(config.workspaceRoot, config.versions.catalogPath);
  const statePath = path.resolve(
    config.workspaceRoot,
    config.versions.statePath || "logs/upstream-versions.json",
  );

  function getSpigetLatestUrl(resourceId) {
    const url = new URL(`${SPIGET_API_ROOT}/resources/${resourceId}/versions/latest`);
    // Spiget's CDN can retain versions/latest responses well beyond its advertised TTL.
    spigetRequestSequence += 1;
    url.searchParams.set("cacheBust", `${Date.now()}-${spigetRequestSequence}`);
    return url.toString();
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
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[LookupBot] Ignoring invalid persisted upstream version state: ${message}`);
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
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[LookupBot] Failed to persist upstream version state: ${message}`);
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
    if (parsed.schemaVersion !== 1 || !parsed.paper || !Array.isArray(parsed.plugins)) {
      throw new Error(`Unsupported version catalog format in ${catalogPath}`);
    }
    return {
      ...parsed,
      companions: Array.isArray(parsed.companions) ? parsed.companions : [],
    };
  }

  async function checkPaper() {
    const builds = await fetchJson(
      `${PAPER_API_ROOT}/versions/${encodeURIComponent(config.versions.paperVersion)}/builds`,
      config.versions.requestTimeoutMs,
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
    if (plugin.resourceId) {
      const latest = await fetchJson(
        getSpigetLatestUrl(plugin.resourceId),
        config.versions.requestTimeoutMs,
      );
      if (!latest?.name) {
        throw new Error(`${plugin.label} returned no latest version name.`);
      }
      return { version: String(latest.name) };
    }

    const source = plugin.versionSource;
    if (source?.type === "luckperms-metadata") {
      const metadata = await fetchJson(source.url, config.versions.requestTimeoutMs);
      if (!metadata?.version) {
        throw new Error(`${plugin.label} returned no latest version.`);
      }
      return { version: String(metadata.version) };
    }

    if (source?.type === "jenkins-artifact") {
      const build = await fetchJson(source.url, config.versions.requestTimeoutMs);
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
    const content = await fetchText(source.url, config.versions.requestTimeoutMs);

    if (source.type === "github-pom") {
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
      const pattern = new RegExp(
        `file=${escapeRegex(source.filePrefix)}([0-9]+(?:\\.[0-9]+)+)\\.jar`,
        "i",
      );
      const match = content.match(pattern);
      if (!match) {
        throw new Error(`${companion.label} returned no downloadable version.`);
      }
      return { version: match[1] };
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
            console.log(`[LookupBot] ${formatVersionServiceSummary(refreshedSnapshot)}`);
          })
          .catch((error) => {
            console.error(`[LookupBot] Scheduled version check failed: ${error.message}`);
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
