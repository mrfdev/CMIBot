import fs from "node:fs/promises";
import path from "node:path";

const SPIGET_API_ROOT = "https://api.spiget.org/v2";
const PAPER_API_ROOT = "https://fill.papermc.io/v3/projects/paper";
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

async function fetchJson(url, timeoutMs) {
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
  return response.json();
}

function formatPluginVersionLine(plugin, upstream, checkEnabled) {
  const label = linkedLabel(plugin.label, plugin.resourceUrl || plugin.website);
  const prefix = `- **${label}:** clean snapshot \`${plugin.version}\``;

  if (!plugin.resourceId) {
    return `${prefix} (snapshot only)`;
  }
  if (!checkEnabled) {
    return `${prefix} (upstream checks disabled)`;
  }
  if (!upstream?.version) {
    return `${prefix} (upstream unavailable)`;
  }

  const comparison = compareVersions(plugin.version, upstream.version);
  const status = comparison === 0 ? "current" : comparison < 0 ? "update available" : "snapshot newer than upstream listing";
  return `${prefix} | upstream \`${upstream.version}\` (${status})`;
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
  const status = comparison === 0 ? "current" : comparison < 0 ? "update available" : "snapshot newer than upstream listing";
  return `${prefix} | upstream \`${upstream.version} build ${upstream.build} ${upstream.channel}\` (${status})`;
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
  const plugins =
    scope === "all"
      ? orderPlugins(catalog.plugins)
      : orderPlugins(
          catalog.plugins.filter((entry) => entry.contextId === plugin.id || entry.shared || entry.id === "cmilib"),
        );
  const lines = [
    "### Latest Versions",
    scope === "all" ? "Scope: `all clean-server resources`" : `Current context: \`${plugin.label}\``,
  ];

  if (scope === "all") {
    lines.push(formatPaperVersionLine(catalog.paper, snapshot.paper, snapshot.checkEnabled));
  }
  for (const entry of plugins) {
    lines.push(formatPluginVersionLine(entry, snapshot.plugins.get(entry.id), snapshot.checkEnabled));
  }
  if (scope !== "all") {
    lines.push(formatPaperVersionLine(catalog.paper, snapshot.paper, snapshot.checkEnabled));
  }

  lines.push("", `Clean data generated ${formatDiscordTimestamp(catalog.generatedAt)}.`);
  if (snapshot.checkEnabled) {
    lines.push(
      snapshot.checkedAt
        ? `Upstream checked ${formatDiscordTimestamp(snapshot.checkedAt)} via Spiget and Paper's API${snapshot.errorCount ? `; ${snapshot.errorCount} check(s) unavailable` : ""}.`
        : "The first upstream version check has not completed yet.",
    );
  } else {
    lines.push("Scheduled upstream checks are disabled in bot config.");
  }
  return lines.join("\n");
}

export function formatVersionServiceSummary(snapshot) {
  const pluginCount = snapshot.catalog?.plugins.length ?? 0;
  if (!snapshot.checkEnabled) {
    return `Loaded clean-server versions for ${pluginCount} plugins; scheduled upstream checks are disabled.`;
  }
  const checkedCount = [...snapshot.plugins.values()].filter((entry) => entry.version).length + (snapshot.paper?.build ? 1 : 0);
  return `Loaded clean-server versions for ${pluginCount} plugins; ${checkedCount} upstream version checks succeeded${snapshot.errorCount ? ` and ${snapshot.errorCount} failed` : ""}.`;
}

export function createVersionService(config) {
  let catalog = null;
  let paper = null;
  let checkedAt = null;
  let errorCount = 0;
  let timer = null;
  let inFlight = null;
  const plugins = new Map();
  const catalogPath = path.resolve(config.workspaceRoot, config.versions.catalogPath);

  function getSnapshot() {
    return {
      catalog,
      paper,
      plugins: new Map(plugins),
      checkedAt,
      errorCount,
      checkEnabled: config.versions.checkEnabled,
    };
  }

  async function loadLocal() {
    const parsed = JSON.parse(await fs.readFile(catalogPath, "utf8"));
    if (parsed.schemaVersion !== 1 || !parsed.paper || !Array.isArray(parsed.plugins)) {
      throw new Error(`Unsupported version catalog format in ${catalogPath}`);
    }
    catalog = parsed;
    return getSnapshot();
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
    const latest = await fetchJson(
      `${SPIGET_API_ROOT}/resources/${plugin.resourceId}/versions/latest`,
      config.versions.requestTimeoutMs,
    );
    if (!latest?.name) {
      throw new Error(`${plugin.label} returned no latest version name.`);
    }
    return { version: String(latest.name) };
  }

  async function refreshUpstream() {
    if (!config.versions.checkEnabled) {
      return getSnapshot();
    }
    if (!catalog) {
      await loadLocal();
    }
    if (inFlight) {
      return inFlight;
    }

    inFlight = (async () => {
      let failures = 0;
      const trackedPlugins = catalog.plugins.filter((entry) => entry.resourceId);
      const results = await Promise.allSettled([checkPaper(), ...trackedPlugins.map((entry) => checkPlugin(entry))]);
      const paperResult = results[0];
      if (paperResult.status === "fulfilled") {
        paper = paperResult.value;
      } else {
        paper = null;
        failures += 1;
      }

      for (let index = 0; index < trackedPlugins.length; index += 1) {
        const result = results[index + 1];
        const plugin = trackedPlugins[index];
        if (result.status === "fulfilled") {
          plugins.set(plugin.id, result.value);
        } else {
          plugins.delete(plugin.id);
          failures += 1;
        }
      }

      checkedAt = new Date().toISOString();
      errorCount = failures;
      return getSnapshot();
    })().finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  async function start() {
    await loadLocal();
    if (config.versions.checkEnabled) {
      await refreshUpstream();
      timer = setInterval(() => {
        void refreshUpstream()
          .then((snapshot) => {
            console.log(`[LookupBot] ${formatVersionServiceSummary(snapshot)}`);
          })
          .catch((error) => {
            console.error(`[LookupBot] Scheduled version check failed: ${error.message}`);
          });
      }, config.versions.checkIntervalMs);
      timer.unref();
    }
    return getSnapshot();
  }

  return {
    start,
    async reload() {
      await loadLocal();
      return refreshUpstream();
    },
    refreshUpstream,
    getSnapshot,
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}
