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

export function loadConfig() {
  const workspaceRoot = process.cwd();
  const displayPathPrefix = process.env.DISPLAY_PATH_PREFIX?.trim() || "~/plugins";

  return {
    workspaceRoot,
    displayPathPrefix,
    discord: {
      token: process.env.DISCORD_TOKEN?.trim() || "",
      applicationId: process.env.DISCORD_APPLICATION_ID?.trim() || "",
      guildId: process.env.DISCORD_GUILD_ID?.trim() || "",
      allowedChannelIds: parseCsv(process.env.DISCORD_ALLOWED_CHANNEL_IDS),
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
      profiles: {
        config: {
          name: "config",
          displayName: "config",
          sourceType: "yaml",
          entryLabel: "YAML entries",
          statsFileLabel: "YAML configuration files",
          include: parseCsv(
            process.env.LOOKUP_INCLUDE_GLOBS ?? "CMI/config.yml,CMI/Settings/**/*.yml,CMILib/config.yml",
          ),
          exclude: parseCsv(
            process.env.LOOKUP_EXCLUDE_GLOBS ??
              "**/Translations/**,**/DatabaseBackups/**,**/FileBackups/**,**/Logs/**,**/moneyLog/**,**/sellLogs/**",
          ),
        },
        language: {
          name: "language",
          displayName: "language",
          sourceType: "yaml",
          entryLabel: "YAML entries",
          statsFileLabel: "YAML locale files",
          include: parseCsv(
            process.env.LANGLOOKUP_INCLUDE_GLOBS ??
              "CMI/Translations/**/Locale_EN.yml,CMILib/Translations/**/*_EN.yml",
          ),
          exclude: parseCsv(process.env.LANGLOOKUP_EXCLUDE_GLOBS),
        },
        placeholder: {
          name: "placeholder",
          displayName: "placeholder",
          sourceType: "log",
          entryLabel: "placeholder entries",
          statsFileLabel: "placeholder data files",
          parserType: "commentBlocks",
          include: parseCsv(process.env.PLACEHOLDER_INCLUDE_GLOBS ?? "data/placeholders.log"),
          exclude: parseCsv(process.env.PLACEHOLDER_EXCLUDE_GLOBS),
        },
        material: {
          name: "material",
          displayName: "material",
          sourceType: "log",
          entryLabel: "material entries",
          statsFileLabel: "material data files",
          parserType: "tokenList",
          defaultResultLimit: 25,
          maxResultLimit: 25,
          include: parseCsv(process.env.MATERIAL_INCLUDE_GLOBS ?? "data/materials.log"),
          exclude: parseCsv(process.env.MATERIAL_EXCLUDE_GLOBS),
        },
        command: {
          name: "command",
          displayName: "command",
          sourceType: "log",
          entryLabel: "command entries",
          statsFileLabel: "command data files",
          parserType: "delimited",
          include: parseCsv(process.env.COMMAND_INCLUDE_GLOBS ?? "data/commands.log"),
          exclude: parseCsv(process.env.COMMAND_EXCLUDE_GLOBS),
        },
        permission: {
          name: "permission",
          displayName: "permission",
          sourceType: "log",
          entryLabel: "permission entries",
          statsFileLabel: "permission data files",
          parserType: "permissionMixed",
          include: parseCsv(process.env.PERMISSION_INCLUDE_GLOBS ?? "data/permissions.log,data/cmdperms.log"),
          exclude: parseCsv(process.env.PERMISSION_EXCLUDE_GLOBS),
        },
        faq: {
          name: "faq",
          displayName: "faq",
          sourceType: "log",
          entryLabel: "FAQ entries",
          statsFileLabel: "FAQ data files",
          parserType: "commentBlocks",
          include: parseCsv(process.env.FAQ_INCLUDE_GLOBS ?? "data/faq.log"),
          exclude: parseCsv(process.env.FAQ_EXCLUDE_GLOBS),
        },
        tabcomplete: {
          name: "tabcomplete",
          displayName: "tabcomplete",
          sourceType: "log",
          entryLabel: "tab-complete entries",
          statsFileLabel: "tab-complete data files",
          parserType: "delimited",
          include: parseCsv(process.env.TABCOMPLETE_INCLUDE_GLOBS ?? "data/tabcompletes.log"),
          exclude: parseCsv(process.env.TABCOMPLETE_EXCLUDE_GLOBS),
        },
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
    formatDisplayPath(relativePath) {
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
