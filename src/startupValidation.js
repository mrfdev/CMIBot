const PLUGIN_VERSION_SOURCE_TYPES = new Map([
  ["jenkins-artifact", ["url", "artifactPattern"]],
  ["luckperms-metadata", ["url"]],
  ["zrips-listing", ["url", "filePrefix"]],
]);
const COMPANION_VERSION_SOURCE_TYPES = new Map([
  ["github-pom", ["url", "artifactId"]],
  ["zrips-listing", ["url", "filePrefix"]],
]);

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
}

function requireNonEmptyString(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string.`);
  }
}

function requirePositiveCount(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer.`);
  }
}

function requireNonNegativeCount(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer.`);
  }
}

function requireValidTimestamp(value, label) {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) {
    throw new Error(`${label} must be a valid timestamp.`);
  }
}

function requireHttpsUrl(value, label) {
  requireNonEmptyString(value, label);
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid HTTPS URL.`);
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    throw new Error(`${label} must be a credential-free HTTPS URL.`);
  }
}

function validateVersionSource(source, label, supportedTypes) {
  requireObject(source, label);
  const requiredFields = supportedTypes.get(source.type);
  if (!requiredFields) {
    throw new Error(`${label} has an unsupported type.`);
  }
  for (const field of requiredFields) {
    if (field === "url") {
      requireHttpsUrl(source[field], `${label} URL`);
    } else {
      requireNonEmptyString(source[field], `${label} ${field}`);
    }
  }
}

function validateReleaseNotesSource(source, label) {
  requireObject(source, label);
  if (source.type !== "github-releases") {
    throw new Error(`${label} has an unsupported type.`);
  }
  requireNonEmptyString(source.repository, `${label} repository`);
  const parts = source.repository.split("/");
  if (
    !/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(source.repository) ||
    parts.some((part) => [".", ".."].includes(part))
  ) {
    throw new Error(`${label} repository must be a fixed GitHub owner and repository name.`);
  }
}

function validateCatalogResource(resource, label, supportedSourceTypes) {
  requireObject(resource, label);
  requireNonEmptyString(resource.id, `${label} id`);
  requireNonEmptyString(resource.label, `${label} label`);
  requireNonEmptyString(resource.version, `${label} version`);
  if (resource.resourceId != null && (!Number.isSafeInteger(resource.resourceId) || resource.resourceId < 1)) {
    throw new Error(`${label} resource id must be a positive integer.`);
  }
  if (resource.versionSource) {
    validateVersionSource(resource.versionSource, `${label} version source`, supportedSourceTypes);
  }
  if (resource.releaseNotesSource) {
    validateReleaseNotesSource(resource.releaseNotesSource, `${label} release notes source`);
  }
}

export function validateVersionCatalog(
  catalog,
  config = {},
  { requireGeneratedAt = false, requireConfiguredContexts = Boolean(config.plugins) } = {},
) {
  requireObject(catalog, "Version catalog");
  if (catalog.schemaVersion !== 1 || !Array.isArray(catalog.plugins) || !Array.isArray(catalog.companions)) {
    throw new Error("The version catalog has an unsupported schema.");
  }
  if (requireGeneratedAt) {
    requireValidTimestamp(catalog.generatedAt, "Version catalog generatedAt");
  }

  requireObject(catalog.paper, "Version catalog Paper entry");
  if (catalog.paper.id !== "paper") {
    throw new Error("The version catalog Paper entry has an invalid id.");
  }
  requireNonEmptyString(catalog.paper.label, "Version catalog Paper label");
  requireNonEmptyString(catalog.paper.version, "Version catalog Paper version");
  requirePositiveCount(catalog.paper.build, "Version catalog Paper build");
  if (
    config.versions?.paperVersion &&
    String(catalog.paper.version) !== String(config.versions.paperVersion)
  ) {
    throw new Error("The version catalog Paper version does not match the configured runtime version.");
  }

  const resourceIds = new Set([catalog.paper.id]);
  const contextIds = new Set();
  for (const plugin of catalog.plugins) {
    validateCatalogResource(plugin, "Version catalog plugin", PLUGIN_VERSION_SOURCE_TYPES);
    if (resourceIds.has(plugin.id)) {
      throw new Error("The version catalog contains a duplicate resource id.");
    }
    resourceIds.add(plugin.id);
    if (plugin.contextId != null) {
      requireNonEmptyString(plugin.contextId, `Version catalog context for ${plugin.id}`);
      if (contextIds.has(plugin.contextId)) {
        throw new Error("The version catalog contains a duplicate plugin context.");
      }
      if (requireConfiguredContexts && !config.plugins[plugin.contextId]) {
        throw new Error("The version catalog references an unknown plugin context.");
      }
      contextIds.add(plugin.contextId);
    }
  }

  for (const companion of catalog.companions) {
    validateCatalogResource(companion, "Version catalog companion", COMPANION_VERSION_SOURCE_TYPES);
    if (resourceIds.has(companion.id)) {
      throw new Error("The version catalog contains a duplicate resource id.");
    }
    resourceIds.add(companion.id);
  }

  if (requireConfiguredContexts) {
    for (const pluginId of Object.keys(config.plugins)) {
      if (!contextIds.has(pluginId)) {
        throw new Error(`The version catalog is missing the ${pluginId} plugin context.`);
      }
    }
    if (config.sharedCmilib?.id) {
      const sharedResource = catalog.plugins.find((plugin) => plugin.id === config.sharedCmilib.id);
      if (!sharedResource?.shared) {
        throw new Error("The version catalog is missing its shared plugin resource.");
      }
    }
  }

  return catalog;
}

function validateProfileSummary(profileSummary, scopeLabel) {
  requireObject(profileSummary, `${scopeLabel} summary`);
  requireNonEmptyString(profileSummary.profileName, `${scopeLabel} profile name`);
  requirePositiveCount(profileSummary.entryCount, `${scopeLabel} entry count`);
  requirePositiveCount(profileSummary.fileCount, `${scopeLabel} file count`);

  if (profileSummary.localEntryCount != null || profileSummary.localFileCount != null) {
    requirePositiveCount(profileSummary.localEntryCount, `${scopeLabel} local entry count`);
    requirePositiveCount(profileSummary.localFileCount, `${scopeLabel} local file count`);
    requireNonNegativeCount(profileSummary.sharedEntryCount, `${scopeLabel} shared entry count`);
    requireNonNegativeCount(profileSummary.sharedFileCount, `${scopeLabel} shared file count`);
    if (
      profileSummary.entryCount !== profileSummary.localEntryCount + profileSummary.sharedEntryCount ||
      profileSummary.fileCount !== profileSummary.localFileCount + profileSummary.sharedFileCount
    ) {
      throw new Error(`${scopeLabel} has inconsistent composed counts.`);
    }
  }
}

function validateProfileSummarySet(expectedProfiles, summaries, scopeLabel) {
  if (!Array.isArray(summaries)) {
    throw new Error(`${scopeLabel} profile summaries must be a list.`);
  }
  const seen = new Set();
  for (const profileSummary of summaries) {
    validateProfileSummary(profileSummary, `${scopeLabel}:${profileSummary?.profileName ?? "unknown"}`);
    if (seen.has(profileSummary.profileName)) {
      throw new Error(`${scopeLabel} contains a duplicate profile summary.`);
    }
    if (!expectedProfiles[profileSummary.profileName]) {
      throw new Error(`${scopeLabel} contains an unexpected profile summary.`);
    }
    seen.add(profileSummary.profileName);
  }
  for (const profileName of Object.keys(expectedProfiles)) {
    if (!seen.has(profileName) && expectedProfiles[profileName].allowEmpty !== true) {
      throw new Error(`${scopeLabel} is missing the ${profileName} profile summary.`);
    }
  }
}

export function validateCacheSummary(config, summary) {
  requireObject(summary, "Search cache summary");
  requirePositiveCount(summary.totalEntries, "Search cache total entries");
  requirePositiveCount(summary.totalFiles, "Search cache total files");
  requireValidTimestamp(summary.lastReloadedAt, "Search cache reload timestamp");
  if (!Array.isArray(summary.pluginSummaries)) {
    throw new Error("Search cache plugin summaries must be a list.");
  }

  const pluginSummaries = new Map();
  for (const pluginSummary of summary.pluginSummaries) {
    requireObject(pluginSummary, "Search cache plugin summary");
    requireNonEmptyString(pluginSummary.pluginId, "Search cache plugin id");
    if (pluginSummaries.has(pluginSummary.pluginId)) {
      throw new Error("Search cache contains a duplicate plugin summary.");
    }
    const plugin = config.plugins[pluginSummary.pluginId];
    if (!plugin) {
      throw new Error("Search cache contains an unknown plugin summary.");
    }
    validateProfileSummarySet(plugin.profiles, pluginSummary.profileSummaries, plugin.id);
    const calculatedEntries = pluginSummary.profileSummaries.reduce(
      (total, profile) => total + profile.entryCount,
      0,
    );
    const calculatedFiles = pluginSummary.profileSummaries.reduce(
      (total, profile) => total + profile.fileCount,
      0,
    );
    if (pluginSummary.totalEntries !== calculatedEntries || pluginSummary.totalFiles !== calculatedFiles) {
      throw new Error(`${plugin.id} has inconsistent cache totals.`);
    }
    pluginSummaries.set(pluginSummary.pluginId, pluginSummary);
  }
  for (const pluginId of Object.keys(config.plugins)) {
    if (!pluginSummaries.has(pluginId)) {
      throw new Error(`Search cache is missing the ${pluginId} plugin summary.`);
    }
  }

  let storedEntries = 0;
  let storedFiles = 0;
  for (const pluginSummary of pluginSummaries.values()) {
    for (const profile of pluginSummary.profileSummaries) {
      storedEntries += profile.localEntryCount ?? profile.entryCount;
      storedFiles += profile.localFileCount ?? profile.fileCount;
    }
  }

  const sharedProfiles = config.sharedCmilib?.profiles ?? {};
  if (Object.keys(sharedProfiles).length) {
    requireObject(summary.sharedCmilibSummary, "Shared cache summary");
    validateProfileSummarySet(
      sharedProfiles,
      summary.sharedCmilibSummary.profileSummaries,
      "shared",
    );
    for (const profile of summary.sharedCmilibSummary.profileSummaries) {
      storedEntries += profile.entryCount;
      storedFiles += profile.fileCount;
    }
  }

  if (summary.totalEntries !== storedEntries || summary.totalFiles !== storedFiles) {
    throw new Error("Search cache global totals are inconsistent.");
  }
  return summary;
}

export function validateVersionSnapshot(config, snapshot) {
  requireObject(snapshot, "Version snapshot");
  validateVersionCatalog(snapshot.catalog, config, {
    requireGeneratedAt: true,
    requireConfiguredContexts: true,
  });
  if (!(snapshot.plugins instanceof Map) || !(snapshot.companions instanceof Map)) {
    throw new Error("Version snapshot resource state is malformed.");
  }
  requireNonNegativeCount(snapshot.errorCount, "Version snapshot error count");
  requireNonNegativeCount(snapshot.retainedCount, "Version snapshot retained count");
  if (snapshot.checkEnabled) {
    requireValidTimestamp(snapshot.checkedAt, "Version snapshot check timestamp");
  } else if (snapshot.checkedAt != null) {
    requireValidTimestamp(snapshot.checkedAt, "Version snapshot check timestamp");
  }
  return snapshot;
}

export function validateStartupState(config, cacheSummary, versionSnapshot) {
  validateCacheSummary(config, cacheSummary);
  validateVersionSnapshot(config, versionSnapshot);
  return {
    ready: true,
    validatedAt: new Date(),
    pluginCount: cacheSummary.pluginSummaries.length,
    profileCount: cacheSummary.pluginSummaries.reduce(
      (total, plugin) => total + plugin.profileSummaries.length,
      0,
    ),
  };
}
