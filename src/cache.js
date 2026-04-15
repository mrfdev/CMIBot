import { loadEntriesForProfile } from "./profileIndex.js";
import { buildLanguageCategoryStats } from "./langStats.js";

function summarizeEntries(entries) {
  return {
    entryCount: entries.length,
    fileCount: new Set(entries.map((entry) => entry.relativePath)).size,
  };
}

function pluralize(count, singular, plural = `${singular}s`) {
  return count === 1 ? singular : plural;
}

function formatProfileFileLabel(profile) {
  if (profile.statsFileLabel) {
    return profile.fileCount === 1 ? profile.statsFileLabel.replace(/s$/, "") : profile.statsFileLabel;
  }

  return pluralize(profile.fileCount, "file");
}

export function formatCacheSummary(summary, { verb = "Loaded", suffix = "." } = {}) {
  const entryLabel = pluralize(summary.totalEntries ?? 0, "entry", "entries");
  const fileLabel = pluralize(summary.totalFiles ?? 0, "file");
  const lines = [`${verb} ${summary.totalEntries ?? 0} ${entryLabel} from ${summary.totalFiles ?? 0} ${fileLabel}${suffix}`];

  if (summary.pluginSummaries?.length) {
    for (const pluginSummary of summary.pluginSummaries) {
      lines.push(`${pluginSummary.pluginLabel}:`);
      for (const profile of pluginSummary.profileSummaries) {
        const profileEntryLabel = pluralize(profile.entryCount, "entry", "entries");
        const profileFileLabel = formatProfileFileLabel(profile);
        lines.push(
          `- ${profile.profileDisplayName ?? profile.profileName}: ${profile.entryCount} ${profileEntryLabel} from ${profile.fileCount} ${profileFileLabel}`,
        );
      }
    }

    return lines.join("\n");
  }

  const profileLines = (summary.profileSummaries ?? []).map((profile) => {
    const profileEntryLabel = pluralize(profile.entryCount, "entry", "entries");
    const profileFileLabel = formatProfileFileLabel(profile);
    return `- ${profile.profileDisplayName ?? profile.profileName}: ${profile.entryCount} ${profileEntryLabel} from ${profile.fileCount} ${profileFileLabel}`;
  });

  return [...lines, ...profileLines].join("\n");
}

export function createSearchCache(config) {
  const cache = new Map();
  const pluginSummaries = new Map();

  function getCacheKey(pluginId, profileName) {
    return `${pluginId}:${profileName}`;
  }

  async function loadProfile(plugin, profile) {
    const entries = await loadEntriesForProfile(profile, config.workspaceRoot);
    const summary = summarizeEntries(entries);
    const languageCategories =
      profile.name === "language" ? await buildLanguageCategoryStats(config.workspaceRoot, profile.include) : null;

    cache.set(getCacheKey(plugin.id, profile.name), {
      pluginId: plugin.id,
      entries,
      loadedAt: new Date(),
      languageCategories,
      ...summary,
    });

    return {
      profileName: profile.name,
      profileDisplayName: profile.displayName ?? profile.name,
      statsFileLabel: profile.statsFileLabel ?? "",
      ...summary,
    };
  }

  async function loadPlugin(plugin) {
    const profileSummaries = [];

    for (const profile of Object.values(plugin.profiles)) {
      profileSummaries.push(await loadProfile(plugin, profile));
    }

    const totalEntries = profileSummaries.reduce((sum, item) => sum + item.entryCount, 0);
    const totalFiles = profileSummaries.reduce((sum, item) => sum + item.fileCount, 0);
    const pluginSummary = {
      pluginId: plugin.id,
      pluginLabel: plugin.label,
      totalEntries,
      totalFiles,
      profileSummaries,
    };

    pluginSummaries.set(plugin.id, pluginSummary);
    return pluginSummary;
  }

  async function reloadAll() {
    const loadedPluginSummaries = [];

    for (const plugin of Object.values(config.plugins)) {
      loadedPluginSummaries.push(await loadPlugin(plugin));
    }

    const totalEntries = loadedPluginSummaries.reduce((sum, item) => sum + item.totalEntries, 0);
    const totalFiles = loadedPluginSummaries.reduce((sum, item) => sum + item.totalFiles, 0);

    return {
      totalEntries,
      totalFiles,
      pluginSummaries: loadedPluginSummaries,
    };
  }

  return {
    async warm() {
      return reloadAll();
    },
    async reloadAll() {
      return reloadAll();
    },
    getEntries(pluginId, profileName) {
      const snapshot = cache.get(getCacheKey(pluginId, profileName));
      if (!snapshot) {
        throw new Error(`Search cache is not loaded for plugin "${pluginId}" profile "${profileName}".`);
      }

      return snapshot.entries;
    },
    getSnapshot(pluginId, profileName) {
      return cache.get(getCacheKey(pluginId, profileName)) ?? null;
    },
    getPluginSummary(pluginId) {
      return pluginSummaries.get(pluginId) ?? null;
    },
    getGlobalSummary() {
      const loadedPluginSummaries = Object.values(config.plugins)
        .map((plugin) => pluginSummaries.get(plugin.id))
        .filter(Boolean);

      return {
        totalEntries: loadedPluginSummaries.reduce((sum, item) => sum + item.totalEntries, 0),
        totalFiles: loadedPluginSummaries.reduce((sum, item) => sum + item.totalFiles, 0),
        pluginSummaries: loadedPluginSummaries,
      };
    },
  };
}
