import path from "node:path";
import { loadSearchSynonyms, parseSearchSynonymDocument } from "./searchSynonyms.js";
import { parseServiceLogOptions } from "./serviceLog.js";
import { normalizePublicGitHubRepositoryUrl } from "./sourceLinks.js";
import { isLocalOllamaModelName, normalizeLoopbackOllamaBaseUrl } from "./ollama.js";

const SUPPORTED_PROFILE_SOURCE_TYPES = new Set(["log", "yaml"]);
const SUPPORTED_LOG_PARSER_TYPES = new Set([
  "cmdPerms",
  "commentBlocks",
  "delimited",
  "faqMixed",
  "permissionList",
  "permissionMixed",
  "tokenList",
]);
const SEARCH_COMMAND_NAMES = new Set([
  "command",
  "config",
  "faq",
  "language",
  "material",
  "permission",
  "placeholder",
  "tabcomplete",
]);

function parseCsv(value) {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseCsvWithRequired(value, fallback, required = []) {
  return [...new Set([...parseCsv(value ?? fallback), ...required])];
}

function parseInteger(value, fallback) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseDecimal(value, fallback) {
  if (value == null || value === "") {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function parseBoolean(value, fallback = false) {
  if (value == null || value === "") {
    return fallback;
  }

  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  return fallback;
}

function requireConfigValue(value, name) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Missing required configuration value: ${name}`);
  }
}

function requireArray(value, name) {
  if (!Array.isArray(value)) {
    throw new Error(`${name} must be a list.`);
  }
}

function assertUniqueStrings(values, name) {
  requireArray(values, name);
  const seen = new Set();
  for (const value of values) {
    if (typeof value !== "string" || !value.trim()) {
      throw new Error(`${name} must contain only non-empty strings.`);
    }
    if (seen.has(value)) {
      throw new Error(`${name} contains a duplicate entry.`);
    }
    seen.add(value);
  }
}

function validateRelativePath(value, name, { allowGlob = false } = {}) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} must be a non-empty relative path${allowGlob ? " or glob" : ""}.`);
  }

  const candidate = allowGlob ? value.replace(/^!/, "") : value;
  if (
    !candidate ||
    /[\u0000-\u001f\u007f]/.test(candidate) ||
    candidate.includes("\\") ||
    path.posix.isAbsolute(candidate) ||
    path.win32.isAbsolute(candidate) ||
    candidate.split("/").some((segment) => segment === "..")
  ) {
    throw new Error(`${name} must stay within the project workspace.`);
  }
}

function validateProfile(profileKey, profile, scopeName, sharedProfiles) {
  if (!profile || typeof profile !== "object") {
    throw new Error(`${scopeName} profile ${profileKey} is invalid.`);
  }
  if (profile.name !== profileKey) {
    throw new Error(`${scopeName} profile key and name must match for ${profileKey}.`);
  }
  if (!SUPPORTED_PROFILE_SOURCE_TYPES.has(profile.sourceType)) {
    throw new Error(`${scopeName}:${profileKey} has an unsupported source type.`);
  }
  requireArray(profile.include, `${scopeName}:${profileKey} include patterns`);
  if (!profile.include.length) {
    throw new Error(`${scopeName}:${profileKey} must define at least one include pattern.`);
  }
  requireArray(profile.exclude, `${scopeName}:${profileKey} exclude patterns`);
  for (const [index, pattern] of profile.include.entries()) {
    validateRelativePath(pattern, `${scopeName}:${profileKey} include pattern ${index + 1}`, {
      allowGlob: true,
    });
  }
  for (const [index, pattern] of profile.exclude.entries()) {
    validateRelativePath(pattern, `${scopeName}:${profileKey} exclude pattern ${index + 1}`, {
      allowGlob: true,
    });
  }
  if (profile.sourceType === "log" && !SUPPORTED_LOG_PARSER_TYPES.has(profile.parserType)) {
    throw new Error(`${scopeName}:${profileKey} has an unsupported log parser.`);
  }
  if (profile.allowEmpty != null && typeof profile.allowEmpty !== "boolean") {
    throw new Error(`${scopeName}:${profileKey} has an invalid allowEmpty setting.`);
  }
  if (profile.sharedProfileName && !sharedProfiles?.[profile.sharedProfileName]) {
    throw new Error(`${scopeName}:${profileKey} references an unknown shared profile.`);
  }
}

function validatePluginConfiguration(config) {
  if (!config.plugins || typeof config.plugins !== "object" || !Object.keys(config.plugins).length) {
    throw new Error("At least one plugin context must be configured.");
  }

  const sharedProfiles = config.sharedCmilib?.profiles ?? {};
  for (const [profileKey, profile] of Object.entries(sharedProfiles)) {
    validateProfile(profileKey, profile, "shared", null);
  }

  for (const [pluginKey, plugin] of Object.entries(config.plugins)) {
    if (!plugin || typeof plugin !== "object" || plugin.id !== pluginKey || !plugin.label) {
      throw new Error(`Plugin context ${pluginKey} has invalid identity metadata.`);
    }
    if (!plugin.profiles || typeof plugin.profiles !== "object" || !Object.keys(plugin.profiles).length) {
      throw new Error(`Plugin context ${pluginKey} must define at least one profile.`);
    }
    for (const [profileKey, profile] of Object.entries(plugin.profiles)) {
      validateProfile(profileKey, profile, pluginKey, sharedProfiles);
    }
    for (const [commandName, availability] of Object.entries(plugin.commandAvailability ?? {})) {
      if (!["ready", "coming_soon", "unsupported"].includes(availability)) {
        throw new Error(`${pluginKey} has invalid availability for ${commandName}.`);
      }
      if (availability === "ready" && SEARCH_COMMAND_NAMES.has(commandName) && !plugin.profiles[commandName]) {
        throw new Error(`${pluginKey} marks ${commandName} ready without a matching profile.`);
      }
    }
  }

  parseSearchSynonymDocument({
    schemaVersion: 1,
    plugins: config.search.synonymsByPlugin,
  });
  for (const pluginId of Object.keys(config.search.synonymsByPlugin)) {
    if (!config.plugins[pluginId]) {
      throw new Error(`Search synonyms reference an unknown plugin context: ${pluginId}.`);
    }
  }
}

function validateDiscordRoutes(config) {
  const { discord } = config;
  assertUniqueStrings(discord.allowedChannelIds, "DISCORD_ALLOWED_CHANNEL_IDS");
  assertUniqueStrings(discord.testChannelIds, "DISCORD_TEST_CHANNEL_IDS");
  assertUniqueStrings(discord.allowedRoleIds, "ALLOWED_ROLE_IDS");
  assertUniqueStrings(discord.adminRoleIds, "ADMIN_ROLE_IDS");
  assertUniqueStrings(discord.aiRoleIds, "AI_ROLE_IDS");

  if (!discord.pluginChannelIds || typeof discord.pluginChannelIds !== "object") {
    throw new Error("Discord plugin channel routes must be configured.");
  }

  const allowedChannels = new Set(discord.allowedChannelIds);
  const routedChannels = new Set();
  for (const [pluginId, channelIds] of Object.entries(discord.pluginChannelIds)) {
    if (!config.plugins[pluginId]) {
      throw new Error(`Discord routes reference an unknown plugin context: ${pluginId}.`);
    }
    assertUniqueStrings(channelIds, `Discord routes for ${pluginId}`);
    for (const channelId of channelIds) {
      if (!allowedChannels.has(channelId)) {
        throw new Error(`A ${pluginId} channel route is missing from the allowed channel list.`);
      }
      if (routedChannels.has(channelId)) {
        throw new Error("A Discord channel is assigned to more than one route.");
      }
      routedChannels.add(channelId);
    }
  }

  for (const channelId of discord.testChannelIds) {
    if (!allowedChannels.has(channelId)) {
      throw new Error("A test channel route is missing from the allowed channel list.");
    }
    if (routedChannels.has(channelId)) {
      throw new Error("A Discord channel is assigned to more than one route.");
    }
    routedChannels.add(channelId);
  }

  if (routedChannels.size !== allowedChannels.size) {
    throw new Error("Every allowed Discord channel must map to exactly one plugin or test route.");
  }
}

function toPosixPath(value) {
  return value.split(path.sep).join("/");
}

function toDisplayRelativePath(relativePath) {
  const normalized = toPosixPath(relativePath);

  const replacements = [
    ["CMIPlugin/CMI/", "CMI/"],
    ["CMIPlugin/data/", "CMI/data/"],
    ["CMILibPlugin/CMILib/", "CMILib/"],
    ["CMILibPlugin/data/", "CMILib/data/"],
    ["JobsPlugin/", "Jobs/"],
    ["ResidencePlugin/", "Residence/"],
    ["SVISPlugin/", "SelectionVisualizer/"],
    ["MFMPlugin/", "MobFarmManager/"],
    ["TryMePlugin/", "TryMe/"],
    ["TradeMePlugin/", "TradeMe/"],
    ["BottledExpPlugin/", "BottledExp/"],
  ];

  for (const [from, to] of replacements) {
    if (normalized.startsWith(from)) {
      return `${to}${normalized.slice(from.length)}`;
    }
  }

  return normalized;
}

function createProfile(name, overrides = {}) {
  return {
    name,
    displayName: name,
    sourceType: "yaml",
    entryLabel: "entries",
    statsFileLabel: "files",
    referenceLabel: "",
    referenceUrl: "",
    include: [],
    exclude: [],
    ...overrides,
  };
}

function buildSimplePluginProfiles({
  configInclude,
  configExcludeEnv,
  configExcludeDefault = "",
  languageInclude,
  languageExcludeEnv,
  languageExcludeDefault = "",
} = {}) {
  return {
    config: createProfile("config", {
      sourceType: "yaml",
      entryLabel: "YAML entries",
      statsFileLabel: "YAML configuration files",
      sharedProfileName: "config",
      include: parseCsv(configInclude),
      exclude: parseCsv(configExcludeEnv ?? configExcludeDefault),
    }),
    language: createProfile("language", {
      sourceType: "yaml",
      entryLabel: "YAML entries",
      statsFileLabel: "YAML locale files",
      sharedProfileName: "language",
      include: parseCsv(languageInclude),
      exclude: parseCsv(languageExcludeEnv ?? languageExcludeDefault),
    }),
  };
}

function buildSharedCmilibProfiles() {
  return {
    config: createProfile("config", {
      sourceType: "yaml",
      entryLabel: "YAML entries",
      statsFileLabel: "YAML configuration files",
      include: parseCsv(process.env.CMILIB_LOOKUP_INCLUDE_GLOBS ?? "CMILibPlugin/CMILib/config.yml"),
      exclude: parseCsv(process.env.CMILIB_LOOKUP_EXCLUDE_GLOBS),
    }),
    language: createProfile("language", {
      sourceType: "yaml",
      entryLabel: "YAML entries",
      statsFileLabel: "YAML locale files",
      include: parseCsv(
        process.env.CMILIB_LANGUAGE_INCLUDE_GLOBS ?? "CMILibPlugin/CMILib/Translations/**/*_EN.yml",
      ),
      exclude: parseCsv(process.env.CMILIB_LANGUAGE_EXCLUDE_GLOBS),
    }),
    placeholder: createProfile("placeholder", {
      sourceType: "log",
      allowEmpty: true,
      entryLabel: "placeholder entries",
      statsFileLabel: "generated placeholder data files",
      parserType: "commentBlocks",
      codeLanguage: "yml",
      include: parseCsv(
        process.env.CMILIB_PLACEHOLDER_INCLUDE_GLOBS ?? "CMILibPlugin/data/generated-placeholders.log",
      ),
      exclude: parseCsv(process.env.CMILIB_PLACEHOLDER_EXCLUDE_GLOBS),
    }),
  };
}

function buildGeneratedJarProfiles({ envPrefix, targetDirectory, referenceUrl }) {
  return {
    command: createProfile("command", {
      sourceType: "log",
      entryLabel: "command entries",
      statsFileLabel: "generated command data files",
      referenceLabel: "commands",
      referenceUrl,
      parserType: "delimited",
      include: parseCsvWithRequired(
        process.env[`${envPrefix}_COMMAND_INCLUDE_GLOBS`],
        "",
        [`${targetDirectory}/data/generated-commands.log`],
      ),
      exclude: parseCsv(process.env[`${envPrefix}_COMMAND_EXCLUDE_GLOBS`]),
    }),
    permission: createProfile("permission", {
      sourceType: "log",
      entryLabel: "permission entries",
      statsFileLabel: "generated permission data files",
      referenceLabel: "permissions",
      referenceUrl,
      parserType: "permissionList",
      include: parseCsvWithRequired(
        process.env[`${envPrefix}_PERMISSION_INCLUDE_GLOBS`],
        "",
        [`${targetDirectory}/data/generated-permissions.log`],
      ),
      exclude: parseCsv(process.env[`${envPrefix}_PERMISSION_EXCLUDE_GLOBS`]),
    }),
  };
}

function buildCmiProfiles() {
  return {
    config: createProfile("config", {
      sourceType: "yaml",
      entryLabel: "YAML entries",
      statsFileLabel: "YAML configuration files",
      sharedProfileName: "config",
      include: parseCsv(
        process.env.LOOKUP_INCLUDE_GLOBS ??
          "CMIPlugin/CMI/config.yml,CMIPlugin/CMI/Settings/**/*.yml",
      ),
      exclude: parseCsv(
        process.env.LOOKUP_EXCLUDE_GLOBS ??
          "**/Translations/**,**/DatabaseBackups/**,**/FileBackups/**,**/Logs/**,**/moneyLog/**,**/sellLogs/**",
      ),
    }),
    language: createProfile("language", {
      sourceType: "yaml",
      entryLabel: "YAML entries",
      statsFileLabel: "YAML locale files",
      sharedProfileName: "language",
      include: parseCsv(
        process.env.LANGLOOKUP_INCLUDE_GLOBS ??
          "CMIPlugin/CMI/Translations/**/Locale_EN.yml",
      ),
      exclude: parseCsv(process.env.LANGLOOKUP_EXCLUDE_GLOBS),
    }),
    placeholder: createProfile("placeholder", {
      sourceType: "log",
      entryLabel: "placeholder entries",
      statsFileLabel: "placeholder data files",
      referenceLabel: "placeholders",
      referenceUrl: "https://www.zrips.net/cmi/placeholders/",
      parserType: "commentBlocks",
      codeLanguage: "yml",
      sharedProfileName: "placeholder",
      include: parseCsvWithRequired(
        process.env.PLACEHOLDER_INCLUDE_GLOBS,
        "CMIPlugin/data/placeholders.log",
        ["CMIPlugin/data/generated-placeholders.log"],
      ),
      exclude: parseCsv(process.env.PLACEHOLDER_EXCLUDE_GLOBS),
    }),
    material: createProfile("material", {
      sourceType: "log",
      entryLabel: "material entries",
      statsFileLabel: "material data files",
      parserType: "tokenList",
      defaultResultLimit: 25,
      maxResultLimit: 25,
      include: parseCsv(process.env.MATERIAL_INCLUDE_GLOBS ?? "CMIPlugin/data/materials.log"),
      exclude: parseCsv(process.env.MATERIAL_EXCLUDE_GLOBS),
    }),
    command: createProfile("command", {
      sourceType: "log",
      entryLabel: "command entries",
      statsFileLabel: "command data files",
      referenceLabel: "commands",
      referenceUrl: "https://www.zrips.net/cmi/commands/",
      parserType: "delimited",
      include: parseCsvWithRequired(
        process.env.COMMAND_INCLUDE_GLOBS,
        "CMIPlugin/data/commands.log",
        ["CMIPlugin/data/generated-commands.log"],
      ),
      exclude: parseCsv(process.env.COMMAND_EXCLUDE_GLOBS),
    }),
    permission: createProfile("permission", {
      sourceType: "log",
      entryLabel: "permission entries",
      statsFileLabel: "permission data files",
      referenceLabel: "permissions",
      referenceUrl: "https://www.zrips.net/cmi/permissions/",
      parserType: "permissionMixed",
      include: parseCsvWithRequired(
        process.env.PERMISSION_INCLUDE_GLOBS,
        "CMIPlugin/data/permissions.log,CMIPlugin/data/cmdperms.log",
        ["CMIPlugin/data/generated-permissions.log"],
      ),
      exclude: parseCsv(process.env.PERMISSION_EXCLUDE_GLOBS),
    }),
    faq: createProfile("faq", {
      sourceType: "log",
      entryLabel: "FAQ entries",
      statsFileLabel: "FAQ data files",
      referenceLabel: "",
      referenceUrl: "",
      parserType: "commentBlocks",
      include: parseCsv(process.env.FAQ_INCLUDE_GLOBS ?? "CMIPlugin/data/faq.log"),
      exclude: parseCsv(process.env.FAQ_EXCLUDE_GLOBS),
    }),
    tabcomplete: createProfile("tabcomplete", {
      sourceType: "log",
      entryLabel: "tab-complete entries",
      statsFileLabel: "tab-complete data files",
      parserType: "delimited",
      include: parseCsv(process.env.TABCOMPLETE_INCLUDE_GLOBS ?? "CMIPlugin/data/tabcompletes.log"),
      exclude: parseCsv(process.env.TABCOMPLETE_EXCLUDE_GLOBS),
    }),
  };
}

function buildJobsProfiles() {
  return {
    config: createProfile("config", {
      sourceType: "yaml",
      entryLabel: "YAML entries",
      statsFileLabel: "YAML configuration files",
      sharedProfileName: "config",
      include: parseCsv(
        process.env.JOBS_LOOKUP_INCLUDE_GLOBS ??
          "JobsPlugin/*.yml,JobsPlugin/jobs/**/*.yml",
      ),
      exclude: parseCsv(
        process.env.JOBS_LOOKUP_EXCLUDE_GLOBS ??
          "JobsPlugin/locale/**,JobsPlugin/TranslatableWords/**,JobsPlugin/data/**,JobsPlugin/Signs.yml,JobsPlugin/activeBoosts.yml,JobsPlugin/blockOwnerShips.yml",
      ),
    }),
    language: createProfile("language", {
      sourceType: "yaml",
      entryLabel: "YAML entries",
      statsFileLabel: "YAML locale files",
      sharedProfileName: "language",
      include: parseCsv(
        process.env.JOBS_LANGUAGE_INCLUDE_GLOBS ??
          "JobsPlugin/locale/messages_en.yml,JobsPlugin/TranslatableWords/Words_en.yml",
      ),
      exclude: parseCsv(process.env.JOBS_LANGUAGE_EXCLUDE_GLOBS),
    }),
    placeholder: createProfile("placeholder", {
      sourceType: "log",
      entryLabel: "placeholder entries",
      statsFileLabel: "placeholder data files",
      referenceLabel: "placeholders",
      referenceUrl: "https://www.zrips.net/jobs/placeholders/",
      parserType: "commentBlocks",
      codeLanguage: "yml",
      sharedProfileName: "placeholder",
      include: parseCsvWithRequired(
        process.env.JOBS_PLACEHOLDER_INCLUDE_GLOBS,
        "JobsPlugin/data/placeholders.log",
        ["JobsPlugin/data/generated-placeholders.log"],
      ),
      exclude: parseCsv(process.env.JOBS_PLACEHOLDER_EXCLUDE_GLOBS),
    }),
    command: createProfile("command", {
      sourceType: "log",
      entryLabel: "command entries",
      statsFileLabel: "command data files",
      referenceLabel: "commands",
      referenceUrl: "https://www.zrips.net/jobs/jobs-commands/",
      parserType: "delimited",
      include: parseCsvWithRequired(
        process.env.JOBS_COMMAND_INCLUDE_GLOBS,
        "JobsPlugin/data/commands.log",
        ["JobsPlugin/data/generated-commands.log"],
      ),
      exclude: parseCsv(process.env.JOBS_COMMAND_EXCLUDE_GLOBS),
    }),
    permission: createProfile("permission", {
      sourceType: "log",
      entryLabel: "permission entries",
      statsFileLabel: "permission data files",
      referenceLabel: "permissions",
      referenceUrl: "https://www.zrips.net/jobs/permissions/",
      parserType: "permissionMixed",
      include: parseCsvWithRequired(
        process.env.JOBS_PERMISSION_INCLUDE_GLOBS,
        "JobsPlugin/data/permissions.log",
        ["JobsPlugin/data/generated-permissions.log"],
      ),
      exclude: parseCsv(process.env.JOBS_PERMISSION_EXCLUDE_GLOBS),
    }),
    faq: createProfile("faq", {
      sourceType: "log",
      entryLabel: "FAQ entries",
      statsFileLabel: "FAQ data files",
      referenceLabel: "FAQ entries",
      referenceUrl: "https://www.zrips.net/jobs/common-issues/",
      parserType: "faqMixed",
      include: parseCsv(process.env.JOBS_FAQ_INCLUDE_GLOBS ?? "JobsPlugin/data/faq.log,JobsPlugin/data/faq/*.md"),
      exclude: parseCsv(process.env.JOBS_FAQ_EXCLUDE_GLOBS),
    }),
  };
}

function buildSvisProfiles() {
  return {
    ...buildSimplePluginProfiles({
      configInclude:
        process.env.SVIS_LOOKUP_INCLUDE_GLOBS ?? "SVISPlugin/config.yml",
      configExcludeEnv: process.env.SVIS_LOOKUP_EXCLUDE_GLOBS,
      languageInclude:
        process.env.SVIS_LANGUAGE_INCLUDE_GLOBS ?? "SVISPlugin/Locale_EN.yml",
      languageExcludeEnv: process.env.SVIS_LANGUAGE_EXCLUDE_GLOBS,
    }),
    command: createProfile("command", {
      sourceType: "log",
      entryLabel: "command entries",
      statsFileLabel: "command data files",
      referenceLabel: "commands",
      referenceUrl: "https://www.zrips.net/svis/",
      parserType: "delimited",
      include: parseCsvWithRequired(
        process.env.SVIS_COMMAND_INCLUDE_GLOBS,
        "SVISPlugin/data/commands.log",
        ["SVISPlugin/data/generated-commands.log"],
      ),
      exclude: parseCsv(process.env.SVIS_COMMAND_EXCLUDE_GLOBS),
    }),
    permission: createProfile("permission", {
      sourceType: "log",
      entryLabel: "permission entries",
      statsFileLabel: "permission data files",
      referenceLabel: "permissions",
      referenceUrl: "https://www.zrips.net/svis/",
      parserType: "permissionList",
      include: parseCsvWithRequired(
        process.env.SVIS_PERMISSION_INCLUDE_GLOBS,
        "SVISPlugin/data/permissions.log",
        ["SVISPlugin/data/generated-permissions.log"],
      ),
      exclude: parseCsv(process.env.SVIS_PERMISSION_EXCLUDE_GLOBS),
    }),
  };
}

function buildMfmProfiles() {
  return {
    ...buildSimplePluginProfiles({
      configInclude:
        process.env.MFM_LOOKUP_INCLUDE_GLOBS ?? "MFMPlugin/config.yml",
      configExcludeEnv: process.env.MFM_LOOKUP_EXCLUDE_GLOBS,
      languageInclude:
        process.env.MFM_LANGUAGE_INCLUDE_GLOBS ?? "MFMPlugin/Locale/Locale_EN.yml",
      languageExcludeEnv: process.env.MFM_LANGUAGE_EXCLUDE_GLOBS,
    }),
    ...buildGeneratedJarProfiles({
      envPrefix: "MFM",
      targetDirectory: "MFMPlugin",
      referenceUrl: "https://www.spigotmc.org/resources/15127/",
    }),
  };
}

function buildTrymeProfiles() {
  return {
    ...buildSimplePluginProfiles({
      configInclude:
        process.env.TRYME_LOOKUP_INCLUDE_GLOBS ?? "TryMePlugin/*.yml",
      configExcludeEnv: process.env.TRYME_LOOKUP_EXCLUDE_GLOBS,
      configExcludeDefault: "TryMePlugin/Locale_EN.yml,TryMePlugin/Signs.yml",
      languageInclude:
        process.env.TRYME_LANGUAGE_INCLUDE_GLOBS ?? "TryMePlugin/Locale_EN.yml",
      languageExcludeEnv: process.env.TRYME_LANGUAGE_EXCLUDE_GLOBS,
    }),
    ...buildGeneratedJarProfiles({
      envPrefix: "TRYME",
      targetDirectory: "TryMePlugin",
      referenceUrl: "https://www.spigotmc.org/resources/3330/",
    }),
    placeholder: createProfile("placeholder", {
      sourceType: "log",
      entryLabel: "placeholder entries",
      statsFileLabel: "generated placeholder data files",
      referenceLabel: "placeholders",
      referenceUrl: "https://www.spigotmc.org/resources/3330/",
      parserType: "commentBlocks",
      codeLanguage: "yml",
      sharedProfileName: "placeholder",
      include: parseCsvWithRequired(process.env.TRYME_PLACEHOLDER_INCLUDE_GLOBS, "", [
        "TryMePlugin/data/generated-placeholders.log",
      ]),
      exclude: parseCsv(process.env.TRYME_PLACEHOLDER_EXCLUDE_GLOBS),
    }),
  };
}

function buildBottledExpProfiles() {
  return {
    ...buildSimplePluginProfiles({
      configInclude:
        process.env.BOTTLEDEXP_LOOKUP_INCLUDE_GLOBS ??
        "BottledExpPlugin/config.yml,BottledExpPlugin/recipes.yml",
      configExcludeEnv: process.env.BOTTLEDEXP_LOOKUP_EXCLUDE_GLOBS,
      languageInclude:
        process.env.BOTTLEDEXP_LANGUAGE_INCLUDE_GLOBS ?? "BottledExpPlugin/Locale_EN.yml",
      languageExcludeEnv: process.env.BOTTLEDEXP_LANGUAGE_EXCLUDE_GLOBS,
    }),
    ...buildGeneratedJarProfiles({
      envPrefix: "BOTTLEDEXP",
      targetDirectory: "BottledExpPlugin",
      referenceUrl: "https://www.spigotmc.org/resources/2815/",
    }),
  };
}

function buildTrademeProfiles() {
  return {
    ...buildSimplePluginProfiles({
      configInclude:
        process.env.TRADEME_LOOKUP_INCLUDE_GLOBS ?? "TradeMePlugin/config.yml",
      configExcludeEnv: process.env.TRADEME_LOOKUP_EXCLUDE_GLOBS,
      languageInclude:
        process.env.TRADEME_LANGUAGE_INCLUDE_GLOBS ?? "TradeMePlugin/Locale_EN.yml",
      languageExcludeEnv: process.env.TRADEME_LANGUAGE_EXCLUDE_GLOBS,
    }),
    ...buildGeneratedJarProfiles({
      envPrefix: "TRADEME",
      targetDirectory: "TradeMePlugin",
      referenceUrl: "https://www.spigotmc.org/resources/7544/",
    }),
    placeholder: createProfile("placeholder", {
      sourceType: "log",
      entryLabel: "placeholder entries",
      statsFileLabel: "generated placeholder data files",
      referenceLabel: "placeholders",
      referenceUrl: "https://www.spigotmc.org/resources/7544/",
      parserType: "commentBlocks",
      codeLanguage: "yml",
      sharedProfileName: "placeholder",
      include: parseCsvWithRequired(process.env.TRADEME_PLACEHOLDER_INCLUDE_GLOBS, "", [
        "TradeMePlugin/data/generated-placeholders.log",
      ]),
      exclude: parseCsv(process.env.TRADEME_PLACEHOLDER_EXCLUDE_GLOBS),
    }),
  };
}

function buildResidenceProfiles() {
  return {
    config: createProfile("config", {
      sourceType: "yaml",
      entryLabel: "YAML entries",
      statsFileLabel: "YAML configuration files",
      sharedProfileName: "config",
      include: parseCsv(
        process.env.RESIDENCE_LOOKUP_INCLUDE_GLOBS ??
          "ResidencePlugin/config.yml,ResidencePlugin/groups.yml,ResidencePlugin/flags.yml,ResidencePlugin/ShopVotes.yml",
      ),
      exclude: parseCsv(process.env.RESIDENCE_LOOKUP_EXCLUDE_GLOBS),
    }),
    language: createProfile("language", {
      sourceType: "yaml",
      entryLabel: "YAML entries",
      statsFileLabel: "YAML locale files",
      sharedProfileName: "language",
      include: parseCsv(
        process.env.RESIDENCE_LANGUAGE_INCLUDE_GLOBS ??
          "ResidencePlugin/Language/English.yml",
      ),
      exclude: parseCsv(process.env.RESIDENCE_LANGUAGE_EXCLUDE_GLOBS),
    }),
    placeholder: createProfile("placeholder", {
      sourceType: "log",
      entryLabel: "placeholder entries",
      statsFileLabel: "placeholder data files",
      referenceLabel: "placeholders",
      referenceUrl: "https://www.zrips.net/residence/placeholders/",
      parserType: "delimited",
      codeLanguage: "yml",
      sharedProfileName: "placeholder",
      include: parseCsvWithRequired(
        process.env.RESIDENCE_PLACEHOLDER_INCLUDE_GLOBS,
        "ResidencePlugin/data/placeholders.log",
        ["ResidencePlugin/data/generated-placeholders.log"],
      ),
      exclude: parseCsv(process.env.RESIDENCE_PLACEHOLDER_EXCLUDE_GLOBS),
    }),
    command: createProfile("command", {
      sourceType: "log",
      entryLabel: "command entries",
      statsFileLabel: "command data files",
      referenceLabel: "commands",
      referenceUrl: "https://www.zrips.net/residence/commands/",
      parserType: "commentBlocks",
      codeLanguage: "yml",
      include: parseCsvWithRequired(
        process.env.RESIDENCE_COMMAND_INCLUDE_GLOBS,
        "ResidencePlugin/data/commands.log",
        ["ResidencePlugin/data/generated-commands.log"],
      ),
      exclude: parseCsv(process.env.RESIDENCE_COMMAND_EXCLUDE_GLOBS),
    }),
    permission: createProfile("permission", {
      sourceType: "log",
      entryLabel: "permission entries",
      statsFileLabel: "permission data files",
      referenceLabel: "permissions",
      referenceUrl: "https://www.zrips.net/residence/permissions/",
      parserType: "permissionList",
      include: parseCsvWithRequired(
        process.env.RESIDENCE_PERMISSION_INCLUDE_GLOBS,
        "ResidencePlugin/data/permissions.log",
        ["ResidencePlugin/data/generated-permissions.log"],
      ),
      exclude: parseCsv(process.env.RESIDENCE_PERMISSION_EXCLUDE_GLOBS),
    }),
  };
}

function buildPluginCommandAvailability(overrides = {}) {
  return {
    help: "ready",
    config: "ready",
    language: "ready",
    placeholder: "ready",
    material: "ready",
    command: "ready",
    permission: "ready",
    faq: "ready",
    tabcomplete: "ready",
    langstats: "ready",
    stats: "ready",
    files: "ready",
    categories: "ready",
    latest: "ready",
    health: "ready",
    debug: "ready",
    reload: "ready",
    ...overrides,
  };
}

export function loadConfig() {
  const workspaceRoot = process.cwd();
  const displayPathPrefix = process.env.DISPLAY_PATH_PREFIX?.trim() || "~/plugins";
  const searchSynonymsPath = process.env.SEARCH_SYNONYMS_PATH?.trim() || "data/search-synonyms.json";
  const synonymsByPlugin = loadSearchSynonyms(workspaceRoot, searchSynonymsPath);
  const cmiProfiles = buildCmiProfiles();
  const jobsProfiles = buildJobsProfiles();
  const svisProfiles = buildSvisProfiles();
  const mfmProfiles = buildMfmProfiles();
  const trymeProfiles = buildTrymeProfiles();
  const trademeProfiles = buildTrademeProfiles();
  const bottledExpProfiles = buildBottledExpProfiles();
  const residenceProfiles = buildResidenceProfiles();
  const sharedCmilibProfiles = buildSharedCmilibProfiles();
  const configuredTestChannelIds = parseCsv(process.env.DISCORD_TEST_CHANNEL_IDS);
  const fallbackLegacyTestChannelIds = parseCsv(process.env.DISCORD_CMI_TEST_CHANNEL_IDS);
  const testChannelIds = configuredTestChannelIds.length ? configuredTestChannelIds : fallbackLegacyTestChannelIds;
  const configuredAiRoleIds = parseCsv(process.env.AI_ROLE_IDS);
  const testDefaultContext = process.env.DISCORD_TEST_DEFAULT_CONTEXT?.trim().toLowerCase() || "cmi";
  const pluginChannelIds = {
    cmi: parseCsv(process.env.DISCORD_CMI_CHANNEL_IDS),
    jobs: parseCsv(process.env.DISCORD_JOBS_CHANNEL_IDS),
    svis: parseCsv(process.env.DISCORD_SVIS_CHANNEL_IDS),
    mfm: parseCsv(process.env.DISCORD_MFM_CHANNEL_IDS),
    tryme: parseCsv(process.env.DISCORD_TRYME_CHANNEL_IDS),
    trademe: parseCsv(process.env.DISCORD_TRADEME_CHANNEL_IDS),
    residence: parseCsv(process.env.DISCORD_RESIDENCE_CHANNEL_IDS),
    bottledexp: parseCsv(process.env.DISCORD_BOTTLEDEXP_CHANNEL_IDS),
  };
  const versionRetryBaseDelayMs = Math.max(
    0,
    Math.min(60_000, parseInteger(process.env.VERSION_CHECK_RETRY_BASE_MS, 250)),
  );
  const versionRetryMaxDelayMs = Math.max(
    versionRetryBaseDelayMs,
    Math.min(60_000, parseInteger(process.env.VERSION_CHECK_RETRY_MAX_MS, 2_000)),
  );

  return {
    workspaceRoot,
    displayPathPrefix,
    discord: {
      token: process.env.DISCORD_TOKEN?.trim() || "",
      applicationId: process.env.DISCORD_APPLICATION_ID?.trim() || "",
      guildId: process.env.DISCORD_GUILD_ID?.trim() || "",
      allowedChannelIds: parseCsv(process.env.DISCORD_ALLOWED_CHANNEL_IDS),
      pluginChannelIds,
      testChannelIds,
      testDefaultContext,
      allowedRoleIds: parseCsv(process.env.ALLOWED_ROLE_IDS),
      adminRoleIds: parseCsv(process.env.ADMIN_ROLE_IDS),
      aiRoleIds: configuredAiRoleIds.length
        ? configuredAiRoleIds
        : parseCsv(process.env.ADMIN_ROLE_IDS),
      adminAlertChannelId: process.env.DISCORD_ADMIN_ALERT_CHANNEL_ID?.trim() || "",
    },
    ai: {
      enabled: parseBoolean(process.env.AI_ENABLED, true),
      externalProvidersEnabled: parseBoolean(process.env.AI_EXTERNAL_PROVIDERS_ENABLED, false),
      paidBudgetUsd: parseDecimal(process.env.AI_PAID_BUDGET_USD, 0),
      usageStatePath: process.env.AI_USAGE_STATE_PATH?.trim() || "logs/ai-usage.json",
      dailyRequestLimit: Math.max(0, Math.min(10_000, parseInteger(process.env.AI_DAILY_REQUEST_LIMIT, 50))),
      monthlyRequestLimit: Math.max(0, Math.min(100_000, parseInteger(process.env.AI_MONTHLY_REQUEST_LIMIT, 1_000))),
      maxQuestionLength: Math.max(80, Math.min(1_000, parseInteger(process.env.AI_MAX_QUESTION_LENGTH, 320))),
      maxEvidenceItems: Math.max(1, Math.min(8, parseInteger(process.env.AI_MAX_EVIDENCE_ITEMS, 6))),
      maxEvidenceChars: Math.max(200, Math.min(2_000, parseInteger(process.env.AI_MAX_EVIDENCE_CHARS, 1_000))),
      maxOutputTokens: Math.max(64, Math.min(1_024, parseInteger(process.env.AI_MAX_OUTPUT_TOKENS, 350))),
      requestTimeoutMs:
        Math.max(1, Math.min(120, parseInteger(process.env.AI_REQUEST_TIMEOUT_SECONDS, 90))) * 1_000,
      statusTimeoutMs:
        Math.max(1, Math.min(10, parseInteger(process.env.AI_STATUS_TIMEOUT_SECONDS, 2))) * 1_000,
      ollama: {
        enabled: parseBoolean(process.env.OLLAMA_ENABLED, true),
        baseUrl: process.env.OLLAMA_BASE_URL?.trim() || "http://127.0.0.1:11434",
        model: process.env.OLLAMA_MODEL?.trim() || "qwen3:8b",
      },
    },
    search: {
      defaultResultLimit: Math.max(1, Math.min(15, parseInteger(process.env.DEFAULT_RESULT_LIMIT, 3))),
      maxResultLimit: 15,
      cacheLoadConcurrency: Math.max(
        1,
        Math.min(16, parseInteger(process.env.CACHE_LOAD_CONCURRENCY, 4)),
      ),
      resultCacheMaxEntries: Math.max(
        0,
        Math.min(4_096, parseInteger(process.env.SEARCH_RESULT_CACHE_MAX_ENTRIES, 256)),
      ),
      sourceLinksEnabled: parseBoolean(process.env.SOURCE_LINKS_ENABLED, true),
      sourceRepositoryUrl:
        process.env.SOURCE_REPOSITORY_URL?.trim() || "https://github.com/mrfdev/CMIBot",
      paginationTtlMs:
        Math.max(1, parseInteger(process.env.PAGINATION_TTL_MINUTES, 10)) * 60 * 1000,
      paginationMaxSessions: Math.max(
        1,
        Math.min(1_000, parseInteger(process.env.PAGINATION_MAX_SESSIONS, 200)),
      ),
      paginationMaxResults: Math.max(
        25,
        Math.min(250, parseInteger(process.env.PAGINATION_MAX_RESULTS, 100)),
      ),
      synonymsPath: searchSynonymsPath,
      synonymsByPlugin,
    },
    versions: {
      catalogPath: process.env.VERSION_CATALOG_PATH?.trim() || "data/versions.json",
      statePath: process.env.VERSION_STATE_PATH?.trim() || "logs/upstream-versions.json",
      checkEnabled: parseBoolean(process.env.VERSION_CHECK_ENABLED, true),
      checkIntervalMs: Math.max(1, parseInteger(process.env.VERSION_CHECK_INTERVAL_HOURS, 12)) * 60 * 60 * 1000,
      requestTimeoutMs: Math.max(1, parseInteger(process.env.VERSION_CHECK_TIMEOUT_SECONDS, 8)) * 1000,
      retryMaxAttempts: Math.max(1, Math.min(5, parseInteger(process.env.VERSION_CHECK_MAX_ATTEMPTS, 3))),
      retryBaseDelayMs: versionRetryBaseDelayMs,
      retryMaxDelayMs: versionRetryMaxDelayMs,
      circuitFailureThreshold: Math.max(
        1,
        Math.min(100, parseInteger(process.env.VERSION_CHECK_CIRCUIT_FAILURE_THRESHOLD, 3)),
      ),
      circuitCooldownMs:
        Math.max(
          1,
          Math.min(86_400, parseInteger(process.env.VERSION_CHECK_CIRCUIT_COOLDOWN_SECONDS, 300)),
        ) * 1000,
      paperVersion: process.env.PAPER_VERSION?.trim() || "26.2",
      paperChannels: parseCsv(process.env.PAPER_VERSION_CHANNELS ?? "STABLE").map((item) => item.toUpperCase()),
    },
    attention: {
      intervalMs:
        Math.max(1, parseInteger(process.env.ADMIN_ALERT_INTERVAL_MINUTES, 15)) * 60 * 1000,
      reminderMs:
        Math.max(1, parseInteger(process.env.ADMIN_ALERT_REMINDER_HOURS, 24)) * 60 * 60 * 1000,
      cleanDataMaxAgeMs:
        Math.max(1, parseInteger(process.env.CLEAN_DATA_STALE_HOURS, 48)) * 60 * 60 * 1000,
      upstreamMaxAgeMs:
        Math.max(
          1,
          parseInteger(
            process.env.UPSTREAM_CHECK_STALE_HOURS,
            Math.max(1, parseInteger(process.env.VERSION_CHECK_INTERVAL_HOURS, 12) * 2),
          ),
        ) *
        60 *
        60 *
        1000,
    },
    logging: parseServiceLogOptions(process.env),
    metrics: {
      logIntervalMs:
        Math.max(0, Math.min(1_440, parseInteger(process.env.METRICS_LOG_INTERVAL_MINUTES, 5))) *
        60 *
        1000,
    },
    sharedDebugRoots: [
      {
        label: "Shared CMILib",
        directories: ["CMILibPlugin"],
      },
    ],
    sharedCmilib: {
      id: "cmilib",
      label: "Shared CMILib data",
      profiles: sharedCmilibProfiles,
    },
    plugins: {
      cmi: {
        id: "cmi",
        label: "CMI",
        debugRoots: ["CMIPlugin"],
        profiles: cmiProfiles,
        commandAvailability: buildPluginCommandAvailability(),
      },
      jobs: {
        id: "jobs",
        label: "Jobs",
        debugRoots: ["JobsPlugin"],
        profiles: jobsProfiles,
        commandAvailability: buildPluginCommandAvailability({
          config: "ready",
          language: "ready",
          placeholder: "ready",
          material: "unsupported",
          command: "ready",
          permission: "ready",
          faq: "ready",
          tabcomplete: "unsupported",
        }),
      },
      svis: {
        id: "svis",
        label: "SVIS",
        debugRoots: ["SVISPlugin"],
        profiles: svisProfiles,
        commandAvailability: buildPluginCommandAvailability({
          placeholder: "unsupported",
          material: "unsupported",
          command: "ready",
          permission: "ready",
          faq: "unsupported",
          tabcomplete: "unsupported",
        }),
      },
      mfm: {
        id: "mfm",
        label: "MFM",
        debugRoots: ["MFMPlugin"],
        profiles: mfmProfiles,
        commandAvailability: buildPluginCommandAvailability({
          placeholder: "unsupported",
          material: "unsupported",
          command: "ready",
          permission: "ready",
          faq: "unsupported",
          tabcomplete: "unsupported",
        }),
      },
      tryme: {
        id: "tryme",
        label: "TryMe",
        debugRoots: ["TryMePlugin"],
        profiles: trymeProfiles,
        commandAvailability: buildPluginCommandAvailability({
          placeholder: "ready",
          material: "unsupported",
          command: "ready",
          permission: "ready",
          faq: "unsupported",
          tabcomplete: "unsupported",
        }),
      },
      trademe: {
        id: "trademe",
        label: "TradeMe",
        debugRoots: ["TradeMePlugin"],
        profiles: trademeProfiles,
        commandAvailability: buildPluginCommandAvailability({
          placeholder: "ready",
          material: "unsupported",
          command: "ready",
          permission: "ready",
          faq: "unsupported",
          tabcomplete: "unsupported",
        }),
      },
      residence: {
        id: "residence",
        label: "Residence",
        debugRoots: ["ResidencePlugin"],
        profiles: residenceProfiles,
        commandAvailability: buildPluginCommandAvailability({
          config: "ready",
          language: "ready",
          placeholder: "ready",
          material: "unsupported",
          command: "ready",
          permission: "ready",
          faq: "unsupported",
          tabcomplete: "unsupported",
        }),
      },
      bottledexp: {
        id: "bottledexp",
        label: "BottledExp",
        debugRoots: ["BottledExpPlugin"],
        profiles: bottledExpProfiles,
        commandAvailability: buildPluginCommandAvailability({
          placeholder: "unsupported",
          material: "unsupported",
          command: "ready",
          permission: "ready",
          faq: "unsupported",
          tabcomplete: "unsupported",
        }),
      },
    },
    security: {
      commandUserRateLimit: Math.max(0, parseInteger(process.env.COMMAND_USER_RATE_LIMIT, 10)),
      commandChannelRateLimit: Math.max(0, parseInteger(process.env.COMMAND_CHANNEL_RATE_LIMIT, 30)),
      commandGlobalRateLimit: Math.max(0, parseInteger(process.env.COMMAND_GLOBAL_RATE_LIMIT, 100)),
      commandRateWindowSeconds: Math.max(0, parseInteger(process.env.COMMAND_RATE_WINDOW_SECONDS, 30)),
      lookupCooldownSeconds: Math.max(0, parseInteger(process.env.LOOKUP_COOLDOWN_SECONDS, 3)),
      summaryCooldownSeconds: Math.max(0, parseInteger(process.env.SUMMARY_COOLDOWN_SECONDS, 15)),
      aiQuestionCooldownSeconds: Math.max(0, parseInteger(process.env.AI_QUESTION_COOLDOWN_SECONDS, 20)),
      debugCooldownSeconds: Math.max(0, parseInteger(process.env.DEBUG_COOLDOWN_SECONDS, 10)),
      reloadCooldownSeconds: Math.max(0, parseInteger(process.env.RELOAD_COOLDOWN_SECONDS, 30)),
      rateLimitAuditCooldownSeconds: Math.max(
        0,
        parseInteger(process.env.RATE_LIMIT_AUDIT_COOLDOWN_SECONDS, 30),
      ),
      queryMinLength: Math.max(1, parseInteger(process.env.QUERY_MIN_LENGTH, 2)),
      queryMaxLength: Math.max(5, parseInteger(process.env.QUERY_MAX_LENGTH, 80)),
      queryBlocklist: parseCsv(process.env.QUERY_BLOCKLIST).map((item) => item.toLowerCase()),
      queryAllowlist: parseCsv(process.env.QUERY_ALLOWLIST).map((item) => item.toLowerCase()),
      queryDebugErrors: parseBoolean(process.env.QUERY_DEBUG_ERRORS, false),
      auditLogPath: process.env.AUDIT_LOG_PATH?.trim() || "logs/cmibot-usage.jsonl",
      auditLogMaxBytes:
        Math.max(0, parseInteger(process.env.AUDIT_LOG_MAX_SIZE_MB, 10)) * 1024 * 1024,
      auditLogMaxFiles: Math.max(0, parseInteger(process.env.AUDIT_LOG_MAX_FILES, 5)),
    },
    formatDisplayPath(pluginId, relativePath) {
      const normalizedRelativePath = toDisplayRelativePath(relativePath);
      if (normalizedRelativePath.startsWith("data/")) {
        return normalizedRelativePath;
      }

      return path.posix.join(displayPathPrefix, normalizedRelativePath);
    },
  };
}

export function validateBotConfig(config) {
  if (
    !config?.discord ||
    !config.ai ||
    !config.search ||
    !config.security ||
    !config.versions ||
    !config.logging ||
    !config.metrics
  ) {
    throw new Error("Bot configuration is incomplete.");
  }
  requireConfigValue(config.discord.token, "DISCORD_TOKEN");
  requireConfigValue(config.discord.applicationId, "DISCORD_APPLICATION_ID");
  requireConfigValue(config.discord.guildId, "DISCORD_GUILD_ID");
  validatePluginConfiguration(config);
  validateDiscordRoutes(config);
  if (!config.discord.allowedChannelIds.length) {
    throw new Error("At least one DISCORD_ALLOWED_CHANNEL_IDS entry is required.");
  }
  if (!config.discord.testDefaultContext || !config.plugins[config.discord.testDefaultContext]) {
    throw new Error("DISCORD_TEST_DEFAULT_CONTEXT must point to a configured plugin context like cmi or jobs.");
  }
  if (!config.discord.allowedRoleIds.length) {
    throw new Error("Define ALLOWED_ROLE_IDS so the bot can guard command access.");
  }
  if (!config.discord.adminRoleIds.length) {
    throw new Error("Define ADMIN_ROLE_IDS so the bot can guard the reload command.");
  }
  if (config.ai.enabled && !config.discord.aiRoleIds.length) {
    throw new Error("Define AI_ROLE_IDS so the bot can guard AI-backed features.");
  }
  if (config.ai.externalProvidersEnabled) {
    throw new Error("AI_EXTERNAL_PROVIDERS_ENABLED must remain false in zero-cost local-only mode.");
  }
  if (config.ai.paidBudgetUsd !== 0) {
    throw new Error("AI_PAID_BUDGET_USD must remain exactly 0 in zero-cost local-only mode.");
  }
  if (config.ai.ollama.enabled) {
    if (!normalizeLoopbackOllamaBaseUrl(config.ai.ollama.baseUrl)) {
      throw new Error("OLLAMA_BASE_URL must use a loopback-only HTTP address.");
    }
    if (!isLocalOllamaModelName(config.ai.ollama.model)) {
      throw new Error("OLLAMA_MODEL must name a local, non-cloud Ollama model.");
    }
  }
  if (
    config.search.sourceLinksEnabled === true &&
    !normalizePublicGitHubRepositoryUrl(config.search.sourceRepositoryUrl)
  ) {
    throw new Error("SOURCE_REPOSITORY_URL must be a public HTTPS GitHub repository URL.");
  }

  validateRelativePath(config.versions.catalogPath, "VERSION_CATALOG_PATH");
  validateRelativePath(config.versions.statePath, "VERSION_STATE_PATH");
  validateRelativePath(config.search.synonymsPath, "SEARCH_SYNONYMS_PATH");
  validateRelativePath(config.ai.usageStatePath, "AI_USAGE_STATE_PATH");
  validateRelativePath(config.security.auditLogPath, "AUDIT_LOG_PATH");
  if (!Number.isSafeInteger(config.versions.checkIntervalMs) || config.versions.checkIntervalMs <= 0) {
    throw new Error("The version-check interval must be a positive integer.");
  }
  if (!Number.isSafeInteger(config.versions.requestTimeoutMs) || config.versions.requestTimeoutMs <= 0) {
    throw new Error("The version-check timeout must be a positive integer.");
  }
  if (!Number.isSafeInteger(config.logging.maxBytes) || config.logging.maxBytes <= 0) {
    throw new Error("The service log size limit must be a positive integer.");
  }
  if (!Number.isSafeInteger(config.logging.maxFiles) || config.logging.maxFiles <= 0) {
    throw new Error("The service log archive limit must be a positive integer.");
  }
  if (!Number.isSafeInteger(config.logging.minFreeBytes) || config.logging.minFreeBytes <= 0) {
    throw new Error("The service log disk reserve must be a positive integer.");
  }
  if (!Number.isSafeInteger(config.metrics.logIntervalMs) || config.metrics.logIntervalMs < 0) {
    throw new Error("The metrics log interval must be a non-negative integer.");
  }
}
