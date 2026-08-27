import { loadEntriesForProfile } from "./profileIndex.js";
import { buildLanguageCategoryStats } from "./langStats.js";

const SHARED_CMILIB_ROOT = "CMILibPlugin/";
const SHARED_CMILIB_CACHE_PREFIX = "shared:cmilib:";

function isSafeIndexedRelativePath(value) {
  if (typeof value !== "string" || !value || /[\u0000-\u001f\u007f]/.test(value)) {
    return false;
  }

  const normalized = value.replace(/\\/g, "/");
  return (
    !normalized.startsWith("/") &&
    !/^[a-z]:\//i.test(normalized) &&
    !normalized.split("/").some((segment) => segment === "..")
  );
}

function validateLoadedEntries(entries, scopeLabel, { allowEmpty = false } = {}) {
  if (!Array.isArray(entries)) {
    throw new Error(`The ${scopeLabel} index loader returned an invalid result.`);
  }
  if (!entries.length && !allowEmpty) {
    throw new Error(`The ${scopeLabel} index is empty; refusing to replace the active cache.`);
  }

  const identities = new Set();
  for (const entry of entries) {
    if (
      !entry ||
      typeof entry !== "object" ||
      !isSafeIndexedRelativePath(entry.relativePath) ||
      !Number.isSafeInteger(entry.lineNumber) ||
      entry.lineNumber < 1 ||
      typeof entry.yamlPath !== "string" ||
      !entry.yamlPath.trim() ||
      typeof entry.searchText !== "string" ||
      !entry.searchText.trim()
    ) {
      throw new Error(`The ${scopeLabel} index contains a malformed entry.`);
    }

    const identity = `${entry.relativePath}\u0000${entry.lineNumber}\u0000${entry.yamlPath}`;
    if (identities.has(identity)) {
      throw new Error(`The ${scopeLabel} index contains a duplicate entry.`);
    }
    identities.add(identity);
  }
}

function summarizeEntries(entries, predicate = () => true) {
  const filteredEntries = entries.filter(predicate);
  return {
    entryCount: filteredEntries.length,
    fileCount: new Set(filteredEntries.map((entry) => entry.relativePath)).size,
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

function getDisplayCounts(profile) {
  if (profile.localEntryCount != null && profile.localFileCount != null) {
    return {
      entryCount: profile.localEntryCount,
      fileCount: profile.localFileCount,
    };
  }

  return {
    entryCount: profile.entryCount,
    fileCount: profile.fileCount,
  };
}

function getStoredCacheTotals(pluginSummaries, sharedSummary) {
  const pluginTotals = pluginSummaries.reduce(
    (totals, plugin) => {
      for (const profile of plugin.profileSummaries) {
        const counts = getDisplayCounts(profile);
        totals.totalEntries += counts.entryCount;
        totals.totalFiles += counts.fileCount;
      }
      return totals;
    },
    { totalEntries: 0, totalFiles: 0 },
  );

  for (const profile of sharedSummary?.profileSummaries ?? []) {
    pluginTotals.totalEntries += profile.entryCount;
    pluginTotals.totalFiles += profile.fileCount;
  }

  return pluginTotals;
}

function showComposedCounts(profileSummary) {
  const summary = { ...profileSummary };
  delete summary.localEntryCount;
  delete summary.localFileCount;
  return summary;
}

function buildSharedCmilibSummary(sharedCmilib, profileSummaries) {
  const populatedProfiles = profileSummaries.filter((profile) => profile.entryCount || profile.fileCount);

  return populatedProfiles.length
    ? {
        pluginLabel: sharedCmilib?.label ?? "Shared CMILib data",
        profileSummaries: populatedProfiles,
      }
    : null;
}

function withoutSharedCmilib(profile) {
  const include = profile.include ?? [];
  const exclude = profile.exclude ?? [];

  return {
    ...profile,
    include: include.filter((pattern) => !pattern.replace(/^!/, "").startsWith(SHARED_CMILIB_ROOT)),
    exclude: [...new Set([...exclude, `${SHARED_CMILIB_ROOT}**`])],
  };
}

function combineLanguageCategories(localCategories, sharedCategories) {
  if (!sharedCategories?.length) {
    return localCategories;
  }
  if (!localCategories?.length) {
    return sharedCategories;
  }

  return [...localCategories, ...sharedCategories];
}

export function formatCacheSummary(summary, { verb = "Loaded", suffix = "." } = {}) {
  const entryLabel = pluralize(summary.totalEntries ?? 0, "entry", "entries");
  const fileLabel = pluralize(summary.totalFiles ?? 0, "file");
  const lines = [`${verb} ${summary.totalEntries ?? 0} ${entryLabel} from ${summary.totalFiles ?? 0} ${fileLabel}${suffix}`];

  if (summary.pluginSummaries?.length) {
    for (const pluginSummary of summary.pluginSummaries) {
      lines.push(`${pluginSummary.pluginLabel}:`);
      for (const profile of pluginSummary.profileSummaries) {
        const counts = getDisplayCounts(profile);
        const profileEntryLabel = pluralize(counts.entryCount, "entry", "entries");
        const profileFileLabel = formatProfileFileLabel({
          ...profile,
          fileCount: counts.fileCount,
        });
        lines.push(
          `- ${profile.profileDisplayName ?? profile.profileName}: ${counts.entryCount} ${profileEntryLabel} from ${counts.fileCount} ${profileFileLabel}`,
        );
      }
    }

    if (summary.sharedCmilibSummary?.profileSummaries?.length) {
      lines.push(`${summary.sharedCmilibSummary.pluginLabel}:`);
      for (const profile of summary.sharedCmilibSummary.profileSummaries) {
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

export function createSearchCache(config, dependencies = {}) {
  const loadProfileEntries = dependencies.loadEntriesForProfile ?? loadEntriesForProfile;
  const loadLanguageCategories = dependencies.buildLanguageCategoryStats ?? buildLanguageCategoryStats;
  let cache = new Map();
  let pluginSummaries = new Map();
  let sharedCmilibSummary = null;
  let lastReloadedAt = null;

  function getCacheKey(pluginId, profileName) {
    return `${pluginId}:${profileName}`;
  }

  function getSharedCmilibCacheKey(profileName) {
    return `${SHARED_CMILIB_CACHE_PREFIX}${profileName}`;
  }

  function getSharedSnapshot(targetCache, profileName) {
    return profileName ? targetCache.get(getSharedCmilibCacheKey(profileName)) ?? null : null;
  }

  async function loadSharedCmilibProfile(profile, targetCache) {
    const entries = await loadProfileEntries(profile, config.workspaceRoot);
    validateLoadedEntries(entries, `shared:${profile.name}`, { allowEmpty: profile.allowEmpty === true });
    const summary = summarizeEntries(entries);
    const languageCategories =
      profile.name === "language"
        ? await loadLanguageCategories(config.workspaceRoot, profile.include, profile.exclude)
        : null;

    targetCache.set(getSharedCmilibCacheKey(profile.name), {
      pluginId: config.sharedCmilib.id,
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

  async function loadProfile(plugin, profile, targetCache) {
    const localProfile = profile.sharedProfileName ? withoutSharedCmilib(profile) : profile;
    const entries = await loadProfileEntries(localProfile, config.workspaceRoot);
    validateLoadedEntries(entries, `${plugin.id}:${profile.name}`);
    const localSummary = summarizeEntries(entries);
    const sharedSnapshot = getSharedSnapshot(targetCache, profile.sharedProfileName);
    if (profile.sharedProfileName && !sharedSnapshot) {
      throw new Error(
        `Shared CMILib profile "${profile.sharedProfileName}" is not configured for ${plugin.id}:${profile.name}.`,
      );
    }
    const sharedSummary = sharedSnapshot
      ? { entryCount: sharedSnapshot.entryCount, fileCount: sharedSnapshot.fileCount }
      : { entryCount: 0, fileCount: 0 };
    const summary = {
      entryCount: localSummary.entryCount + sharedSummary.entryCount,
      fileCount: localSummary.fileCount + sharedSummary.fileCount,
    };
    const languageCategories =
      profile.name === "language"
        ? await loadLanguageCategories(config.workspaceRoot, localProfile.include, localProfile.exclude)
        : null;

    targetCache.set(getCacheKey(plugin.id, profile.name), {
      pluginId: plugin.id,
      entries,
      loadedAt: new Date(),
      languageCategories,
      sharedProfileName: profile.sharedProfileName ?? "",
      ...localSummary,
    });

    return {
      profileName: profile.name,
      profileDisplayName: profile.displayName ?? profile.name,
      statsFileLabel: profile.statsFileLabel ?? "",
      localEntryCount: profile.sharedProfileName ? localSummary.entryCount : undefined,
      localFileCount: profile.sharedProfileName ? localSummary.fileCount : undefined,
      sharedEntryCount: sharedSummary.entryCount,
      sharedFileCount: sharedSummary.fileCount,
      ...summary,
    };
  }

  async function loadPlugin(plugin, targetCache, targetPluginSummaries) {
    const profileSummaries = [];

    for (const profile of Object.values(plugin.profiles)) {
      profileSummaries.push(await loadProfile(plugin, profile, targetCache));
    }

    const pluginSummary = buildPluginSummary(plugin, profileSummaries);

    targetPluginSummaries.set(plugin.id, pluginSummary);
    return pluginSummary;
  }

  function buildPluginSummary(plugin, profileSummaries) {
    return {
      pluginId: plugin.id,
      pluginLabel: plugin.label,
      totalEntries: profileSummaries.reduce((sum, item) => sum + item.entryCount, 0),
      totalFiles: profileSummaries.reduce((sum, item) => sum + item.fileCount, 0),
      profileSummaries,
    };
  }

  function createReloadTransaction({
    nextCache,
    nextPluginSummaries,
    nextSharedCmilibSummary,
    nextReloadedAt,
    summary,
    scope,
  }) {
    let settled = false;

    return {
      scope,
      summary,
      commit() {
        if (settled) {
          throw new Error("Search cache reload transaction has already been settled.");
        }

        cache = nextCache;
        pluginSummaries = nextPluginSummaries;
        sharedCmilibSummary = nextSharedCmilibSummary;
        lastReloadedAt = nextReloadedAt;
        settled = true;
        return summary;
      },
      discard() {
        settled = true;
      },
    };
  }

  async function prepareFullReload() {
    const nextCache = new Map();
    const nextPluginSummaries = new Map();
    const loadedPluginSummaries = [];
    const sharedProfileSummaries = [];

    if (config.sharedCmilib?.profiles) {
      for (const profile of Object.values(config.sharedCmilib.profiles)) {
        sharedProfileSummaries.push(await loadSharedCmilibProfile(profile, nextCache));
      }
    }
    const nextSharedCmilibSummary = buildSharedCmilibSummary(config.sharedCmilib, sharedProfileSummaries);

    for (const plugin of Object.values(config.plugins)) {
      loadedPluginSummaries.push(await loadPlugin(plugin, nextCache, nextPluginSummaries));
    }

    const { totalEntries, totalFiles } = getStoredCacheTotals(
      loadedPluginSummaries,
      nextSharedCmilibSummary,
    );
    const nextReloadedAt = new Date();
    const summary = {
      totalEntries,
      totalFiles,
      pluginSummaries: loadedPluginSummaries,
      sharedCmilibSummary: nextSharedCmilibSummary,
      lastReloadedAt: nextReloadedAt,
    };
    return createReloadTransaction({
      nextCache,
      nextPluginSummaries,
      nextSharedCmilibSummary,
      nextReloadedAt,
      summary,
      scope: { type: "all" },
    });
  }

  async function prepareSelectiveReload({ pluginId, profileName = "" }) {
    const plugin = config.plugins[pluginId];
    if (!plugin) {
      throw new Error("The requested plugin reload scope is not configured.");
    }
    if (profileName && !plugin.profiles[profileName]) {
      throw new Error(`The ${plugin.label} context does not provide the requested profile.`);
    }
    if (!lastReloadedAt) {
      throw new Error("The search cache must be warmed before a selective reload.");
    }

    const nextCache = new Map(cache);
    const nextPluginSummaries = new Map(pluginSummaries);
    let refreshedPluginSummary;

    if (profileName) {
      const refreshedProfileSummary = await loadProfile(
        plugin,
        plugin.profiles[profileName],
        nextCache,
      );
      const activePluginSummary = pluginSummaries.get(plugin.id);
      if (!activePluginSummary) {
        throw new Error("The active plugin cache summary is unavailable.");
      }
      const activeProfiles = new Map(
        activePluginSummary.profileSummaries.map((profile) => [profile.profileName, profile]),
      );
      activeProfiles.set(profileName, refreshedProfileSummary);
      const refreshedProfiles = Object.keys(plugin.profiles).map((name) => {
        const summary = activeProfiles.get(name);
        if (!summary) {
          throw new Error("The active plugin cache is incomplete.");
        }
        return summary;
      });
      refreshedPluginSummary = buildPluginSummary(plugin, refreshedProfiles);
      nextPluginSummaries.set(plugin.id, refreshedPluginSummary);
    } else {
      refreshedPluginSummary = await loadPlugin(plugin, nextCache, nextPluginSummaries);
    }

    const nextReloadedAt = new Date();
    const visibleProfiles = profileName
      ? refreshedPluginSummary.profileSummaries
          .filter((profile) => profile.profileName === profileName)
          .map(showComposedCounts)
      : refreshedPluginSummary.profileSummaries.map(showComposedCounts);
    const visiblePluginSummary = buildPluginSummary(plugin, visibleProfiles);
    const summary = {
      totalEntries: visiblePluginSummary.totalEntries,
      totalFiles: visiblePluginSummary.totalFiles,
      pluginSummaries: [visiblePluginSummary],
      sharedCmilibSummary: null,
      lastReloadedAt: nextReloadedAt,
    };

    return createReloadTransaction({
      nextCache,
      nextPluginSummaries,
      nextSharedCmilibSummary: sharedCmilibSummary,
      nextReloadedAt,
      summary,
      scope: {
        type: profileName ? "profile" : "plugin",
        pluginId,
        profileName,
      },
    });
  }

  async function prepareReload(scope = {}) {
    return scope.pluginId ? prepareSelectiveReload(scope) : prepareFullReload();
  }

  async function reload(scope = {}) {
    const transaction = await prepareReload(scope);
    return transaction.commit();
  }

  return {
    async warm() {
      return reload();
    },
    async reloadAll() {
      return reload();
    },
    async reload(scope) {
      return reload(scope);
    },
    prepareReload,
    getEntries(pluginId, profileName) {
      const snapshot = cache.get(getCacheKey(pluginId, profileName));
      if (!snapshot) {
        throw new Error(`Search cache is not loaded for plugin "${pluginId}" profile "${profileName}".`);
      }

      const sharedSnapshot = getSharedSnapshot(cache, snapshot.sharedProfileName);
      return sharedSnapshot?.entries.length ? [...snapshot.entries, ...sharedSnapshot.entries] : snapshot.entries;
    },
    getSnapshot(pluginId, profileName) {
      const snapshot = cache.get(getCacheKey(pluginId, profileName)) ?? null;
      if (!snapshot) {
        return null;
      }

      const sharedSnapshot = getSharedSnapshot(cache, snapshot.sharedProfileName);
      if (!sharedSnapshot) {
        return snapshot;
      }

      return {
        ...snapshot,
        entries: sharedSnapshot.entries.length ? [...snapshot.entries, ...sharedSnapshot.entries] : snapshot.entries,
        languageCategories: combineLanguageCategories(
          snapshot.languageCategories,
          sharedSnapshot.languageCategories,
        ),
        entryCount: snapshot.entryCount + sharedSnapshot.entryCount,
        fileCount: snapshot.fileCount + sharedSnapshot.fileCount,
      };
    },
    getPluginSummary(pluginId) {
      return pluginSummaries.get(pluginId) ?? null;
    },
    getGlobalSummary() {
      const loadedPluginSummaries = Object.values(config.plugins)
        .map((plugin) => pluginSummaries.get(plugin.id))
        .filter(Boolean);
      const totals = getStoredCacheTotals(loadedPluginSummaries, sharedCmilibSummary);

      return {
        ...totals,
        pluginSummaries: loadedPluginSummaries,
        sharedCmilibSummary,
        lastReloadedAt,
      };
    },
  };
}
