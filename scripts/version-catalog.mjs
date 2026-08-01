import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  COMPANION_DEFINITIONS,
  PAPER_DEFINITION,
  PLUGIN_DEFINITIONS,
  getSpigotResourceUrl,
} from "./plugin-definitions.mjs";
import { readRuntimeCompatibility } from "./runtime-compatibility.mjs";

const execFileAsync = promisify(execFile);
const SUPPORT_PLUGIN_METADATA = new Map([
  [
    "luckperms",
    {
      label: "LuckPerms",
      resourceUrl: "https://luckperms.net/download",
      versionSource: {
        type: "luckperms-metadata",
        url: "https://metadata.luckperms.net/data/all",
      },
    },
  ],
  [
    "placeholderapi",
    {
      label: "PlaceholderAPI",
      resourceUrl: "https://ci.extendedclip.com/job/PlaceholderAPI/",
      localBuildPattern: /-build-(\d+)\.jar$/i,
      versionSource: {
        type: "jenkins-artifact",
        url: "https://ci.extendedclip.com/job/PlaceholderAPI/lastSuccessfulBuild/api/json",
        artifactPattern: "^PlaceholderAPI-([0-9]+(?:\\.[0-9]+)+)\\.jar$",
      },
    },
  ],
]);

function unquote(value) {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function readTopLevelYamlValue(yaml, key) {
  const expression = new RegExp(`^${key}:\\s*(.+?)\\s*$`, "mi");
  const match = yaml.match(expression);
  return match ? unquote(match[1]) : "";
}

async function readPluginMetadata(jarPath) {
  const { stdout } = await execFileAsync("unzip", ["-p", jarPath, "plugin.yml"], {
    encoding: "utf8",
    maxBuffer: 2 * 1024 * 1024,
  });

  return {
    name: readTopLevelYamlValue(stdout, "name"),
    version: readTopLevelYamlValue(stdout, "version"),
    website: readTopLevelYamlValue(stdout, "website"),
  };
}

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function versionFromJarName(jarName, prefix) {
  if (!prefix || !jarName.toLowerCase().startsWith(prefix.toLowerCase())) {
    return "";
  }
  return jarName.slice(prefix.length).replace(/\.jar$/i, "").replace(/^[-_]+/, "");
}

async function findStoredCompanionJars(serverDirectory) {
  const result = new Map();
  const companionDirectory = path.join(serverDirectory, "companions");
  let entries;
  try {
    entries = await fs.readdir(companionDirectory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") {
      return result;
    }
    throw error;
  }

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".jar")) {
      continue;
    }
    const definition = COMPANION_DEFINITIONS.find((candidate) =>
      entry.name.toLowerCase().startsWith(candidate.localJarPrefix.toLowerCase()),
    );
    if (!definition) {
      continue;
    }
    result.set(definition.id, {
      version: versionFromJarName(entry.name, definition.localJarPrefix) || "unknown",
      jar: entry.name,
      location: "companions",
    });
  }
  return result;
}

async function readPaperMetadata(workspaceRoot, serverDirectory) {
  const statePath = path.join(serverDirectory, "paperscript", "state.json");
  const compatibility = await readRuntimeCompatibility(workspaceRoot);
  try {
    const state = JSON.parse(await fs.readFile(statePath, "utf8"));
    return {
      id: PAPER_DEFINITION.id,
      label: PAPER_DEFINITION.label,
      version: String(state.current_version ?? "unknown"),
      build: Number.isFinite(state.current_build) ? state.current_build : null,
      channel: compatibility.paperChannel,
      jar: String(state.current_jar ?? compatibility.paperJar),
      sha256: String(state.current_sha256 ?? ""),
      apiVersion: compatibility.paperApiVersion,
      apiCoordinate: compatibility.paperApiCoordinate,
      javaTarget: compatibility.javaTarget,
      exporterVersion: compatibility.exporterVersion,
      projectUrl: PAPER_DEFINITION.projectUrl,
    };
  } catch {
    return {
      id: PAPER_DEFINITION.id,
      label: PAPER_DEFINITION.label,
      version: "unknown",
      build: null,
      channel: "unknown",
      jar: compatibility.paperJar,
      sha256: "",
      apiVersion: compatibility.paperApiVersion,
      apiCoordinate: compatibility.paperApiCoordinate,
      javaTarget: compatibility.javaTarget,
      exporterVersion: compatibility.exporterVersion,
      projectUrl: PAPER_DEFINITION.projectUrl,
    };
  }
}

export async function buildVersionCatalog(workspaceRoot, serverDirectory) {
  const pluginsDirectory = path.join(serverDirectory, "plugins");
  const directoryEntries = await fs.readdir(pluginsDirectory, { withFileTypes: true });
  const jarNames = directoryEntries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".jar"))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
  const knownByPluginName = new Map(PLUGIN_DEFINITIONS.map((definition) => [definition.pluginName.toLowerCase(), definition]));
  const companionByPluginName = new Map(
    COMPANION_DEFINITIONS.filter((definition) => definition.localPluginName).map((definition) => [
      definition.localPluginName.toLowerCase(),
      definition,
    ]),
  );
  const storedCompanions = await findStoredCompanionJars(serverDirectory);
  const plugins = [];

  for (const jarName of jarNames) {
    const jarPath = path.join(pluginsDirectory, jarName);
    let metadata;
    try {
      metadata = await readPluginMetadata(jarPath);
    } catch (error) {
      console.warn(`[refresh] Could not inspect ${jarName}: ${error.message}`);
      continue;
    }

    if (metadata.name.toLowerCase() === "lookupruntimeexporter") {
      continue;
    }

    const companionDefinition = companionByPluginName.get(metadata.name.toLowerCase());
    if (companionDefinition) {
      storedCompanions.set(companionDefinition.id, {
        version: versionFromJarName(jarName, companionDefinition.localJarPrefix) || metadata.version || "unknown",
        jar: jarName,
        location: "plugins",
      });
      continue;
    }

    const definition = knownByPluginName.get(metadata.name.toLowerCase());
    const supportMetadata = SUPPORT_PLUGIN_METADATA.get(metadata.name.toLowerCase());
    const resourceId = definition?.resourceId ?? null;
    const localBuildMatch = supportMetadata?.localBuildPattern
      ? jarName.match(supportMetadata.localBuildPattern)
      : null;
    plugins.push({
      id: definition?.id ?? slugify(metadata.name || jarName.replace(/\.jar$/i, "")),
      label: definition?.label ?? supportMetadata?.label ?? (metadata.name || jarName.replace(/\.jar$/i, "")),
      pluginName: metadata.name,
      version: metadata.version || "unknown",
      jar: jarName,
      contextId: definition?.shared ? null : definition?.id ?? null,
      shared: definition?.shared ?? false,
      tracked: Boolean(definition),
      resourceId,
      resourceUrl: getSpigotResourceUrl(resourceId) || supportMetadata?.resourceUrl || metadata.website,
      website: metadata.website,
      ...(localBuildMatch ? { build: Number(localBuildMatch[1]) } : {}),
      ...(supportMetadata?.versionSource ? { versionSource: supportMetadata.versionSource } : {}),
    });
  }

  const companions = COMPANION_DEFINITIONS.map((definition) => {
    const stored = storedCompanions.get(definition.id);
    return {
      id: definition.id,
      label: definition.label,
      version: stored?.version ?? null,
      jar: stored?.jar ?? null,
      location: stored?.location ?? null,
      resourceUrl: definition.resourceUrl,
      versionSource: definition.versionSource,
    };
  });

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    sourceServer: path.relative(workspaceRoot, serverDirectory).split(path.sep).join("/"),
    paper: await readPaperMetadata(workspaceRoot, serverDirectory),
    plugins,
    companions,
  };
}

export async function writeVersionCatalog(workspaceRoot, serverDirectory) {
  const catalog = await buildVersionCatalog(workspaceRoot, serverDirectory);
  const outputPath = path.join(workspaceRoot, "data", "versions.json");
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(catalog, null, 2)}\n`, "utf8");
  return { catalog, outputPath };
}
