export function hasRole(member, { roleIds = [] } = {}) {
  const roles = member.roles?.cache;
  if (!roles) {
    return false;
  }

  return roleIds.length > 0 && roles.some((role) => roleIds.includes(role.id));
}

export function resolveCanonicalSubcommand(subcommand) {
  if (subcommand === "lang") {
    return "language";
  }

  if (subcommand === "cmd") {
    return "command";
  }

  if (subcommand === "perm") {
    return "permission";
  }

  return subcommand;
}

export function getSearchCommandLabel(commandName, canonicalSubcommand) {
  const prefix = `/${commandName}`;

  switch (canonicalSubcommand) {
    case "config":
      return `\`${prefix} config <keyword>\``;
    case "language":
      return `\`${prefix} language|lang <keyword>\``;
    case "placeholder":
      return `\`${prefix} placeholder <keyword>\``;
    case "material":
      return `\`${prefix} material <keyword>\``;
    case "command":
      return `\`${prefix} command|cmd <keyword>\``;
    case "permission":
      return `\`${prefix} permission|perm <keyword>\``;
    case "faq":
      return `\`${prefix} faq <keyword>\``;
    case "tabcomplete":
      return `\`${prefix} tabcomplete <keyword>\``;
    default:
      return `\`${prefix} ${canonicalSubcommand}\``;
  }
}

export function resolveChannelContext(channelId, config, testOverrides) {
  const isTestChannel = config.discord.testChannelIds.includes(channelId);
  const overridePluginId = testOverrides.get(channelId) ?? "";

  if (isTestChannel) {
    const pluginId = overridePluginId || config.discord.testDefaultContext;
    const plugin = config.plugins[pluginId] ?? null;

    return {
      pluginId,
      plugin,
      channelType: "test channel",
      isTestChannel: true,
      overridePluginId,
      routingNote: plugin
        ? overridePluginId
          ? `This test channel is currently overridden to the ${plugin.label} context.`
          : `This test channel is currently following the default ${plugin.label} context.`
        : "This test channel does not currently resolve to a configured plugin context.",
    };
  }

  for (const [pluginId, channelIds] of Object.entries(config.discord.pluginChannelIds)) {
    if (channelIds.includes(channelId)) {
      const plugin = config.plugins[pluginId] ?? null;
      return {
        pluginId,
        plugin,
        channelType: "support channel",
        isTestChannel: false,
        overridePluginId: "",
        routingNote: plugin
          ? `This channel is mapped to the ${plugin.label} lookup set.`
          : "This channel is mapped to an unknown plugin context.",
      };
    }
  }

  return {
    pluginId: "",
    plugin: null,
    channelType: "unmapped channel",
    isTestChannel: false,
    overridePluginId: "",
    routingNote: "This channel does not currently map to a known plugin context.",
  };
}

export function getCommandAvailability(plugin, canonicalSubcommand) {
  return plugin.commandAvailability[canonicalSubcommand] ?? "unsupported";
}

export function formatCommandUnavailableMessage(plugin, canonicalSubcommand, commandName, availability) {
  const commandLabel = getSearchCommandLabel(commandName, canonicalSubcommand);

  if (availability === "coming_soon") {
    return `${commandLabel} is still being worked on for the ${plugin.label} context.`;
  }

  return `${commandLabel} is not a feature of the ${plugin.label} context.`;
}
