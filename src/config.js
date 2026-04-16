import path from "node:path";

function parseCsv(value) {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseInteger(value, fallback) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) ? parsed : fallback;
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

function requireValue(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
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
      include: parseCsv(configInclude),
      exclude: parseCsv(configExcludeEnv ?? configExcludeDefault),
    }),
    language: createProfile("language", {
      sourceType: "yaml",
      entryLabel: "YAML entries",
      statsFileLabel: "YAML locale files",
      include: parseCsv(languageInclude),
      exclude: parseCsv(languageExcludeEnv ?? languageExcludeDefault),
    }),
  };
}

function buildCmiProfiles() {
  return {
    config: createProfile("config", {
      sourceType: "yaml",
      entryLabel: "YAML entries",
      statsFileLabel: "YAML configuration files",
      include: parseCsv(
        process.env.LOOKUP_INCLUDE_GLOBS ??
          "CMIPlugin/CMI/config.yml,CMIPlugin/CMI/Settings/**/*.yml,CMILibPlugin/CMILib/config.yml",
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
      include: parseCsv(
        process.env.LANGLOOKUP_INCLUDE_GLOBS ??
          "CMIPlugin/CMI/Translations/**/Locale_EN.yml,CMILibPlugin/CMILib/Translations/**/*_EN.yml",
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
      include: parseCsv(process.env.PLACEHOLDER_INCLUDE_GLOBS ?? "CMIPlugin/data/placeholders.log"),
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
      include: parseCsv(process.env.COMMAND_INCLUDE_GLOBS ?? "CMIPlugin/data/commands.log"),
      exclude: parseCsv(process.env.COMMAND_EXCLUDE_GLOBS),
    }),
    permission: createProfile("permission", {
      sourceType: "log",
      entryLabel: "permission entries",
      statsFileLabel: "permission data files",
      referenceLabel: "permissions",
      referenceUrl: "https://www.zrips.net/cmi/permissions/",
      parserType: "permissionMixed",
      include: parseCsv(
        process.env.PERMISSION_INCLUDE_GLOBS ?? "CMIPlugin/data/permissions.log,CMIPlugin/data/cmdperms.log",
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
      include: parseCsv(
        process.env.JOBS_LOOKUP_INCLUDE_GLOBS ?? "JobsPlugin/generalConfig.yml,CMILibPlugin/CMILib/config.yml",
      ),
      exclude: parseCsv(process.env.JOBS_LOOKUP_EXCLUDE_GLOBS),
    }),
    language: createProfile("language", {
      sourceType: "yaml",
      entryLabel: "YAML entries",
      statsFileLabel: "YAML locale files",
      include: parseCsv(
        process.env.JOBS_LANGUAGE_INCLUDE_GLOBS ??
          "JobsPlugin/locale/messages_en.yml,JobsPlugin/TranslatableWords/Words_en.yml,CMILibPlugin/CMILib/Translations/**/*_EN.yml",
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
      include: parseCsv(process.env.JOBS_PLACEHOLDER_INCLUDE_GLOBS ?? "JobsPlugin/data/placeholders.log"),
      exclude: parseCsv(process.env.JOBS_PLACEHOLDER_EXCLUDE_GLOBS),
    }),
    command: createProfile("command", {
      sourceType: "log",
      entryLabel: "command entries",
      statsFileLabel: "command data files",
      referenceLabel: "commands",
      referenceUrl: "https://www.zrips.net/jobs/jobs-commands/",
      parserType: "delimited",
      include: parseCsv(process.env.JOBS_COMMAND_INCLUDE_GLOBS ?? "JobsPlugin/data/commands.log"),
      exclude: parseCsv(process.env.JOBS_COMMAND_EXCLUDE_GLOBS),
    }),
    permission: createProfile("permission", {
      sourceType: "log",
      entryLabel: "permission entries",
      statsFileLabel: "permission data files",
      referenceLabel: "permissions",
      referenceUrl: "https://www.zrips.net/jobs/permissions/",
      parserType: "permissionMixed",
      include: parseCsv(process.env.JOBS_PERMISSION_INCLUDE_GLOBS ?? "JobsPlugin/data/permissions.log"),
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
        process.env.SVIS_LOOKUP_INCLUDE_GLOBS ?? "SVISPlugin/config.yml,CMILibPlugin/CMILib/config.yml",
      configExcludeEnv: process.env.SVIS_LOOKUP_EXCLUDE_GLOBS,
      languageInclude:
        process.env.SVIS_LANGUAGE_INCLUDE_GLOBS ??
        "SVISPlugin/Locale_EN.yml,CMILibPlugin/CMILib/Translations/**/*_EN.yml",
      languageExcludeEnv: process.env.SVIS_LANGUAGE_EXCLUDE_GLOBS,
    }),
    command: createProfile("command", {
      sourceType: "log",
      entryLabel: "command entries",
      statsFileLabel: "command data files",
      referenceLabel: "commands",
      referenceUrl: "https://www.zrips.net/svis/",
      parserType: "delimited",
      include: parseCsv(process.env.SVIS_COMMAND_INCLUDE_GLOBS ?? "SVISPlugin/data/commands.log"),
      exclude: parseCsv(process.env.SVIS_COMMAND_EXCLUDE_GLOBS),
    }),
    permission: createProfile("permission", {
      sourceType: "log",
      entryLabel: "permission entries",
      statsFileLabel: "permission data files",
      referenceLabel: "permissions",
      referenceUrl: "https://www.zrips.net/svis/",
      parserType: "permissionList",
      include: parseCsv(process.env.SVIS_PERMISSION_INCLUDE_GLOBS ?? "SVISPlugin/data/permissions.log"),
      exclude: parseCsv(process.env.SVIS_PERMISSION_EXCLUDE_GLOBS),
    }),
  };
}

function buildMfmProfiles() {
  return buildSimplePluginProfiles({
    configInclude:
      process.env.MFM_LOOKUP_INCLUDE_GLOBS ?? "MFMPlugin/config.yml,CMILibPlugin/CMILib/config.yml",
    configExcludeEnv: process.env.MFM_LOOKUP_EXCLUDE_GLOBS,
    languageInclude:
      process.env.MFM_LANGUAGE_INCLUDE_GLOBS ??
      "MFMPlugin/Locale/Locale_EN.yml,CMILibPlugin/CMILib/Translations/**/*_EN.yml",
    languageExcludeEnv: process.env.MFM_LANGUAGE_EXCLUDE_GLOBS,
  });
}

function buildTrymeProfiles() {
  return buildSimplePluginProfiles({
    configInclude:
      process.env.TRYME_LOOKUP_INCLUDE_GLOBS ?? "TryMePlugin/config.yml,CMILibPlugin/CMILib/config.yml",
    configExcludeEnv: process.env.TRYME_LOOKUP_EXCLUDE_GLOBS,
    languageInclude:
      process.env.TRYME_LANGUAGE_INCLUDE_GLOBS ??
      "TryMePlugin/Locale_EN.yml,CMILibPlugin/CMILib/Translations/**/*_EN.yml",
    languageExcludeEnv: process.env.TRYME_LANGUAGE_EXCLUDE_GLOBS,
  });
}

function buildTrademeProfiles() {
  return buildSimplePluginProfiles({
    configInclude:
      process.env.TRADEME_LOOKUP_INCLUDE_GLOBS ?? "TradeMePlugin/config.yml,CMILibPlugin/CMILib/config.yml",
    configExcludeEnv: process.env.TRADEME_LOOKUP_EXCLUDE_GLOBS,
    languageInclude:
      process.env.TRADEME_LANGUAGE_INCLUDE_GLOBS ??
      "TradeMePlugin/Locale_EN.yml,CMILibPlugin/CMILib/Translations/**/*_EN.yml",
    languageExcludeEnv: process.env.TRADEME_LANGUAGE_EXCLUDE_GLOBS,
  });
}

function buildResidenceProfiles() {
  return {
    placeholder: createProfile("placeholder", {
      sourceType: "log",
      entryLabel: "placeholder entries",
      statsFileLabel: "placeholder data files",
      referenceLabel: "placeholders",
      referenceUrl: "https://www.zrips.net/residence/placeholders/",
      parserType: "delimited",
      codeLanguage: "yml",
      include: parseCsv(process.env.RESIDENCE_PLACEHOLDER_INCLUDE_GLOBS ?? "ResidencePlugin/data/placeholders.log"),
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
      include: parseCsv(process.env.RESIDENCE_COMMAND_INCLUDE_GLOBS ?? "ResidencePlugin/data/commands.log"),
      exclude: parseCsv(process.env.RESIDENCE_COMMAND_EXCLUDE_GLOBS),
    }),
    permission: createProfile("permission", {
      sourceType: "log",
      entryLabel: "permission entries",
      statsFileLabel: "permission data files",
      referenceLabel: "permissions",
      referenceUrl: "https://www.zrips.net/residence/permissions/",
      parserType: "permissionList",
      include: parseCsv(process.env.RESIDENCE_PERMISSION_INCLUDE_GLOBS ?? "ResidencePlugin/data/permissions.log"),
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
    debug: "ready",
    reload: "ready",
    ...overrides,
  };
}

export function loadConfig() {
  const workspaceRoot = process.cwd();
  const displayPathPrefix = process.env.DISPLAY_PATH_PREFIX?.trim() || "~/plugins";
  const cmiProfiles = buildCmiProfiles();
  const jobsProfiles = buildJobsProfiles();
  const svisProfiles = buildSvisProfiles();
  const mfmProfiles = buildMfmProfiles();
  const trymeProfiles = buildTrymeProfiles();
  const trademeProfiles = buildTrademeProfiles();
  const residenceProfiles = buildResidenceProfiles();
  const configuredTestChannelIds = parseCsv(process.env.DISCORD_TEST_CHANNEL_IDS);
  const fallbackLegacyTestChannelIds = parseCsv(process.env.DISCORD_CMI_TEST_CHANNEL_IDS);
  const testChannelIds = configuredTestChannelIds.length ? configuredTestChannelIds : fallbackLegacyTestChannelIds;
  const testDefaultContext = process.env.DISCORD_TEST_DEFAULT_CONTEXT?.trim().toLowerCase() || "cmi";
  const pluginChannelIds = {
    cmi: parseCsv(process.env.DISCORD_CMI_CHANNEL_IDS),
    jobs: parseCsv(process.env.DISCORD_JOBS_CHANNEL_IDS),
    svis: parseCsv(process.env.DISCORD_SVIS_CHANNEL_IDS),
    mfm: parseCsv(process.env.DISCORD_MFM_CHANNEL_IDS),
    tryme: parseCsv(process.env.DISCORD_TRYME_CHANNEL_IDS),
    trademe: parseCsv(process.env.DISCORD_TRADEME_CHANNEL_IDS),
    residence: parseCsv(process.env.DISCORD_RESIDENCE_CHANNEL_IDS),
  };

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
      aiRoleIds: parseCsv(process.env.AI_ROLE_IDS ?? process.env.ADMIN_ROLE_IDS),
    },
    openai: {
      enabled: parseBoolean(process.env.OPENAI_ENABLED, false),
      apiKey: process.env.OPENAI_API_KEY?.trim() || "",
      model: process.env.OPENAI_MODEL?.trim() || "gpt-5-mini",
    },
    search: {
      defaultResultLimit: Math.max(1, Math.min(15, parseInteger(process.env.DEFAULT_RESULT_LIMIT, 3))),
      maxResultLimit: 15,
    },
    sharedDebugRoots: [
      {
        label: "Shared CMILib",
        directories: ["CMILibPlugin"],
      },
    ],
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
          command: "unsupported",
          permission: "unsupported",
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
          placeholder: "unsupported",
          material: "unsupported",
          command: "unsupported",
          permission: "unsupported",
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
          placeholder: "unsupported",
          material: "unsupported",
          command: "unsupported",
          permission: "unsupported",
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
          config: "unsupported",
          language: "unsupported",
          placeholder: "ready",
          material: "unsupported",
          command: "ready",
          permission: "ready",
          faq: "unsupported",
          tabcomplete: "unsupported",
        }),
      },
    },
    security: {
      lookupCooldownSeconds: Math.max(0, parseInteger(process.env.LOOKUP_COOLDOWN_SECONDS, 3)),
      summaryCooldownSeconds: Math.max(0, parseInteger(process.env.SUMMARY_COOLDOWN_SECONDS, 15)),
      queryMinLength: Math.max(1, parseInteger(process.env.QUERY_MIN_LENGTH, 2)),
      queryMaxLength: Math.max(5, parseInteger(process.env.QUERY_MAX_LENGTH, 80)),
      queryBlocklist: parseCsv(process.env.QUERY_BLOCKLIST).map((item) => item.toLowerCase()),
      queryAllowlist: parseCsv(process.env.QUERY_ALLOWLIST).map((item) => item.toLowerCase()),
      queryDebugErrors: parseBoolean(process.env.QUERY_DEBUG_ERRORS, false),
      auditLogPath: process.env.AUDIT_LOG_PATH?.trim() || "logs/cmibot-usage.jsonl",
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
  requireValue("DISCORD_TOKEN");
  requireValue("DISCORD_APPLICATION_ID");
  requireValue("DISCORD_GUILD_ID");
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
  if (!config.discord.aiRoleIds.length) {
    throw new Error("Define AI_ROLE_IDS so the bot can guard AI-backed features.");
  }
}
