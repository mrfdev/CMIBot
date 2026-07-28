import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { buildRuntimeExporter } from "./build-runtime-exporter.mjs";
import { PLUGIN_DEFINITIONS } from "./plugin-definitions.mjs";
import { writeGeneratedJarIndexes } from "./plugin-jar-indexes.mjs";
import {
  assertJavaFeature,
  readRuntimeCompatibility,
  resolveJavaTool,
} from "./runtime-compatibility.mjs";
import { writeVersionCatalog } from "./version-catalog.mjs";

const execFileAsync = promisify(execFile);
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(scriptDirectory, "..");
const serversRoot = path.join(workspaceRoot, "servers");
const templateDirectory = path.join(serversRoot, "_template-Paper-26.2");
const serverDirectory = path.join(serversRoot, "Paper-26.2");
const allowedExtensions = new Set([".json", ".png", ".txt", ".yaml", ".yml"]);
const excludedDirectoryNames = new Set(["backup", "backups", "databasebackups", "filebackups", "logs"]);
const excludedFileNames = new Set([".ds_store", "security.key"]);
const startupTimeoutMs = 180_000;
const exporterTimeoutMs = 60_000;
const gracefulStopTimeoutMs = 30_000;

function assertSafeServerPath(candidate, { allowTemplate = false } = {}) {
  const relative = path.relative(serversRoot, candidate);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Unsafe server path: ${candidate}`);
  }
  if (!allowTemplate && path.basename(candidate).startsWith("_template")) {
    throw new Error(`Refusing to modify the template server: ${candidate}`);
  }
}

async function pathExists(candidate) {
  try {
    await fs.access(candidate);
    return true;
  } catch {
    return false;
  }
}

async function sanitizeClone() {
  assertSafeServerPath(serverDirectory);
  const pluginsDirectory = path.join(serverDirectory, "plugins");
  const pluginEntries = await fs.readdir(pluginsDirectory, { withFileTypes: true });

  for (const entry of pluginEntries) {
    if (entry.isDirectory() || entry.name.toLowerCase() === ".ds_store") {
      await fs.rm(path.join(pluginsDirectory, entry.name), { recursive: true, force: true });
    }
  }

  const generatedRootEntries = [
    "banned-ips.json",
    "banned-players.json",
    "bukkit.yml",
    "commands.yml",
    "config",
    "help.yml",
    "logs",
    "ops.json",
    "permissions.yml",
    "spigot.yml",
    "usercache.json",
    "whitelist.json",
    "world",
    "world_nether",
    "world_the_end",
  ];

  for (const entry of generatedRootEntries) {
    await fs.rm(path.join(serverDirectory, entry), { recursive: true, force: true });
  }

  await fs.writeFile(path.join(serverDirectory, "eula.txt"), "eula=true\n", "utf8");
  const statePath = path.join(serverDirectory, "paperscript", "state.json");
  if (await pathExists(statePath)) {
    const state = JSON.parse(await fs.readFile(statePath, "utf8"));
    state.server_dir = serverDirectory;
    await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  }
}

async function cloneTemplate() {
  assertSafeServerPath(templateDirectory, { allowTemplate: true });
  assertSafeServerPath(serverDirectory);
  if (!(await pathExists(templateDirectory))) {
    throw new Error(`Template server was not found at ${templateDirectory}`);
  }

  await fs.cp(templateDirectory, serverDirectory, {
    recursive: true,
    force: false,
    errorOnExist: true,
  });
  await sanitizeClone();
}

async function patchPaperLibraries(javaBinary, paperJar) {
  console.log("[refresh] Preparing the exact Paper libraries in the disposable clone...");
  const { stdout, stderr } = await execFileAsync(
    javaBinary,
    [
      "-Dpaperclip.patchonly=true",
      "-Dfile.encoding=UTF-8",
      "-jar",
      paperJar,
    ],
    {
      cwd: serverDirectory,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  if (stdout.trim()) {
    process.stdout.write(`${stdout.trim()}\n`);
  }
  if (stderr.trim()) {
    process.stderr.write(`${stderr.trim()}\n`);
  }
}

function runCleanServer(javaBinary, paperJar) {
  return new Promise((resolve, reject) => {
    const outputLines = [];
    let outputTail = "";
    let ready = false;
    let exportRequested = false;
    let exportCompleted = false;
    let exportTimedOut = false;
    let stopRequested = false;
    let timedOut = false;
    let processError = null;
    let forcedKillTimer = null;
    let exporterTimer = null;
    const child = spawn(
      javaBinary,
      [
        "-Xms512M",
        "-Xmx2G",
        "--add-modules=jdk.incubator.vector",
        "-Dfile.encoding=UTF-8",
        "-Dcom.mojang.eula.agree=true",
        "-Dterminal.ansi=false",
        "-jar",
        paperJar,
        "--nogui",
      ],
      {
        cwd: serverDirectory,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );

    const requestStop = () => {
      if (stopRequested || child.killed) {
        return;
      }
      stopRequested = true;
      if (child.stdin.writable && !child.stdin.destroyed) {
        child.stdin.write("plugins\n");
        setTimeout(() => {
          if (child.stdin.writable && !child.stdin.destroyed) {
            child.stdin.write("stop\n");
          }
        }, 1_500).unref();
      }
    };

    const requestExport = () => {
      if (exportRequested || stopRequested || child.killed) {
        return;
      }
      exportRequested = true;
      if (!child.stdin.writable || child.stdin.destroyed) {
        requestStop();
        return;
      }

      console.log("[refresh] Paper is ready; exporting runtime command, permission, and placeholder metadata...");
      child.stdin.write("lookupexport\n");
      exporterTimer = setTimeout(() => {
        exportTimedOut = true;
        requestStop();
      }, exporterTimeoutMs);
      exporterTimer.unref();
    };

    const startupTimer = setTimeout(() => {
      timedOut = true;
      requestStop();
      forcedKillTimer = setTimeout(() => child.kill("SIGTERM"), gracefulStopTimeoutMs);
      forcedKillTimer.unref();
    }, startupTimeoutMs);

    const handleOutput = (chunk) => {
      const text = chunk.toString();
      process.stdout.write(text);
      outputLines.push(text);
      outputTail = `${outputTail}${text}`.slice(-4_096);
      if (!ready && /Done \([\d.]+s\)!/i.test(outputTail)) {
        ready = true;
        setTimeout(requestExport, 2_000).unref();
      }
      if (exportRequested && !exportCompleted && /LOOKUP_EXPORT_COMPLETE\s+entries=\d+/i.test(outputTail)) {
        exportCompleted = true;
        if (exporterTimer) {
          clearTimeout(exporterTimer);
          exporterTimer = null;
        }
        setTimeout(requestStop, 1_000).unref();
      }
    };

    child.stdout.on("data", handleOutput);
    child.stderr.on("data", handleOutput);
    child.on("error", (error) => {
      processError = error;
    });
    child.on("close", async (code) => {
      clearTimeout(startupTimer);
      if (forcedKillTimer) {
        clearTimeout(forcedKillTimer);
      }
      if (exporterTimer) {
        clearTimeout(exporterTimer);
      }
      await fs.writeFile(path.join(serversRoot, "refresh-last.log"), outputLines.join(""), "utf8");
      if (processError) {
        reject(processError);
        return;
      }
      if (timedOut && !ready) {
        reject(new Error(`Paper did not reach its ready state within ${startupTimeoutMs / 1000} seconds.`));
        return;
      }
      if (exportTimedOut) {
        reject(new Error(`Runtime metadata export did not complete within ${exporterTimeoutMs / 1000} seconds.`));
        return;
      }
      if (!exportCompleted) {
        reject(new Error("Paper stopped before runtime metadata export completed."));
        return;
      }
      if (!ready || code !== 0) {
        reject(new Error(`Paper exited with code ${code ?? "unknown"} before a successful clean startup.`));
        return;
      }
      resolve();
    });
  });
}

function shouldCopyGeneratedFile(relativePath) {
  const segments = relativePath.split(path.sep);
  if (segments.some((segment) => excludedDirectoryNames.has(segment.toLowerCase()))) {
    return false;
  }
  const baseName = path.basename(relativePath).toLowerCase();
  if (excludedFileNames.has(baseName)) {
    return false;
  }
  return allowedExtensions.has(path.extname(baseName));
}

async function collectGeneratedFiles(root, current = root) {
  const files = [];
  for (const entry of await fs.readdir(current, { withFileTypes: true })) {
    const absolutePath = path.join(current, entry.name);
    const relativePath = path.relative(root, absolutePath);
    if (entry.isDirectory()) {
      if (!excludedDirectoryNames.has(entry.name.toLowerCase())) {
        files.push(...(await collectGeneratedFiles(root, absolutePath)));
      }
      continue;
    }
    if (entry.isFile() && shouldCopyGeneratedFile(relativePath)) {
      files.push(relativePath);
    }
  }
  return files;
}

async function clearGeneratedTarget(targetDirectory) {
  if (!(await pathExists(targetDirectory))) {
    await fs.mkdir(targetDirectory, { recursive: true });
    return;
  }

  for (const entry of await fs.readdir(targetDirectory, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name === "data") {
      continue;
    }
    await fs.rm(path.join(targetDirectory, entry.name), { recursive: true, force: true });
  }
}

async function syncGeneratedPlugin(definition) {
  const sourceDirectory = path.join(serverDirectory, "plugins", definition.serverDirectory);
  const targetDirectory = path.join(workspaceRoot, definition.targetDirectory);
  if (!(await pathExists(sourceDirectory))) {
    throw new Error(`${definition.label} did not generate ${sourceDirectory}`);
  }

  const files = await collectGeneratedFiles(sourceDirectory);
  await clearGeneratedTarget(targetDirectory);
  for (const relativePath of files) {
    const sourcePath = path.join(sourceDirectory, relativePath);
    const targetPath = path.join(targetDirectory, relativePath);
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.copyFile(sourcePath, targetPath);
  }
  return files.length;
}

async function syncGeneratedData() {
  const results = [];
  for (const definition of PLUGIN_DEFINITIONS) {
    const fileCount = await syncGeneratedPlugin(definition);
    results.push({ label: definition.label, fileCount });
  }
  return results;
}

async function validateGeneratedData() {
  for (const definition of PLUGIN_DEFINITIONS) {
    const sourceDirectory = path.join(serverDirectory, "plugins", definition.serverDirectory);
    if (!(await pathExists(sourceDirectory))) {
      throw new Error(`${definition.label} did not generate ${sourceDirectory}`);
    }
    for (const requiredFile of definition.requiredGeneratedFiles ?? []) {
      const requiredPath = path.join(sourceDirectory, requiredFile);
      if (!(await pathExists(requiredPath))) {
        throw new Error(`${definition.label} did not generate required clean file ${requiredPath}`);
      }
    }
  }
}

async function backupRepositoryData(backupDirectory) {
  const entries = [];
  const candidates = [
    ...PLUGIN_DEFINITIONS.map((definition) => definition.targetDirectory),
    ...PLUGIN_DEFINITIONS.map((definition) => definition.dataDirectory),
  ]
    .filter(Boolean)
    .map((relativePath) => path.resolve(workspaceRoot, relativePath));
  const managedDirectories = [...new Set(candidates)]
    .sort((left, right) => left.length - right.length)
    .filter(
      (candidate, index, values) =>
        !values.slice(0, index).some((parent) => {
          const relative = path.relative(parent, candidate);
          return relative && !relative.startsWith("..") && !path.isAbsolute(relative);
        }),
    );

  for (const targetPath of managedDirectories) {
    const relativePath = path.relative(workspaceRoot, targetPath);
    const backupPath = path.join(backupDirectory, "managed", relativePath);
    const existed = await pathExists(targetPath);
    if (existed) {
      await fs.mkdir(path.dirname(backupPath), { recursive: true });
      await fs.cp(targetPath, backupPath, { recursive: true });
    }
    entries.push({ targetPath, backupPath, existed, isDirectory: true });
  }

  const catalogPath = path.join(workspaceRoot, "data", "versions.json");
  const catalogBackupPath = path.join(backupDirectory, "versions.json");
  const catalogExisted = await pathExists(catalogPath);
  if (catalogExisted) {
    await fs.mkdir(path.dirname(catalogBackupPath), { recursive: true });
    await fs.copyFile(catalogPath, catalogBackupPath);
  }
  entries.push({
    targetPath: catalogPath,
    backupPath: catalogBackupPath,
    existed: catalogExisted,
    isDirectory: false,
  });

  return entries;
}

async function restoreRepositoryData(entries) {
  for (const entry of entries) {
    await fs.rm(entry.targetPath, { recursive: entry.isDirectory, force: true });
    if (!entry.existed) {
      continue;
    }
    await fs.mkdir(path.dirname(entry.targetPath), { recursive: true });
    if (entry.isDirectory) {
      await fs.cp(entry.backupPath, entry.targetPath, { recursive: true });
    } else {
      await fs.copyFile(entry.backupPath, entry.targetPath);
    }
  }
  console.error("[refresh] Restored the previous repository lookup data.");
}

async function restoreBackup(backupDirectory) {
  if (!(await pathExists(backupDirectory))) {
    return;
  }
  if (await pathExists(serverDirectory)) {
    const failedDirectory = `${serverDirectory}.failed-${Date.now()}`;
    await fs.rename(serverDirectory, failedDirectory);
    console.error(`[refresh] Failed clone retained at ${failedDirectory}`);
  }
  await fs.rename(backupDirectory, serverDirectory);
  console.error(`[refresh] Restored the previous working server at ${serverDirectory}`);
}

async function retainFailedClone() {
  if (!(await pathExists(serverDirectory))) {
    return;
  }
  const failedDirectory = `${serverDirectory}.failed-${Date.now()}`;
  await fs.rename(serverDirectory, failedDirectory);
  console.error(`[refresh] Failed clone retained at ${failedDirectory}`);
}

async function main() {
  const compatibility = await readRuntimeCompatibility(workspaceRoot);
  const javaBinary = await resolveJavaTool(compatibility, {
    feature: compatibility.javaTarget,
    tool: "java",
  });
  const javaVersion = await assertJavaFeature(javaBinary, compatibility.javaTarget);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupDirectory = path.join(serversRoot, `.refresh-backup-Paper-26.2-${timestamp}`);
  const repositoryBackupDirectory = path.join(serversRoot, `.refresh-backup-repository-${timestamp}`);
  let backupCreated = false;
  let repositoryBackupEntries = [];
  let refreshCompleted = false;

  try {
    if (await pathExists(serverDirectory)) {
      assertSafeServerPath(serverDirectory);
      await fs.rename(serverDirectory, backupDirectory);
      backupCreated = true;
      console.log(`[refresh] Previous working server moved to ${backupDirectory}`);
    }

    console.log(`[refresh] Cloning immutable template into ${serverDirectory}`);
    await cloneTemplate();
    await patchPaperLibraries(javaBinary, compatibility.paperJar);
    console.log("[refresh] Building the internal runtime metadata exporter...");
    const runtimeExporterJar = await buildRuntimeExporter(workspaceRoot, serverDirectory);
    await fs.copyFile(
      runtimeExporterJar,
      path.join(serverDirectory, "plugins", "LookupRuntimeExporter.jar"),
    );
    console.log(
      `[refresh] Starting Paper ${compatibility.paperVersion} build ${compatibility.paperBuild} ` +
        `${compatibility.paperChannel} with ${javaVersion.output.split("\n")[0]}...`,
    );
    await runCleanServer(javaBinary, compatibility.paperJar);
    await validateGeneratedData();
    console.log("[refresh] Backing up managed repository data before synchronization...");
    repositoryBackupEntries = await backupRepositoryData(repositoryBackupDirectory);
    console.log("[refresh] Clean server stopped successfully; syncing generated files...");
    const syncResults = await syncGeneratedData();
    for (const result of syncResults) {
      console.log(`[refresh] ${result.label}: ${result.fileCount} clean files synchronized`);
    }

    const jarIndexResults = await writeGeneratedJarIndexes(workspaceRoot, serverDirectory);
    for (const result of jarIndexResults) {
      console.log(
        `[refresh] ${result.label}: ${result.commandCount} commands, ${result.permissionCount} permissions, and ${result.placeholderCount} placeholders indexed from runtime and jar metadata`,
      );
      for (const warning of result.warnings ?? []) {
        console.warn(`[refresh] ${result.label}: ${warning}`);
      }
    }

    const { catalog, outputPath } = await writeVersionCatalog(workspaceRoot, serverDirectory);
    console.log(`[refresh] Version catalog written to ${outputPath}`);
    console.log(`[refresh] Paper ${catalog.paper.version} build ${catalog.paper.build ?? "unknown"}`);
    for (const plugin of catalog.plugins) {
      console.log(`[refresh] ${plugin.label}: ${plugin.version}`);
    }
    refreshCompleted = true;
  } catch (error) {
    console.error(`[refresh] ${error instanceof Error ? error.message : error}`);
    if (repositoryBackupEntries.length) {
      try {
        await restoreRepositoryData(repositoryBackupEntries);
      } catch (restoreError) {
        console.error(
          `[refresh] Could not fully restore repository data from ${repositoryBackupDirectory}: ${restoreError.message}`,
        );
      }
    }
    if (backupCreated) {
      await restoreBackup(backupDirectory);
    } else {
      await retainFailedClone();
    }
    process.exitCode = 1;
  }

  if (!refreshCompleted) {
    return;
  }

  for (const [directory, label] of [
    [repositoryBackupDirectory, "repository-data"],
    ...(backupCreated ? [[backupDirectory, "previous-server"]] : []),
  ]) {
    try {
      await fs.rm(directory, { recursive: true, force: true });
      console.log(`[refresh] Removed the temporary ${label} backup after successful synchronization.`);
    } catch (error) {
      console.warn(`[refresh] Refresh succeeded, but ${directory} could not be removed: ${error.message}`);
    }
  }
}

await main();
