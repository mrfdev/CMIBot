import { REST, Routes, SlashCommandBuilder } from "discord.js";
import {
  MATERIAL_MAX_RESULT_LIMIT,
  MAX_RESULT_LIMIT,
  PRIMARY_COMMAND_NAME,
} from "./constants.js";

function addCommonLookupOptions(
  subcommand,
  defaultResultLimit,
  { includeRelated = false, includeFileFilter = false, maxResultLimit = MAX_RESULT_LIMIT } = {},
) {
  let builder = subcommand
    .addStringOption((option) =>
      option.setName("keyword").setDescription("Keyword, phrase, or token to search for.").setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName("mode")
        .setDescription("Search mode. Defaults to exact.")
        .addChoices(
          { name: "exact", value: "exact" },
          { name: "whole", value: "whole" },
          { name: "broad", value: "broad" },
        ),
    )
    .addIntegerOption((option) =>
      option
        .setName("limit")
        .setDescription(`How many results to show. Default ${defaultResultLimit}.`)
        .setMinValue(1)
        .setMaxValue(maxResultLimit),
    );

  if (includeFileFilter) {
    builder = builder.addStringOption((option) =>
      option
        .setName("file")
        .setDescription("Optional indexed config file filter, like Chat.yml, config.yml, or a plugin-relative path."),
    );
  }

  if (includeRelated) {
    builder = builder.addBooleanOption((option) =>
      option
        .setName("related")
        .setDescription("Include up to two nearby related YAML entries. Defaults to false."),
    );
  }

  return builder.addBooleanOption((option) =>
    option.setName("summary").setDescription("Include an optional AI-generated summary. Defaults to false."),
  );
}

export function buildCommandTree(commandName, config) {
  const defaultResultLimit = config.search.defaultResultLimit;
  const materialDefaultLimit =
    config.plugins.cmi?.profiles.material?.defaultResultLimit ?? MATERIAL_MAX_RESULT_LIMIT;
  const debugContextChoices = [
    { name: "auto", value: "auto" },
    ...Object.values(config.plugins).map((plugin) => ({
      name: plugin.label.toLowerCase(),
      value: plugin.id,
    })),
  ];

  return new SlashCommandBuilder()
    .setName(commandName)
    .setDescription("Look up plugin config, locale, and indexed support data by keyword.")
    .addSubcommand((subcommand) =>
      subcommand.setName("help").setDescription("Show available commands and usage notes for this channel context."),
    )
    .addSubcommand((subcommand) =>
      addCommonLookupOptions(
        subcommand.setName("config").setDescription("Search indexed config files for the active plugin context."),
        defaultResultLimit,
        { includeRelated: true, includeFileFilter: true },
      ),
    )
    .addSubcommand((subcommand) =>
      addCommonLookupOptions(
        subcommand
          .setName("language")
          .setDescription("Search indexed English locale and translation YAML files for the active plugin context."),
        defaultResultLimit,
        { includeRelated: true },
      ),
    )
    .addSubcommand((subcommand) =>
      addCommonLookupOptions(
        subcommand.setName("lang").setDescription("Alias for the active context language search."),
        defaultResultLimit,
        { includeRelated: true },
      ),
    )
    .addSubcommand((subcommand) =>
      addCommonLookupOptions(
        subcommand.setName("placeholder").setDescription("Search indexed placeholder entries."),
        defaultResultLimit,
      ),
    )
    .addSubcommand((subcommand) =>
      addCommonLookupOptions(
        subcommand.setName("material").setDescription("Search indexed material names."),
        materialDefaultLimit,
        { maxResultLimit: MATERIAL_MAX_RESULT_LIMIT },
      ),
    )
    .addSubcommand((subcommand) =>
      addCommonLookupOptions(
        subcommand.setName("command").setDescription("Search indexed command usage entries."),
        defaultResultLimit,
      ),
    )
    .addSubcommand((subcommand) =>
      addCommonLookupOptions(
        subcommand.setName("cmd").setDescription("Alias for the indexed command usage search."),
        defaultResultLimit,
      ),
    )
    .addSubcommand((subcommand) =>
      addCommonLookupOptions(
        subcommand.setName("permission").setDescription("Search indexed permission entries."),
        defaultResultLimit,
      ),
    )
    .addSubcommand((subcommand) =>
      addCommonLookupOptions(
        subcommand.setName("perm").setDescription("Alias for the indexed permission search."),
        defaultResultLimit,
      ),
    )
    .addSubcommand((subcommand) =>
      addCommonLookupOptions(
        subcommand.setName("faq").setDescription("Search curated FAQ titles, links, and short notes."),
        defaultResultLimit,
      ),
    )
    .addSubcommand((subcommand) =>
      addCommonLookupOptions(
        subcommand.setName("tabcomplete").setDescription("Search indexed tab-complete token entries."),
        defaultResultLimit,
      ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("langstats")
        .setDescription("Show language-category stats for the active plugin context."),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("stats")
        .setDescription("Show cache totals and per-profile counts for the active plugin context."),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("latest")
        .setDescription("Show clean-snapshot and current upstream plugin versions.")
        .addStringOption((option) =>
          option
            .setName("scope")
            .setDescription("Show this channel context or every tracked resource and companion.")
            .addChoices(
              { name: "current context", value: "context" },
              { name: "all resources", value: "all" },
            ),
        )
        .addBooleanOption((option) =>
          option
            .setName("public")
            .setDescription("Post a compact upstream-only result publicly. Defaults to false."),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("debug")
        .setDescription("Show the current channel context and optionally override it in test channels.")
        .addStringOption((option) =>
          option
            .setName("context")
            .setDescription("For test channels only: set the active context or reset to auto.")
            .addChoices(...debugContextChoices),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand.setName("reload").setDescription("Reload the in-memory search cache for every plugin context."),
    )
    .toJSON();
}

export function buildCommandData(config) {
  return [buildCommandTree(PRIMARY_COMMAND_NAME, config)];
}

export async function registerCommands(config) {
  const rest = new REST({ version: "10" }).setToken(config.discord.token);
  const body = buildCommandData(config);

  await rest.put(Routes.applicationGuildCommands(config.discord.applicationId, config.discord.guildId), {
    body,
  });
}
