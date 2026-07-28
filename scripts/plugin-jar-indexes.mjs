import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { PLUGIN_DEFINITIONS } from "./plugin-definitions.mjs";

const execFileAsync = promisify(execFile);
const generatedFileNames = {
  command: "generated-commands.log",
  permission: "generated-permissions.log",
  placeholder: "generated-placeholders.log",
};

function unquote(value) {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseTopLevelValue(yaml, key) {
  const match = yaml.match(new RegExp(`^${key}:\\s*(.+?)\\s*$`, "mi"));
  return match ? unquote(match[1]) : "";
}

function parsePluginSection(yaml, sectionName) {
  const lines = yaml.split(/\r?\n/);
  const sectionIndex = lines.findIndex((line) => new RegExp(`^${sectionName}:\\s*$`, "i").test(line));
  if (sectionIndex < 0) {
    return [];
  }

  const entries = [];
  let entryIndent = null;
  let current = null;

  for (let index = sectionIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const indent = line.length - line.trimStart().length;
    if (indent === 0) {
      break;
    }

    const keyMatch = line.match(/^\s+([^:#][^:]*):\s*(.*)$/);
    if (!keyMatch) {
      continue;
    }

    if (entryIndent == null) {
      entryIndent = indent;
    }

    if (indent === entryIndent) {
      current = {
        key: unquote(keyMatch[1]),
        description: "",
        usage: "",
        defaultValue: "",
      };
      entries.push(current);
      continue;
    }

    if (!current || indent <= entryIndent) {
      continue;
    }

    const property = keyMatch[1].trim().toLowerCase();
    const value = unquote(keyMatch[2]);
    if (property === "description") {
      current.description = value;
    } else if (property === "usage") {
      current.usage = value;
    } else if (property === "default") {
      current.defaultValue = value;
    }
  }

  const uniqueEntries = new Map();
  for (const entry of entries) {
    const normalizedKey = entry.key.toLowerCase();
    if (!uniqueEntries.has(normalizedKey)) {
      uniqueEntries.set(normalizedKey, entry);
    }
  }
  return [...uniqueEntries.values()];
}

function unescapeTsv(value = "") {
  let result = "";
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character !== "\\" || index === value.length - 1) {
      result += character;
      continue;
    }

    const escaped = value[index + 1];
    const replacements = { n: "\n", r: "\r", t: "\t", "\\": "\\" };
    result += replacements[escaped] ?? escaped;
    index += 1;
  }
  return result;
}

function createEmptyRuntimeData() {
  return {
    rowsByPlugin: new Map(),
    warningsByPlugin: new Map(),
    globalWarnings: [],
  };
}

function addRuntimeWarning(runtimeData, warning) {
  const pluginMatch = warning.match(/^([a-z0-9_-]+):\s*(.+)$/i);
  if (!pluginMatch) {
    runtimeData.globalWarnings.push(warning);
    return;
  }

  const pluginId = pluginMatch[1].toLowerCase();
  const warnings = runtimeData.warningsByPlugin.get(pluginId) ?? [];
  warnings.push(pluginMatch[2]);
  runtimeData.warningsByPlugin.set(pluginId, warnings);
}

async function readRuntimeExport(serverDirectory) {
  const runtimeData = createEmptyRuntimeData();
  const exportPath = path.join(
    serverDirectory,
    "plugins",
    "LookupRuntimeExporter",
    "generated-indexes.tsv",
  );

  let fileText;
  try {
    fileText = await fs.readFile(exportPath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      runtimeData.globalWarnings.push("runtime export was not found; using plugin.yml metadata only");
      return runtimeData;
    }
    throw error;
  }

  for (const [index, line] of fileText.split(/\r?\n/).entries()) {
    if (!line || index === 0) {
      continue;
    }
    const [kind, pluginId, key, description, argumentsValue, aliases, source] = line
      .split("\t")
      .map(unescapeTsv);

    if (kind === "warning") {
      addRuntimeWarning(runtimeData, key);
      continue;
    }
    if (!generatedFileNames[kind] || !pluginId || !key) {
      runtimeData.globalWarnings.push(`ignored malformed runtime export row ${index + 1}`);
      continue;
    }

    const normalizedPluginId = pluginId.toLowerCase();
    const pluginRows = runtimeData.rowsByPlugin.get(normalizedPluginId) ?? {
      command: [],
      permission: [],
      placeholder: [],
    };
    pluginRows[kind].push({
      key: key.trim(),
      description: description.trim(),
      arguments: argumentsValue.trim(),
      aliases: aliases
        .split(",")
        .map((alias) => alias.trim())
        .filter(Boolean),
      source,
    });
    runtimeData.rowsByPlugin.set(normalizedPluginId, pluginRows);
  }

  return runtimeData;
}

function normalizeKey(value) {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function cleanMetadataText(value = "") {
  return value
    .replace(/(?:§|&)[0-9A-FK-ORX]/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function mergeRows(primaryRows, fallbackRows) {
  const rows = new Map();
  for (const row of primaryRows) {
    rows.set(normalizeKey(row.key), { ...row });
  }
  for (const row of fallbackRows) {
    const normalizedKey = normalizeKey(row.key);
    const current = rows.get(normalizedKey);
    if (!current) {
      rows.set(normalizedKey, { ...row });
      continue;
    }
    rows.set(normalizedKey, {
      ...row,
      ...current,
      description: current.description || row.description,
      arguments: current.arguments || row.arguments,
      aliases: current.aliases?.length ? current.aliases : row.aliases,
      defaultValue: current.defaultValue || row.defaultValue,
    });
  }
  return [...rows.values()].sort((left, right) => left.key.localeCompare(right.key));
}

function pluginCommandsToRows(entries) {
  return entries.map((entry) => ({
    key: `/${entry.key}`,
    description: entry.description,
    arguments: "",
    aliases: [],
    source: "plugin.yml",
  }));
}

function pluginPermissionsToRows(entries) {
  return entries.map((entry) => ({
    key: entry.key,
    description: entry.description,
    defaultValue: entry.defaultValue,
    source: "plugin.yml",
  }));
}

function formatCommands(rows) {
  return rows
    .map((row) => {
      const argumentsValue = row.arguments && row.arguments !== row.key ? ` ${row.arguments}` : "";
      const notes = [];
      if (row.description) {
        notes.push(cleanMetadataText(row.description));
      }
      if (row.aliases?.length) {
        notes.push(`Aliases: ${row.aliases.join(", ")}`);
      }
      const command = `${row.key}${argumentsValue}`.trim();
      return notes.length ? `${command} - ${notes.join("; ")}` : command;
    })
    .join("\n");
}

function formatPermissions(rows) {
  return rows
    .map((row) => {
      const notes = [];
      if (row.description) {
        notes.push(cleanMetadataText(row.description));
      }
      if (row.defaultValue) {
        notes.push(`Default: ${row.defaultValue}`);
      }
      return notes.length ? `${row.key} - ${notes.join("; ")}` : row.key;
    })
    .join("\n");
}

function formatPlaceholders(rows) {
  return rows
    .map((row) => [row.description ? `# ${row.description}` : "", row.key].filter(Boolean).join("\n"))
    .join("\n\n");
}

async function readJarPluginYaml(jarPath) {
  const { stdout } = await execFileAsync("unzip", ["-p", jarPath, "plugin.yml"], {
    encoding: "utf8",
    maxBuffer: 2 * 1024 * 1024,
  });
  return stdout;
}

async function findPluginJars(pluginsDirectory) {
  const jars = [];
  for (const entry of await fs.readdir(pluginsDirectory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".jar")) {
      continue;
    }
    const jarPath = path.join(pluginsDirectory, entry.name);
    const yaml = await readJarPluginYaml(jarPath);
    jars.push({
      jarPath,
      yaml,
      pluginName: parseTopLevelValue(yaml, "name"),
    });
  }
  return jars;
}

async function writeOrRemove(filePath, content) {
  if (!content) {
    await fs.rm(filePath, { force: true });
    return;
  }
  await fs.writeFile(filePath, `${content}\n`, "utf8");
}

export async function writeGeneratedJarIndexes(workspaceRoot, serverDirectory) {
  const pluginsDirectory = path.join(serverDirectory, "plugins");
  const [jars, runtimeData] = await Promise.all([
    findPluginJars(pluginsDirectory),
    readRuntimeExport(serverDirectory),
  ]);
  const jarsByName = new Map(jars.map((jar) => [jar.pluginName.toLowerCase(), jar]));
  const results = [];

  for (const definition of PLUGIN_DEFINITIONS) {
    const jar = jarsByName.get(definition.pluginName.toLowerCase());
    if (!jar) {
      throw new Error(`Could not find the ${definition.label} jar while generating lookup indexes.`);
    }

    const runtimeRows = runtimeData.rowsByPlugin.get(definition.id) ?? {
      command: [],
      permission: [],
      placeholder: [],
    };
    const commands = mergeRows(
      runtimeRows.command,
      pluginCommandsToRows(parsePluginSection(jar.yaml, "commands")),
    );
    const permissions = mergeRows(
      runtimeRows.permission,
      pluginPermissionsToRows(parsePluginSection(jar.yaml, "permissions")),
    );
    const placeholders = mergeRows(runtimeRows.placeholder, []);
    const dataDirectory = path.join(workspaceRoot, definition.dataDirectory);
    await fs.mkdir(dataDirectory, { recursive: true });
    await writeOrRemove(path.join(dataDirectory, generatedFileNames.command), formatCommands(commands));
    await writeOrRemove(path.join(dataDirectory, generatedFileNames.permission), formatPermissions(permissions));
    await writeOrRemove(path.join(dataDirectory, generatedFileNames.placeholder), formatPlaceholders(placeholders));
    results.push({
      label: definition.label,
      commandCount: commands.length,
      permissionCount: permissions.length,
      placeholderCount: placeholders.length,
      warnings: [
        ...runtimeData.globalWarnings,
        ...(runtimeData.warningsByPlugin.get(definition.id) ?? []),
      ],
    });
  }

  return results;
}

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  const workspaceRoot = path.resolve(path.dirname(scriptPath), "..");
  const serverDirectory = path.join(workspaceRoot, "servers", "Paper-26.2");
  const results = await writeGeneratedJarIndexes(workspaceRoot, serverDirectory);
  for (const result of results) {
    console.log(
      `${result.label}: ${result.commandCount} commands, ${result.permissionCount} permissions, and ${result.placeholderCount} placeholders generated`,
    );
    for (const warning of result.warnings) {
      console.warn(`${result.label}: ${warning}`);
    }
  }
}
