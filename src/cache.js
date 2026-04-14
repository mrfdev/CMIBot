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

export function formatCacheSummary(summary, { verb = "Loaded", suffix = "." } = {}) {
  const entryLabel = pluralize(summary.totalEntries, "entry", "entries");
  const fileLabel = pluralize(summary.totalFiles, "file");
  const profileLines = summary.profileSummaries.map((profile) => {
    const profileEntryLabel = pluralize(profile.entryCount, "entry", "entries");
    const profileFileLabel = pluralize(profile.fileCount, "file");
    return `- ${profile.profileName}: ${profile.entryCount} ${profileEntryLabel} from ${profile.fileCount} ${profileFileLabel}`;
  });

  return [
    `${verb} ${summary.totalEntries} ${entryLabel} from ${summary.totalFiles} ${fileLabel}${suffix}`,
    ...profileLines,
  ].join("\n");
}

export function createSearchCache(config) {
  const cache = new Map();

  async function loadProfile(profile) {
    const entries = await loadEntriesForProfile(profile, config.workspaceRoot);
    const summary = summarizeEntries(entries);
    const languageCategories =
      profile.name === "langlookup" ? await buildLanguageCategoryStats(config.workspaceRoot, profile.include) : null;

    cache.set(profile.name, {
      entries,
      loadedAt: new Date(),
      languageCategories,
      ...summary,
    });

    return {
      profileName: profile.name,
      ...summary,
    };
  }

  async function reloadAll() {
    const profiles = Object.values(config.search.profiles);
    const profileSummaries = [];

    for (const profile of profiles) {
      profileSummaries.push(await loadProfile(profile));
    }

    const totalEntries = profileSummaries.reduce((sum, item) => sum + item.entryCount, 0);
    const totalFiles = profileSummaries.reduce((sum, item) => sum + item.fileCount, 0);

    return {
      totalEntries,
      totalFiles,
      profileSummaries,
    };
  }

  return {
    async warm() {
      return reloadAll();
    },
    async reloadAll() {
      return reloadAll();
    },
    getEntries(profileName) {
      const snapshot = cache.get(profileName);
      if (!snapshot) {
        throw new Error(`Search cache is not loaded for profile "${profileName}".`);
      }

      return snapshot.entries;
    },
    getSnapshot(profileName) {
      return cache.get(profileName) ?? null;
    },
  };
}
