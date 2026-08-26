import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const macOsJavaHomeCommand = "/usr/libexec/java_home";

async function pathExists(candidate) {
  try {
    await fs.access(candidate);
    return true;
  } catch {
    return false;
  }
}

async function resolveMacOsJavaHome(feature, command) {
  if (!(await pathExists(command))) {
    return "";
  }

  try {
    const { stdout } = await execFileAsync(command, ["-v", String(feature)], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    });
    return stdout.trim();
  } catch {
    return "";
  }
}

export async function readRuntimeCompatibility(workspaceRoot) {
  const manifestPath = path.join(workspaceRoot, "runtime-exporter", "compatibility.json");
  const compatibility = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  if (compatibility.schemaVersion !== 1) {
    throw new Error(`Unsupported runtime compatibility schema in ${manifestPath}`);
  }
  return compatibility;
}

export async function resolveJavaTool(
  compatibility,
  {
    feature = compatibility.javaTarget,
    tool = "java",
    javaHome = "",
    environment = process.env,
    javaHomeCommand = macOsJavaHomeCommand,
  } = {},
) {
  const explicitTool = environment[`${tool.toUpperCase()}_BIN`] || (tool === "java" ? environment.JAVA_BIN : "");
  if (explicitTool) {
    if (!(await pathExists(explicitTool))) {
      throw new Error(`${tool.toUpperCase()}_BIN does not exist: ${explicitTool}`);
    }
    return explicitTool;
  }

  const configuredHome =
    javaHome ||
    environment.JAVA_HOME ||
    environment[`JAVA_${feature}_HOME`] ||
    compatibility[`jdk${feature}Home`];
  if (!configuredHome) {
    throw new Error(`No JDK home is configured for Java ${feature}. Set JAVA_HOME or JAVA_${feature}_HOME.`);
  }

  const binary = path.join(configuredHome, "bin", tool);
  if (await pathExists(binary)) {
    return binary;
  }

  const discoveredHome = await resolveMacOsJavaHome(feature, javaHomeCommand);
  if (discoveredHome) {
    const discoveredBinary = path.join(discoveredHome, "bin", tool);
    if (await pathExists(discoveredBinary)) {
      return discoveredBinary;
    }
  }

  throw new Error(
    `Java ${feature} ${tool} was not found at ${binary}; no installed Java ${feature} ${tool} ` +
      `was resolved through ${javaHomeCommand}`,
  );
}

export async function readJavaFeature(javaTool) {
  const { stdout, stderr } = await execFileAsync(javaTool, ["-version"], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  const output = `${stdout}\n${stderr}`;
  const match = output.match(/(?:version\s+"|javac\s+)(\d+)(?:\.(\d+))?/i);
  if (!match) {
    throw new Error(`Could not determine the Java version from ${javaTool}`);
  }
  return {
    feature: Number(match[1] === "1" ? match[2] : match[1]),
    output: output.trim(),
  };
}

export async function assertJavaFeature(javaTool, expectedFeature) {
  const version = await readJavaFeature(javaTool);
  if (version.feature !== Number(expectedFeature)) {
    throw new Error(
      `${javaTool} reports Java ${version.feature}, but this operation requires Java ${expectedFeature}.`,
    );
  }
  return version;
}

export function expectedPaperApiJarName(compatibility) {
  return `paper-api-${compatibility.paperApiCoordinate}.jar`;
}

export function classMajorForJava(feature) {
  return Number(feature) + 44;
}
