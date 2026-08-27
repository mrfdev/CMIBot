import { isAiEnabled } from "../aiLoader.js";
import {
  MATERIAL_MAX_RESULT_LIMIT,
  MAX_RESULT_LIMIT,
  PRIMARY_COMMAND_NAME,
} from "./constants.js";
import { getCommandAvailability, getSearchCommandLabel, hasRole } from "./context.js";

export function formatHelpMessage(config, member, context, commandName) {
  const plugin = context.plugin;
  const canLookup = hasRole(member, { roleIds: config.discord.allowedRoleIds });
  const canReload = hasRole(member, { roleIds: config.discord.adminRoleIds });
  const canUseAi = hasRole(member, { roleIds: config.discord.aiRoleIds });
  const aiEnabled = isAiEnabled(config.openai);
  const prefix = `/${PRIMARY_COMMAND_NAME}`;
  const currentCommand = `/${commandName}`;
  const lines = ["### Lookup Help"];

  if (!plugin) {
    lines.push("This allowed channel does not map to a plugin context yet.");
    return lines.join("\n");
  }

  lines.push(`Current context: \`${plugin.label}\``);

  if (context.isTestChannel) {
    lines.push(
      `Test channel mode: \`${context.overridePluginId || "auto"}\`${context.overridePluginId ? " override active" : ""}`,
    );
  }

  lines.push("", "Available here:");
  lines.push(`- \`${prefix} help\` shows this help message`);

  const commandDescriptions = new Map([
    ["config", "searches indexed config files"],
    ["language", "searches indexed English locale files"],
    ["placeholder", "searches indexed placeholder entries"],
    ["material", "searches indexed material names"],
    ["command", "searches indexed command entries"],
    ["permission", "searches indexed permission entries"],
    ["faq", "searches curated FAQ entries"],
    ["tabcomplete", "searches exported tab-complete entries"],
  ]);

  const readyCommands = [...commandDescriptions.keys()].filter(
    (subcommand) => getCommandAvailability(plugin, subcommand) === "ready",
  );
  const comingSoonCommands = [...commandDescriptions.keys()].filter(
    (subcommand) => getCommandAvailability(plugin, subcommand) === "coming_soon",
  );
  const unsupportedCommands = [...commandDescriptions.keys()].filter(
    (subcommand) => getCommandAvailability(plugin, subcommand) === "unsupported",
  );

  for (const subcommand of readyCommands) {
    lines.push(`- ${getSearchCommandLabel(PRIMARY_COMMAND_NAME, subcommand)} ${commandDescriptions.get(subcommand)}`);
  }

  lines.push(`- \`${prefix} langstats\` shows language-category stats for this plugin context`);
  lines.push(`- \`${prefix} stats\` shows cache totals for this plugin context`);
  lines.push(`- \`${prefix} latest\` shows versions for this plugin and CMILib`);
  lines.push(`- \`${prefix} latest public:true\` publicly shows only the latest plugin and CMILib releases`);
  lines.push(`- \`${prefix} latest scope:all\` shows every tracked resource and CMI companion`);
  if (canReload) {
    lines.push(`- \`${prefix} health\` shows private service health and data freshness`);
    lines.push(`- \`${prefix} debug\` shows the current channel context and runtime diagnostics`);
    lines.push(`- \`${prefix} reload\` refreshes the cache for every plugin context`);
    lines.push(`- \`${prefix} reload plugin:current\` refreshes only this plugin context`);
    lines.push(`- \`${prefix} reload profile:config\` refreshes one profile in this context`);
  }

  if (comingSoonCommands.length) {
    lines.push("", `Still being worked on for ${plugin.label}:`);
    for (const subcommand of comingSoonCommands) {
      lines.push(`- ${getSearchCommandLabel(PRIMARY_COMMAND_NAME, subcommand)}`);
    }
  }

  if (unsupportedCommands.length) {
    lines.push("", `Not part of the ${plugin.label} scope:`);
    for (const subcommand of unsupportedCommands) {
      lines.push(`- ${getSearchCommandLabel(PRIMARY_COMMAND_NAME, subcommand)}`);
    }
  }

  lines.push("", "Options:");
  lines.push("- `mode: exact|whole|broad` controls how strict the search is");

  if (getCommandAvailability(plugin, "config") === "ready") {
    lines.push("- `file: <name>` narrows `config` to a matching indexed file");
  }

  lines.push(
    `- \`limit: 1-${MAX_RESULT_LIMIT}\` is used by most commands, with \`${config.search.defaultResultLimit}\` as the default`,
  );

  if (getCommandAvailability(plugin, "material") === "ready") {
    const materialDefaultLimit = plugin.profiles.material?.defaultResultLimit ?? MATERIAL_MAX_RESULT_LIMIT;
    lines.push(
      `- \`material\` uses \`limit: 1-${MATERIAL_MAX_RESULT_LIMIT}\` and defaults to \`${materialDefaultLimit}\``,
    );
  }

  if (getCommandAvailability(plugin, "config") === "ready" || getCommandAvailability(plugin, "language") === "ready") {
    lines.push("- `related: true|false` adds nearby YAML entries for `config`, `language`, and `lang`");
  }

  lines.push(
    aiEnabled
      ? "- `summary: true|false` adds an optional AI-generated summary (admin-only for now)"
      : "- `summary: true|false` is currently disabled in bot config",
  );

  if (context.isTestChannel && canReload) {
    lines.push("- `debug context:<plugin>|auto` can switch the test channel context live");
  }

  lines.push("", "Examples:");

  if (plugin.id === "cmi") {
    lines.push(`- \`${prefix} config dynmap\``);
    lines.push(`- \`${prefix} config chat file:Chat.yml\``);
    lines.push(`- \`${prefix} config "mini message" mode:whole\``);
    lines.push(`- \`${prefix} language home\``);
    lines.push(`- \`${prefix} placeholder balance\``);
    lines.push(`- \`${prefix} material shulker\``);
    lines.push(`- \`${prefix} cmd balance\``);
    lines.push(`- \`${prefix} perm cmi.command.balance\``);
    lines.push(`- \`${prefix} faq refund\``);
  } else if (plugin.id === "jobs") {
    lines.push(`- \`${prefix} language exp\``);
    lines.push(`- \`${prefix} placeholder points\``);
    lines.push(`- \`${prefix} cmd join\``);
    lines.push(`- \`${prefix} perm jobs.use\``);
    lines.push(`- \`${prefix} faq vault\``);
  } else if (plugin.id === "svis") {
    lines.push(`- \`${prefix} config selection\``);
    lines.push(`- \`${prefix} language particle\``);
    lines.push(`- \`${prefix} cmd gui\``);
    lines.push(`- \`${prefix} perm sv.worldedit.use\``);
    lines.push(`- \`${prefix} langstats\``);
  } else if (plugin.id === "mfm") {
    lines.push(`- \`${prefix} config farm\``);
    lines.push(`- \`${prefix} language mob\``);
    lines.push(`- \`${prefix} cmd mfm\``);
    lines.push(`- \`${prefix} perm mfm.command.reload\``);
    lines.push(`- \`${prefix} langstats\``);
  } else if (plugin.id === "tryme") {
    lines.push(`- \`${prefix} config tryme\``);
    lines.push(`- \`${prefix} language message\``);
    lines.push(`- \`${prefix} placeholder current\``);
    lines.push(`- \`${prefix} cmd answer\``);
    lines.push(`- \`${prefix} perm tryme.command.qmode\``);
    lines.push(`- \`${prefix} langstats\``);
  } else if (plugin.id === "trademe") {
    lines.push(`- \`${prefix} config trade\``);
    lines.push(`- \`${prefix} language seller\``);
    lines.push(`- \`${prefix} placeholder trade\``);
    lines.push(`- \`${prefix} cmd trade\``);
    lines.push(`- \`${prefix} perm trademe.itembypass\``);
    lines.push(`- \`${prefix} langstats\``);
  } else if (plugin.id === "residence") {
    lines.push(`- \`${prefix} config build\``);
    lines.push(`- \`${prefix} language invalid\``);
    lines.push(`- \`${prefix} placeholder owner\``);
    lines.push(`- \`${prefix} cmd set\``);
    lines.push(`- \`${prefix} perm residence.select\``);
    lines.push(`- \`${prefix} langstats\``);
    lines.push(`- \`${prefix} stats\``);
  } else if (plugin.id === "bottledexp") {
    lines.push(`- \`${prefix} config bottle\``);
    lines.push(`- \`${prefix} config recipe file:recipes.yml\``);
    lines.push(`- \`${prefix} language experience\``);
    lines.push(`- \`${prefix} cmd bottle\``);
    lines.push(`- \`${prefix} perm bottledexp.command.consume\``);
    lines.push(`- \`${prefix} latest\``);
  } else {
    lines.push(`- \`${prefix} config setting\``);
    lines.push(`- \`${prefix} language message\``);
    lines.push(`- \`${prefix} langstats\``);
  }

  if (!canLookup) {
    lines.push(
      "",
      "Notice: search commands and stats are limited to configured support role IDs. `/lookup health`, `/lookup debug`, and `/lookup reload` are admin-only.",
    );
  } else if (aiEnabled && !canReload && !canUseAi) {
    lines.push(
      "",
      "Notice: you can use search commands here, but `/lookup health`, `/lookup debug`, `/lookup reload`, and AI-backed options like `summary:true` are restricted.",
    );
  } else if (!canReload) {
    lines.push("", "Notice: you can use search commands here, but `/lookup health`, `/lookup debug`, and `/lookup reload` are admin-only.");
  } else {
    lines.push("", `Notice: ${currentCommand} is available here.`);
  }

  return lines.join("\n");
}
