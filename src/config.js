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

function createProfile(name, overrides = {}) {
  return {
    name,
    displayName: name,
    sourceType: "yaml",
    entryLabel: "entries",
    statsFileLabel: "files",
    include: [],
    exclude: [],
    ...overrides,
  };
}

function buildCmiProfiles() {
  return {
    config: createProfile("config", {
      sourceType: "yaml",
      entryLabel: "YAML entries",
      statsFileLabel: "YAML configuration files",
      include: parseCsv(process.env.LOOKUP_INCLUDE_GLOBS ?? "CMI/config.yml,CMI/Settings/**/*.yml,CMILib/config.yml"),
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
        process.env.LANGLOOKUP_INCLUDE_GLOBS ?? "CMI/Translations/**/Locale_EN.yml,CMILib/Translations/**/*_EN.yml",
      ),
      exclude: parseCsv(process.env.LANGLOOKUP_EXCLUDE_GLOBS),
    }),
    placeholder: createProfile("placeholder", {
      sourceType: "log",
      entryLabel: "placeholder entries",
      statsFileLabel: "placeholder data files",
      parserType: "commentBlocks",
      codeLanguage: "yml",
      include: parseCsv(process.env.PLACEHOLDER_INCLUDE_GLOBS ?? "data/placeholders.log"),
      exclude: parseCsv(process.env.PLACEHOLDER_EXCLUDE_GLOBS),
    }),
    material: createProfile("material", {
      sourceType: "log",
      entryLabel: "material entries",
      statsFileLabel: "material data files",
      parserType: "tokenList",
      defaultResultLimit: 25,
      maxResultLimit: 25,
      include: parseCsv(process.env.MATERIAL_INCLUDE_GLOBS ?? "data/materials.log"),
      exclude: parseCsv(process.env.MATERIAL_EXCLUDE_GLOBS),
    }),
    command: createProfile("command", {
      sourceType: "log",
      entryLabel: "command entries",
      statsFileLabel: "command data files",
      parserType: "delimited",
      include: parseCsv(process.env.COMMAND_INCLUDE_GLOBS ?? "data/commands.log"),
      exclude: parseCsv(process.env.COMMAND_EXCLUDE_GLOBS),
    }),
    permission: createProfile("permission", {
      sourceType: "log",
      entryLabel: "permission entries",
      statsFileLabel: "permission data files",
      parserType: "permissionMixed",
      include: parseCsv(process.env.PERMISSION_INCLUDE_GLOBS ?? "data/permissions.log,data/cmdperms.log"),
      exclude: parseCsv(process.env.PERMISSION_EXCLUDE_GLOBS),
    }),
    faq: createProfile("faq", {
      sourceType: "log",
      entryLabel: "FAQ entries",
      statsFileLabel: "FAQ data files",
      parserType: "commentBlocks",
      include: parseCsv(process.env.FAQ_INCLUDE_GLOBS ?? "data/faq.log"),
      exclude: parseCsv(process.env.FAQ_EXCLUDE_GLOBS),
    }),
    tabcomplete: createProfile("tabcomplete", {
      sourceType: "log",
      entryLabel: "tab-complete entries",
      statsFileLabel: "tab-complete data files",
      parserType: "delimited",
      include: parseCsv(process.env.TABCOMPLETE_INCLUDE_GLOBS ?? "data/tabcompletes.log"),
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
      include: parseCsv(process.env.JOBS_LOOKUP_INCLUDE_GLOBS),
      exclude: parseCsv(process.env.JOBS_LOOKUP_EXCLUDE_GLOBS),
    }),
    language: createProfile("language", {
      sourceType: "yaml",
      entryLabel: "YAML entries",
      statsFileLabel: "YAML locale files",
      include: parseCsv(process.env.JOBS_LANGUAGE_INCLUDE_GLOBS),
      exclude: parseCsv(process.env.JOBS_LANGUAGE_EXCLUDE_GLOBS),
    }),
    placeholder: createProfile("placeholder", {
      sourceType: "log",
      entryLabel: "placeholder entries",
      statsFileLabel: "placeholder data files",
      parserType: "commentBlocks",
      codeLanguage: "yml",
      include: parseCsv(process.env.JOBS_PLACEHOLDER_INCLUDE_GLOBS),
      exclude: parseCsv(process.env.JOBS_PLACEHOLDER_EXCLUDE_GLOBS),
    }),
    command: createProfile("command", {
      sourceType: "log",
      entryLabel: "command entries",
      statsFileLabel: "command data files",
      parserType: "delimited",
      include: parseCsv(process.env.JOBS_COMMAND_INCLUDE_GLOBS),
      exclude: parseCsv(process.env.JOBS_COMMAND_EXCLUDE_GLOBS),
    }),
    permission: createProfile("permission", {
      sourceType: "log",
      entryLabel: "permission entries",
      statsFileLabel: "permission data files",
      parserType: "permissionMixed",
      include: parseCsv(process.env.JOBS_PERMISSION_INCLUDE_GLOBS),
      exclude: parseCsv(process.env.JOBS_PERMISSION_EXCLUDE_GLOBS),
    }),
    faq: createProfile("faq", {
      sourceType: "log",
      entryLabel: "FAQ entries",
      statsFileLabel: "FAQ data files",
      parserType: "commentBlocks",
      include: parseCsv(process.env.JOBS_FAQ_INCLUDE_GLOBS),
      exclude: parseCsv(process.env.JOBS_FAQ_EXCLUDE_GLOBS),
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
  const configuredTestChannelIds = parseCsv(process.env.DISCORD_TEST_CHANNEL_IDS);
  const fallbackLegacyTestChannelIds = parseCsv(process.env.DISCORD_CMI_TEST_CHANNEL_IDS);
  const testChannelIds = configuredTestChannelIds.length ? configuredTestChannelIds : fallbackLegacyTestChannelIds;
  const testDefaultContext = process.env.DISCORD_TEST_DEFAULT_CONTEXT?.trim().toLowerCase() || "cmi";
  const pluginChannelIds = {
    cmi: parseCsv(process.env.DISCORD_CMI_CHANNEL_IDS),
    jobs: parseCsv(process.env.DISCORD_JOBS_CHANNEL_IDS),
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
    plugins: {
      cmi: {
        id: "cmi",
        label: "CMI",
        profiles: cmiProfiles,
        commandAvailability: buildPluginCommandAvailability(),
      },
      jobs: {
        id: "jobs",
        label: "Jobs",
        profiles: jobsProfiles,
        commandAvailability: buildPluginCommandAvailability({
          config: "coming_soon",
          language: "coming_soon",
          placeholder: "coming_soon",
          material: "unsupported",
          command: "coming_soon",
          permission: "coming_soon",
          faq: "coming_soon",
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
      const normalizedRelativePath = toPosixPath(relativePath);
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
