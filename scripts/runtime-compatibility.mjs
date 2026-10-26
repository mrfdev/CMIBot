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
    const { stdout } = await execFileAsync(command, ["-F", "-v", String(feature)], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      timeout: 10_000,
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
  if (compatibility.javaTarget !== 25 || compatibility.javaTestTarget !== 27) {
    throw new Error("The exporter requires Oracle JDK 25 compilation and Oracle JDK 27 testing.");
  }
  return compatibility;
}

// JVM/compiler environment hooks must not override the validated toolchain or --release.
export function javaProcessEnvironment(environment = process.env) {
  const clean = { ...environment };
  for (const key of ["JAVA_TOOL_OPTIONS", "_JAVA_OPTIONS", "JDK_JAVA_OPTIONS", "JDK_JAVAC_OPTIONS", "CLASSPATH"]) {
    delete clean[key];
  }
  return clean;
}

export function runtimeServerPaths(workspaceRoot, compatibility) {
  const version = compatibility.paperVersion;
  if (typeof version !== "string" || !/^\d+\.\d+(?:\.\d+)?(?:-[a-z0-9-]+)?$/.test(version)) {
    throw new Error("Invalid Paper version in runtime compatibility manifest.");
  }
  const serversRoot = path.join(workspaceRoot, "servers");
  return {
    serversRoot,
    templateDirectory: path.join(serversRoot, `_template-Paper-${version}`),
    serverDirectory: path.join(serversRoot, `Paper-${version}`),
  };
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
  if (![25, 27].includes(feature) || !["java", "javac", "jar"].includes(tool)) {
    throw new Error("Only Oracle JDK 25 build tools and Oracle JDK 27 test tools are supported.");
  }
  const override = feature === 25 ? "ONE_MB_BUILD_JAVA_HOME" : "ONE_MB_TEST_JAVA_HOME";
  if (["JAVA_BIN", "JAVAC_BIN", "JAR_BIN"].some(key => environment[key])) {
    throw new Error(`Individual Java binary overrides are unsupported; select an installed Oracle JDK with ${override}.`);
  }
  // Deliberate selections fail closed; never fall back when an override is invalid.
  const selectedHome = javaHome || environment[override] || await resolveMacOsJavaHome(feature, javaHomeCommand);
  if (!selectedHome || !path.isAbsolute(selectedHome)) {
    throw new Error(`Installed Oracle JDK ${feature} not found. Set ${override} to a valid installed Oracle JDK home; automatic downloads are disabled.`);
  }
  const binary = path.join(selectedHome, "bin", tool);
  try {
    await fs.access(binary, fs.constants.X_OK);
  } catch {
    throw new Error(`Installed Oracle JDK ${feature} ${tool} is missing or not executable. Check ${override}.`);
  }
  await assertJavaFeature(binary, feature, environment);
  return binary;
}

export async function readJavaFeature(javaTool, environment = process.env) {
  const tool = path.basename(javaTool);
  const args = tool === "java"
    ? ["-XshowSettings:properties", "-version"]
    : ["-J-XshowSettings:properties", tool === "jar" ? "--version" : "-version"];
  const { stdout, stderr } = await execFileAsync(javaTool, args, {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    timeout: 10_000,
    env: javaProcessEnvironment(environment),
  });
  const output = `${stdout}\n${stderr}`;
  const version = output.match(/^\s*java\.version\s*=\s*(\S+)/m)?.[1];
  const vendor = output.match(/^\s*java\.vendor\s*=\s*(.+)/m)?.[1]?.trim();
  const match = version?.match(/^(\d+)(?:\.(\d+))?/);
  if (!match || !vendor) {
    throw new Error(`Could not determine the Java version from ${javaTool}`);
  }
  const feature = Number(match[1] === "1" ? match[2] : match[1]);
  if (tool !== "java" && !new RegExp(`^${tool} ${feature}(?:[.\\s]|$)`, "m").test(output)) {
    throw new Error(`The ${tool} version does not match its JVM feature ${feature}.`);
  }
  return {
    feature,
    version,
    vendor,
    output: output.trim(),
  };
}

export async function assertJavaFeature(javaTool, expectedFeature, environment = process.env) {
  const version = await readJavaFeature(javaTool, environment);
  if (version.feature !== Number(expectedFeature)) {
    throw new Error(
      `${javaTool} reports Java ${version.feature}, but this operation requires Java ${expectedFeature}.`,
    );
  }
  if (version.vendor !== "Oracle Corporation") {
    throw new Error(`${javaTool} reports vendor ${version.vendor}; Oracle Corporation is required.`);
  }
  return version;
}

export function expectedPaperApiJarName(compatibility) {
  return `paper-api-${compatibility.paperApiCoordinate}.jar`;
}

export function classMajorForJava(feature) {
  return Number(feature) + 44;
}
