function variable(name, description, options = {}) {
  return {
    name,
    description,
    type: options.type ?? "string",
    sensitivity: options.sensitivity ?? "public",
    required: options.required ?? false,
    defaultValue: options.defaultValue ?? "",
    exampleValue: options.exampleValue ?? options.defaultValue ?? "",
    condition: options.condition ?? "",
    includeInExample: options.includeInExample ?? true,
    deprecated: options.deprecated ?? false,
  };
}

function profile(id, sourceType, includeVariable, excludeVariable, includeDefault, excludeDefault = "") {
  return {
    id,
    sourceType,
    includeVariable,
    excludeVariable,
    includeDefault,
    excludeDefault,
  };
}

export const pluginProfileMetadata = Object.freeze([
  {
    id: "cmilib",
    label: "Shared CMILib",
    shared: true,
    profiles: [
      profile(
        "config",
        "yaml",
        "CMILIB_LOOKUP_INCLUDE_GLOBS",
        "CMILIB_LOOKUP_EXCLUDE_GLOBS",
        "CMILibPlugin/CMILib/config.yml",
      ),
      profile(
        "language",
        "yaml",
        "CMILIB_LANGUAGE_INCLUDE_GLOBS",
        "CMILIB_LANGUAGE_EXCLUDE_GLOBS",
        "CMILibPlugin/CMILib/Translations/**/*_EN.yml",
      ),
      profile(
        "placeholder",
        "log",
        "CMILIB_PLACEHOLDER_INCLUDE_GLOBS",
        "CMILIB_PLACEHOLDER_EXCLUDE_GLOBS",
        "CMILibPlugin/data/generated-placeholders.log",
      ),
    ],
  },
  {
    id: "cmi",
    label: "CMI",
    profiles: [
      profile(
        "config",
        "yaml",
        "LOOKUP_INCLUDE_GLOBS",
        "LOOKUP_EXCLUDE_GLOBS",
        "CMIPlugin/CMI/config.yml,CMIPlugin/CMI/Settings/**/*.yml",
        "**/Translations/**,**/DatabaseBackups/**,**/FileBackups/**,**/Logs/**,**/moneyLog/**,**/sellLogs/**",
      ),
      profile(
        "language",
        "yaml",
        "LANGLOOKUP_INCLUDE_GLOBS",
        "LANGLOOKUP_EXCLUDE_GLOBS",
        "CMIPlugin/CMI/Translations/**/Locale_EN.yml",
      ),
      profile(
        "placeholder",
        "log",
        "PLACEHOLDER_INCLUDE_GLOBS",
        "PLACEHOLDER_EXCLUDE_GLOBS",
        "CMIPlugin/data/placeholders.log,CMIPlugin/data/generated-placeholders.log",
      ),
      profile(
        "material",
        "log",
        "MATERIAL_INCLUDE_GLOBS",
        "MATERIAL_EXCLUDE_GLOBS",
        "CMIPlugin/data/materials.log",
      ),
      profile(
        "command",
        "log",
        "COMMAND_INCLUDE_GLOBS",
        "COMMAND_EXCLUDE_GLOBS",
        "CMIPlugin/data/commands.log,CMIPlugin/data/generated-commands.log",
      ),
      profile(
        "permission",
        "log",
        "PERMISSION_INCLUDE_GLOBS",
        "PERMISSION_EXCLUDE_GLOBS",
        "CMIPlugin/data/permissions.log,CMIPlugin/data/cmdperms.log,CMIPlugin/data/generated-permissions.log",
      ),
      profile("faq", "log", "FAQ_INCLUDE_GLOBS", "FAQ_EXCLUDE_GLOBS", "CMIPlugin/data/faq.log"),
      profile(
        "tabcomplete",
        "log",
        "TABCOMPLETE_INCLUDE_GLOBS",
        "TABCOMPLETE_EXCLUDE_GLOBS",
        "CMIPlugin/data/tabcompletes.log",
      ),
    ],
  },
  {
    id: "jobs",
    label: "Jobs",
    profiles: [
      profile(
        "config",
        "yaml",
        "JOBS_LOOKUP_INCLUDE_GLOBS",
        "JOBS_LOOKUP_EXCLUDE_GLOBS",
        "JobsPlugin/*.yml,JobsPlugin/jobs/**/*.yml",
        "JobsPlugin/locale/**,JobsPlugin/TranslatableWords/**,JobsPlugin/data/**,JobsPlugin/Signs.yml,JobsPlugin/activeBoosts.yml,JobsPlugin/blockOwnerShips.yml",
      ),
      profile(
        "language",
        "yaml",
        "JOBS_LANGUAGE_INCLUDE_GLOBS",
        "JOBS_LANGUAGE_EXCLUDE_GLOBS",
        "JobsPlugin/locale/messages_en.yml,JobsPlugin/TranslatableWords/Words_en.yml",
      ),
      profile(
        "placeholder",
        "log",
        "JOBS_PLACEHOLDER_INCLUDE_GLOBS",
        "JOBS_PLACEHOLDER_EXCLUDE_GLOBS",
        "JobsPlugin/data/placeholders.log,JobsPlugin/data/generated-placeholders.log",
      ),
      profile(
        "command",
        "log",
        "JOBS_COMMAND_INCLUDE_GLOBS",
        "JOBS_COMMAND_EXCLUDE_GLOBS",
        "JobsPlugin/data/commands.log,JobsPlugin/data/generated-commands.log",
      ),
      profile(
        "permission",
        "log",
        "JOBS_PERMISSION_INCLUDE_GLOBS",
        "JOBS_PERMISSION_EXCLUDE_GLOBS",
        "JobsPlugin/data/permissions.log,JobsPlugin/data/generated-permissions.log",
      ),
      profile(
        "faq",
        "log",
        "JOBS_FAQ_INCLUDE_GLOBS",
        "JOBS_FAQ_EXCLUDE_GLOBS",
        "JobsPlugin/data/faq.log,JobsPlugin/data/faq/*.md",
      ),
    ],
  },
  {
    id: "svis",
    label: "SVIS",
    profiles: [
      profile("config", "yaml", "SVIS_LOOKUP_INCLUDE_GLOBS", "SVIS_LOOKUP_EXCLUDE_GLOBS", "SVISPlugin/config.yml"),
      profile(
        "language",
        "yaml",
        "SVIS_LANGUAGE_INCLUDE_GLOBS",
        "SVIS_LANGUAGE_EXCLUDE_GLOBS",
        "SVISPlugin/Locale_EN.yml",
      ),
      profile(
        "command",
        "log",
        "SVIS_COMMAND_INCLUDE_GLOBS",
        "SVIS_COMMAND_EXCLUDE_GLOBS",
        "SVISPlugin/data/commands.log,SVISPlugin/data/generated-commands.log",
      ),
      profile(
        "permission",
        "log",
        "SVIS_PERMISSION_INCLUDE_GLOBS",
        "SVIS_PERMISSION_EXCLUDE_GLOBS",
        "SVISPlugin/data/permissions.log,SVISPlugin/data/generated-permissions.log",
      ),
    ],
  },
  {
    id: "residence",
    label: "Residence",
    profiles: [
      profile(
        "config",
        "yaml",
        "RESIDENCE_LOOKUP_INCLUDE_GLOBS",
        "RESIDENCE_LOOKUP_EXCLUDE_GLOBS",
        "ResidencePlugin/config.yml,ResidencePlugin/groups.yml,ResidencePlugin/flags.yml,ResidencePlugin/ShopVotes.yml",
      ),
      profile(
        "language",
        "yaml",
        "RESIDENCE_LANGUAGE_INCLUDE_GLOBS",
        "RESIDENCE_LANGUAGE_EXCLUDE_GLOBS",
        "ResidencePlugin/Language/English.yml",
      ),
      profile(
        "placeholder",
        "log",
        "RESIDENCE_PLACEHOLDER_INCLUDE_GLOBS",
        "RESIDENCE_PLACEHOLDER_EXCLUDE_GLOBS",
        "ResidencePlugin/data/placeholders.log,ResidencePlugin/data/generated-placeholders.log",
      ),
      profile(
        "command",
        "log",
        "RESIDENCE_COMMAND_INCLUDE_GLOBS",
        "RESIDENCE_COMMAND_EXCLUDE_GLOBS",
        "ResidencePlugin/data/commands.log,ResidencePlugin/data/generated-commands.log",
      ),
      profile(
        "permission",
        "log",
        "RESIDENCE_PERMISSION_INCLUDE_GLOBS",
        "RESIDENCE_PERMISSION_EXCLUDE_GLOBS",
        "ResidencePlugin/data/permissions.log,ResidencePlugin/data/generated-permissions.log",
      ),
    ],
  },
  {
    id: "mfm",
    label: "MFM",
    profiles: [
      profile("config", "yaml", "MFM_LOOKUP_INCLUDE_GLOBS", "MFM_LOOKUP_EXCLUDE_GLOBS", "MFMPlugin/config.yml"),
      profile(
        "language",
        "yaml",
        "MFM_LANGUAGE_INCLUDE_GLOBS",
        "MFM_LANGUAGE_EXCLUDE_GLOBS",
        "MFMPlugin/Locale/Locale_EN.yml",
      ),
      profile(
        "command",
        "log",
        "MFM_COMMAND_INCLUDE_GLOBS",
        "MFM_COMMAND_EXCLUDE_GLOBS",
        "MFMPlugin/data/generated-commands.log",
      ),
      profile(
        "permission",
        "log",
        "MFM_PERMISSION_INCLUDE_GLOBS",
        "MFM_PERMISSION_EXCLUDE_GLOBS",
        "MFMPlugin/data/generated-permissions.log",
      ),
    ],
  },
  {
    id: "tryme",
    label: "TryMe",
    profiles: [
      profile(
        "config",
        "yaml",
        "TRYME_LOOKUP_INCLUDE_GLOBS",
        "TRYME_LOOKUP_EXCLUDE_GLOBS",
        "TryMePlugin/*.yml",
        "TryMePlugin/Locale_EN.yml,TryMePlugin/Signs.yml",
      ),
      profile(
        "language",
        "yaml",
        "TRYME_LANGUAGE_INCLUDE_GLOBS",
        "TRYME_LANGUAGE_EXCLUDE_GLOBS",
        "TryMePlugin/Locale_EN.yml",
      ),
      profile(
        "placeholder",
        "log",
        "TRYME_PLACEHOLDER_INCLUDE_GLOBS",
        "TRYME_PLACEHOLDER_EXCLUDE_GLOBS",
        "TryMePlugin/data/generated-placeholders.log",
      ),
      profile(
        "command",
        "log",
        "TRYME_COMMAND_INCLUDE_GLOBS",
        "TRYME_COMMAND_EXCLUDE_GLOBS",
        "TryMePlugin/data/generated-commands.log",
      ),
      profile(
        "permission",
        "log",
        "TRYME_PERMISSION_INCLUDE_GLOBS",
        "TRYME_PERMISSION_EXCLUDE_GLOBS",
        "TryMePlugin/data/generated-permissions.log",
      ),
    ],
  },
  {
    id: "trademe",
    label: "TradeMe",
    profiles: [
      profile("config", "yaml", "TRADEME_LOOKUP_INCLUDE_GLOBS", "TRADEME_LOOKUP_EXCLUDE_GLOBS", "TradeMePlugin/config.yml"),
      profile(
        "language",
        "yaml",
        "TRADEME_LANGUAGE_INCLUDE_GLOBS",
        "TRADEME_LANGUAGE_EXCLUDE_GLOBS",
        "TradeMePlugin/Locale_EN.yml",
      ),
      profile(
        "placeholder",
        "log",
        "TRADEME_PLACEHOLDER_INCLUDE_GLOBS",
        "TRADEME_PLACEHOLDER_EXCLUDE_GLOBS",
        "TradeMePlugin/data/generated-placeholders.log",
      ),
      profile(
        "command",
        "log",
        "TRADEME_COMMAND_INCLUDE_GLOBS",
        "TRADEME_COMMAND_EXCLUDE_GLOBS",
        "TradeMePlugin/data/generated-commands.log",
      ),
      profile(
        "permission",
        "log",
        "TRADEME_PERMISSION_INCLUDE_GLOBS",
        "TRADEME_PERMISSION_EXCLUDE_GLOBS",
        "TradeMePlugin/data/generated-permissions.log",
      ),
    ],
  },
  {
    id: "bottledexp",
    label: "BottledExp",
    profiles: [
      profile(
        "config",
        "yaml",
        "BOTTLEDEXP_LOOKUP_INCLUDE_GLOBS",
        "BOTTLEDEXP_LOOKUP_EXCLUDE_GLOBS",
        "BottledExpPlugin/config.yml,BottledExpPlugin/recipes.yml",
      ),
      profile(
        "language",
        "yaml",
        "BOTTLEDEXP_LANGUAGE_INCLUDE_GLOBS",
        "BOTTLEDEXP_LANGUAGE_EXCLUDE_GLOBS",
        "BottledExpPlugin/Locale_EN.yml",
      ),
      profile(
        "command",
        "log",
        "BOTTLEDEXP_COMMAND_INCLUDE_GLOBS",
        "BOTTLEDEXP_COMMAND_EXCLUDE_GLOBS",
        "BottledExpPlugin/data/generated-commands.log",
      ),
      profile(
        "permission",
        "log",
        "BOTTLEDEXP_PERMISSION_INCLUDE_GLOBS",
        "BOTTLEDEXP_PERMISSION_EXCLUDE_GLOBS",
        "BottledExpPlugin/data/generated-permissions.log",
      ),
    ],
  },
]);

const discordVariables = [
  variable("DISCORD_TOKEN", "Discord bot token from the Developer Portal.", {
    type: "secret",
    sensitivity: "secret",
    required: true,
  }),
  variable("DISCORD_APPLICATION_ID", "Discord application/client ID.", {
    type: "discord-id",
    sensitivity: "private",
    required: true,
  }),
  variable("DISCORD_GUILD_ID", "Discord server ID to which the bot is locked.", {
    type: "discord-id",
    sensitivity: "private",
    required: true,
  }),
  variable("DISCORD_ALLOWED_CHANNEL_IDS", "Comma-separated allowlist of support and test channel IDs.", {
    type: "discord-id-list",
    sensitivity: "private",
    required: true,
  }),
  ...[
    ["DISCORD_CMI_CHANNEL_IDS", "CMI"],
    ["DISCORD_JOBS_CHANNEL_IDS", "Jobs"],
    ["DISCORD_SVIS_CHANNEL_IDS", "SVIS"],
    ["DISCORD_MFM_CHANNEL_IDS", "MFM"],
    ["DISCORD_TRYME_CHANNEL_IDS", "TryMe"],
    ["DISCORD_TRADEME_CHANNEL_IDS", "TradeMe"],
    ["DISCORD_RESIDENCE_CHANNEL_IDS", "Residence"],
    ["DISCORD_BOTTLEDEXP_CHANNEL_IDS", "BottledExp"],
  ].map(([name, label]) =>
    variable(name, `Comma-separated channel IDs routed to the ${label} context.`, {
      type: "discord-id-list",
      sensitivity: "private",
    }),
  ),
  variable("DISCORD_TEST_CHANNEL_IDS", "Comma-separated test channel IDs.", {
    type: "discord-id-list",
    sensitivity: "private",
  }),
  variable("DISCORD_CMI_TEST_CHANNEL_IDS", "Legacy fallback for test channel IDs.", {
    type: "discord-id-list",
    sensitivity: "private",
    includeInExample: false,
    deprecated: true,
  }),
  variable("DISCORD_TEST_DEFAULT_CONTEXT", "Plugin context used by test channels until overridden.", {
    defaultValue: "cmi",
  }),
  variable("ALLOWED_ROLE_IDS", "Comma-separated role IDs allowed to use lookup commands.", {
    type: "discord-id-list",
    sensitivity: "private",
    required: true,
  }),
  variable("ADMIN_ROLE_IDS", "Comma-separated role IDs allowed to use admin commands.", {
    type: "discord-id-list",
    sensitivity: "private",
    required: true,
  }),
  variable("AI_ROLE_IDS", "Comma-separated role IDs allowed to use AI-backed options.", {
    type: "discord-id-list",
    sensitivity: "private",
    condition: "Required when OPENAI_ENABLED=true; otherwise falls back to ADMIN_ROLE_IDS.",
  }),
];

const environmentSections = [
  {
    title: "Discord access and routing",
    description: "Identifiers are intentionally blank in generated examples.",
    variables: discordVariables,
  },
  {
    title: "AI",
    variables: [
      variable("OPENAI_ENABLED", "Hard switch for OpenAI-backed features.", {
        type: "boolean",
        defaultValue: "false",
      }),
      variable("OPENAI_API_KEY", "OpenAI API key.", {
        type: "secret",
        sensitivity: "secret",
        condition: "Required when OPENAI_ENABLED=true.",
      }),
      variable("OPENAI_MODEL", "OpenAI model used for reranking and summaries.", {
        defaultValue: "gpt-5-mini",
      }),
    ],
  },
  {
    title: "Search and display",
    variables: [
      variable("DISPLAY_PATH_PREFIX", "Prefix shown before repository-relative lookup paths.", {
        defaultValue: "~/plugins",
      }),
      variable("DEFAULT_RESULT_LIMIT", "Default number of lookup results.", {
        type: "integer",
        defaultValue: "3",
      }),
      variable("SEARCH_SYNONYMS_PATH", "Repository-relative path to plugin-scoped search synonyms.", {
        type: "relative-path",
        defaultValue: "data/search-synonyms.json",
      }),
    ],
  },
  {
    title: "Version checks",
    variables: [
      variable("VERSION_CATALOG_PATH", "Repository-relative clean-server version catalog.", {
        type: "relative-path",
        defaultValue: "data/versions.json",
      }),
      variable("VERSION_STATE_PATH", "Repository-relative persistent last-known upstream state.", {
        type: "relative-path",
        defaultValue: "logs/upstream-versions.json",
      }),
      variable("VERSION_CHECK_ENABLED", "Enable live upstream version checks.", {
        type: "boolean",
        defaultValue: "true",
      }),
      variable("VERSION_CHECK_INTERVAL_HOURS", "Hours between scheduled upstream checks.", {
        type: "integer",
        defaultValue: "12",
      }),
      variable("VERSION_CHECK_TIMEOUT_SECONDS", "Timeout for each upstream request.", {
        type: "integer",
        defaultValue: "8",
      }),
      variable("VERSION_CHECK_MAX_ATTEMPTS", "Maximum attempts for a temporary upstream failure.", {
        type: "integer",
        defaultValue: "3",
      }),
      variable("VERSION_CHECK_RETRY_BASE_MS", "Initial upstream retry delay in milliseconds.", {
        type: "integer",
        defaultValue: "250",
      }),
      variable("VERSION_CHECK_RETRY_MAX_MS", "Maximum upstream retry delay in milliseconds.", {
        type: "integer",
        defaultValue: "2000",
      }),
      variable(
        "VERSION_CHECK_CIRCUIT_FAILURE_THRESHOLD",
        "Consecutive failed refreshes before a resource circuit opens.",
        {
          type: "integer",
          defaultValue: "3",
        },
      ),
      variable(
        "VERSION_CHECK_CIRCUIT_COOLDOWN_SECONDS",
        "Cooldown before an open resource circuit permits a recovery probe.",
        {
          type: "integer",
          defaultValue: "300",
        },
      ),
      variable("PAPER_VERSION", "Paper version line checked upstream.", { defaultValue: "26.2" }),
      variable("PAPER_VERSION_CHANNELS", "Comma-separated accepted Paper release channels.", {
        type: "csv",
        defaultValue: "STABLE",
      }),
    ],
  },
  {
    title: "Rate limits and cooldowns",
    variables: [
      variable("COMMAND_USER_RATE_LIMIT", "Commands allowed per user in each rate window.", { type: "integer", defaultValue: "10" }),
      variable("COMMAND_CHANNEL_RATE_LIMIT", "Commands allowed per channel in each rate window.", { type: "integer", defaultValue: "30" }),
      variable("COMMAND_GLOBAL_RATE_LIMIT", "Commands allowed globally in each rate window.", { type: "integer", defaultValue: "100" }),
      variable("COMMAND_RATE_WINDOW_SECONDS", "Sliding command-rate window in seconds.", { type: "integer", defaultValue: "30" }),
      variable("LOOKUP_COOLDOWN_SECONDS", "Per-user lookup cooldown.", { type: "integer", defaultValue: "3" }),
      variable("SUMMARY_COOLDOWN_SECONDS", "Per-user AI summary cooldown.", { type: "integer", defaultValue: "15" }),
      variable("DEBUG_COOLDOWN_SECONDS", "Global admin debug cooldown.", { type: "integer", defaultValue: "10" }),
      variable("RELOAD_COOLDOWN_SECONDS", "Global admin reload cooldown.", { type: "integer", defaultValue: "30" }),
      variable("RATE_LIMIT_AUDIT_COOLDOWN_SECONDS", "Coalescing window for repeated rate-limit audit entries.", { type: "integer", defaultValue: "30" }),
    ],
  },
  {
    title: "Input safety",
    variables: [
      variable("QUERY_MIN_LENGTH", "Minimum normalized query length.", { type: "integer", defaultValue: "2" }),
      variable("QUERY_MAX_LENGTH", "Maximum normalized query length.", { type: "integer", defaultValue: "80" }),
      variable("QUERY_BLOCKLIST", "Comma-separated exact queries rejected as too broad.", {
        type: "csv",
        exampleValue: "a,an,and,for,from,in,of,on,or,the,to",
      }),
      variable("QUERY_ALLOWLIST", "Comma-separated short queries exempt from minimum length.", {
        type: "csv",
        exampleValue: "rt,rtp,tp,msg,r",
      }),
      variable("QUERY_DEBUG_ERRORS", "Expose detailed validation reasons to users.", { type: "boolean", defaultValue: "false" }),
    ],
  },
  {
    title: "Audit logging",
    variables: [
      variable("AUDIT_LOG_PATH", "Repository-relative JSONL usage-audit path.", { type: "relative-path", defaultValue: "logs/cmibot-usage.jsonl" }),
      variable("AUDIT_LOG_MAX_SIZE_MB", "Maximum active audit-log size before rotation.", { type: "integer", defaultValue: "10" }),
      variable("AUDIT_LOG_MAX_FILES", "Maximum retained audit-log archives.", { type: "integer", defaultValue: "5" }),
    ],
  },
  {
    title: "Bounded service logging",
    variables: [
      variable("SERVICE_LOG_MAX_SIZE_MB", "Maximum size of each active structured service-log stream.", { type: "integer", defaultValue: "10" }),
      variable("SERVICE_LOG_MAX_FILES", "Maximum archives retained for each service-log stream.", { type: "integer", defaultValue: "5" }),
      variable("SERVICE_LOG_MIN_FREE_MB", "Minimum free disk reserve below which service logs stop growing.", { type: "integer", defaultValue: "256" }),
    ],
  },
  {
    title: "Metrics",
    variables: [
      variable("METRICS_LOG_INTERVAL_MINUTES", "Interval for privacy-safe aggregate metrics snapshots; use 0 to disable periodic snapshots.", { type: "integer", defaultValue: "5" }),
    ],
  },
];

for (const plugin of pluginProfileMetadata) {
  environmentSections.push({
    title: `${plugin.label} profile scopes`,
    description: plugin.shared
      ? "Shared profiles are indexed once and composed into supporting plugin contexts."
      : "Include and exclude globs are always resolved inside the repository workspace.",
    pluginId: plugin.id,
    variables: plugin.profiles.flatMap((item) => [
      variable(item.includeVariable, `Comma-separated include globs for the ${item.id} profile.`, {
        type: "relative-glob-list",
        defaultValue: item.includeDefault,
      }),
      variable(item.excludeVariable, `Comma-separated exclude globs for the ${item.id} profile.`, {
        type: "relative-glob-list",
        defaultValue: item.excludeDefault,
      }),
    ]),
  });
}

export const configMetadata = Object.freeze({
  schemaVersion: 1,
  environmentSections: Object.freeze(environmentSections),
  pluginProfiles: pluginProfileMetadata,
});

export function getEnvironmentVariables(metadata = configMetadata) {
  return metadata.environmentSections.flatMap((section) => section.variables);
}
