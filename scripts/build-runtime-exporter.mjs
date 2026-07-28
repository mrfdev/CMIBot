import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  assertJavaFeature,
  classMajorForJava,
  expectedPaperApiJarName,
  readRuntimeCompatibility,
  resolveJavaTool,
} from "./runtime-compatibility.mjs";

const execFileAsync = promisify(execFile);

async function findLibraryJars(root, expectedApiJarName) {
  const pending = [root];
  const jars = [];
  while (pending.length) {
    const current = pending.pop();
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const absolutePath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(absolutePath);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".jar")) {
        jars.push(absolutePath);
      }
    }
  }

  const paperApiJars = jars.filter((jarPath) => /^paper-api-.+\.jar$/i.test(path.basename(jarPath)));
  const expectedApiJar = paperApiJars.find((jarPath) => path.basename(jarPath) === expectedApiJarName);
  if (!expectedApiJar) {
    const found = paperApiJars.map((jarPath) => path.basename(jarPath)).join(", ") || "none";
    throw new Error(`Expected ${expectedApiJarName} below ${root}; found ${found}`);
  }
  return jars
    .filter((jarPath) => !/^paper-api-.+\.jar$/i.test(path.basename(jarPath)) || jarPath === expectedApiJar)
    .sort();
}

function readTopLevelYamlValue(yaml, key) {
  const match = yaml.match(new RegExp(`^${key}:\\s*['"]?([^\\r\\n'"]+)['"]?\\s*$`, "mi"));
  return match?.[1]?.trim() ?? "";
}

async function validatePluginMetadata(pluginYamlPath, compatibility) {
  const yaml = await fs.readFile(pluginYamlPath, "utf8");
  const version = readTopLevelYamlValue(yaml, "version");
  const apiVersion = readTopLevelYamlValue(yaml, "api-version");
  if (version !== compatibility.exporterVersion) {
    throw new Error(
      `runtime-exporter/plugin.yml version ${version || "missing"} does not match compatibility.json ${compatibility.exporterVersion}`,
    );
  }
  if (apiVersion !== compatibility.paperApiVersion) {
    throw new Error(
      `runtime-exporter/plugin.yml api-version ${apiVersion || "missing"} does not match compatibility.json ${compatibility.paperApiVersion}`,
    );
  }
}

export async function buildRuntimeExporter(workspaceRoot, paperServerDirectory) {
  const compatibility = await readRuntimeCompatibility(workspaceRoot);
  const sourcePath = path.join(
    workspaceRoot,
    "runtime-exporter",
    "src",
    "dev",
    "mrf",
    "lookup",
    "LookupRuntimeExporter.java",
  );
  const pluginYamlPath = path.join(workspaceRoot, "runtime-exporter", "plugin.yml");
  const buildRoot = path.join(workspaceRoot, "servers", ".lookup-runtime-exporter-build");
  const classesDirectory = path.join(buildRoot, "classes");
  const outputPath = path.join(buildRoot, "LookupRuntimeExporter.jar");
  const expectedApiJarName = expectedPaperApiJarName(compatibility);
  const libraryJars = await findLibraryJars(
    path.join(paperServerDirectory, "libraries"),
    expectedApiJarName,
  );
  const javac = await resolveJavaTool(compatibility, { tool: "javac" });
  const jar = await resolveJavaTool(compatibility, { tool: "jar" });
  const javaVersion = await assertJavaFeature(javac, compatibility.javaTarget);
  await validatePluginMetadata(pluginYamlPath, compatibility);

  await fs.rm(buildRoot, { recursive: true, force: true });
  await fs.mkdir(classesDirectory, { recursive: true });
  const compileResult = await execFileAsync(
    javac,
    [
      "--release",
      String(compatibility.javaTarget),
      "-Xlint:deprecation",
      "-Xlint:removal",
      "-proc:none",
      "-classpath",
      libraryJars.join(path.delimiter),
      "-d",
      classesDirectory,
      sourcePath,
    ],
    { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
  );
  if (compileResult.stderr.trim()) {
    process.stderr.write(compileResult.stderr);
  }

  const mainClassPath = path.join(classesDirectory, "dev", "mrf", "lookup", "LookupRuntimeExporter.class");
  const mainClass = await fs.readFile(mainClassPath);
  const actualClassMajor = mainClass.readUInt16BE(6);
  const expectedClassMajor = classMajorForJava(compatibility.javaTarget);
  if (actualClassMajor !== expectedClassMajor) {
    throw new Error(
      `Exporter class major ${actualClassMajor} does not match Java ${compatibility.javaTarget} (${expectedClassMajor})`,
    );
  }

  await execFileAsync(
    jar,
    ["--create", "--file", outputPath, "-C", classesDirectory, ".", "-C", path.dirname(pluginYamlPath), "plugin.yml"],
    { maxBuffer: 4 * 1024 * 1024 },
  );
  console.log(
    `[exporter] Built ${compatibility.exporterVersion} for Paper API ${compatibility.paperApiCoordinate} ` +
      `and Java ${compatibility.javaTarget} with ${javaVersion.output.split("\n")[0]}.`,
  );
  return outputPath;
}

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  const workspaceRoot = path.resolve(path.dirname(scriptPath), "..");
  const activeServer = path.join(workspaceRoot, "servers", "Paper-26.2");
  const templateServer = path.join(workspaceRoot, "servers", "_template-Paper-26.2");
  let paperServerDirectory = activeServer;
  try {
    await fs.access(path.join(activeServer, "libraries"));
  } catch {
    paperServerDirectory = templateServer;
  }
  const outputPath = await buildRuntimeExporter(
    workspaceRoot,
    paperServerDirectory,
  );
  console.log(`Runtime exporter built at ${outputPath}`);
}
