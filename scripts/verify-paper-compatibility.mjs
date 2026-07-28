import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertJavaFeature,
  expectedPaperApiJarName,
  readRuntimeCompatibility,
  resolveJavaTool,
} from "./runtime-compatibility.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(scriptDirectory, "..");
const offline = process.argv.includes("--offline");

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label} is ${JSON.stringify(actual)}; expected ${JSON.stringify(expected)}`);
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

async function sha256File(candidate) {
  const digest = crypto.createHash("sha256");
  digest.update(await fs.readFile(candidate));
  return digest.digest("hex");
}

function readTopLevelYamlValue(yaml, key) {
  const match = yaml.match(new RegExp(`^${key}:\\s*['"]?([^\\r\\n'"]+)['"]?\\s*$`, "mi"));
  return match?.[1]?.trim() ?? "";
}

async function findFile(root, expectedName) {
  const pending = [root];
  while (pending.length) {
    const current = pending.pop();
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const absolutePath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(absolutePath);
      } else if (entry.isFile() && entry.name === expectedName) {
        return absolutePath;
      }
    }
  }
  return null;
}

async function verifyPluginMetadata(compatibility) {
  const pluginYamlPath = path.join(workspaceRoot, "runtime-exporter", "plugin.yml");
  const yaml = await fs.readFile(pluginYamlPath, "utf8");
  assertEqual(
    readTopLevelYamlValue(yaml, "version"),
    compatibility.exporterVersion,
    "Runtime exporter version",
  );
  assertEqual(
    readTopLevelYamlValue(yaml, "api-version"),
    compatibility.paperApiVersion,
    "Runtime exporter api-version",
  );
}

async function verifyServer(serverDirectory, compatibility, { requireApi }) {
  const configPath = path.join(serverDirectory, "paperscript", "config.json");
  const statePath = path.join(serverDirectory, "paperscript", "state.json");
  const paperScriptPath = path.join(serverDirectory, "paperscript", "paperscript.py");
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  const state = JSON.parse(await fs.readFile(statePath, "utf8"));
  const jarPath = path.join(serverDirectory, compatibility.paperJar);

  assertEqual(String(config.default_channel).toUpperCase(), compatibility.paperChannel, "PaperScript default channel");
  assertEqual(
    String(config.check_latest_channel_only).toUpperCase(),
    compatibility.paperChannel,
    "PaperScript latest-check channel",
  );
  assertEqual(config.allow_same_version_build_upgrade, true, "PaperScript same-version build upgrades");
  assertEqual(config.download_filename_pattern, "Paper-{version}.jar", "PaperScript jar filename pattern");
  assertEqual(config.fallback_process_detection, false, "PaperScript fallback process detection");
  assertEqual(String(state.current_version), compatibility.paperVersion, "Installed Paper version");
  assertEqual(Number(state.current_build), compatibility.paperBuild, "Installed Paper build");
  assertEqual(String(state.current_jar), compatibility.paperJar, "Installed Paper jar name");

  const actualSha256 = await sha256File(jarPath);
  assertEqual(actualSha256, String(state.current_sha256), "Installed Paper SHA-256");
  assertEqual(actualSha256, String(state.expected_sha256), "Expected Paper SHA-256");
  assertEqual(
    await sha256File(paperScriptPath),
    compatibility.paperScriptSourceSha256,
    "PaperScript source SHA-256",
  );

  if (requireApi) {
    const expectedApiName = expectedPaperApiJarName(compatibility);
    const apiPath = await findFile(path.join(serverDirectory, "libraries"), expectedApiName);
    if (!apiPath) {
      throw new Error(`Could not find ${expectedApiName} below ${serverDirectory}/libraries`);
    }
  }

  return actualSha256;
}

async function verifyJdks(compatibility) {
  const java25 = await resolveJavaTool(compatibility, {
    feature: compatibility.javaTarget,
    javaHome: compatibility.jdk25Home,
    tool: "java",
    environment: {},
  });
  const javac25 = await resolveJavaTool(compatibility, {
    feature: compatibility.javaTarget,
    javaHome: compatibility.jdk25Home,
    tool: "javac",
    environment: {},
  });
  const java26 = await resolveJavaTool(compatibility, {
    feature: 26,
    javaHome: compatibility.jdk26Home,
    tool: "java",
    environment: {},
  });
  await assertJavaFeature(java25, compatibility.javaTarget);
  await assertJavaFeature(javac25, compatibility.javaTarget);
  await assertJavaFeature(java26, 26);
}

async function verifyLatestStable(compatibility) {
  const response = await fetch(
    `https://fill.papermc.io/v3/projects/paper/versions/${encodeURIComponent(compatibility.paperVersion)}/builds`,
    {
      headers: {
        accept: "application/json",
        "user-agent": "LookupBot-PaperCompatibility/1.0 (+https://github.com/mrfdev/CMIBot)",
      },
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (!response.ok) {
    throw new Error(`Paper Fill API returned ${response.status} ${response.statusText}`);
  }
  const payload = await response.json();
  const builds = Array.isArray(payload) ? payload : payload.builds;
  if (!Array.isArray(builds)) {
    throw new Error("Paper Fill API returned an unexpected builds response.");
  }
  const latestStable = builds
    .filter((build) => String(build.channel).toUpperCase() === compatibility.paperChannel)
    .sort((left, right) => Number(right.id) - Number(left.id))[0];
  if (!latestStable) {
    throw new Error(`No ${compatibility.paperChannel} build exists for Paper ${compatibility.paperVersion}.`);
  }
  assertEqual(Number(latestStable.id), compatibility.paperBuild, "Latest stable Paper build");
}

async function main() {
  const compatibility = await readRuntimeCompatibility(workspaceRoot);
  await verifyPluginMetadata(compatibility);
  await verifyJdks(compatibility);

  const templateDirectory = path.join(workspaceRoot, "servers", "_template-Paper-26.2");
  if (!(await pathExists(templateDirectory))) {
    if (!offline) {
      throw new Error(`Maintained Paper template is missing: ${templateDirectory}`);
    }
    console.log("[paper-check] Tracked exporter metadata and JDKs are valid; ignored server checks were skipped.");
    return;
  }

  const templateSha256 = await verifyServer(templateDirectory, compatibility, { requireApi: false });
  const activeDirectory = path.join(workspaceRoot, "servers", "Paper-26.2");
  if (await pathExists(activeDirectory)) {
    await verifyServer(activeDirectory, compatibility, { requireApi: true });
  } else if (!offline) {
    throw new Error(`Maintained Paper test server is missing: ${activeDirectory}`);
  }

  if (!offline) {
    await verifyLatestStable(compatibility);
  }

  console.log(
    `[paper-check] Paper ${compatibility.paperVersion} build ${compatibility.paperBuild} ` +
      `${compatibility.paperChannel}, API ${compatibility.paperApiCoordinate}, Java ${compatibility.javaTarget}.`,
  );
  console.log(`[paper-check] Verified SHA-256 ${templateSha256}.`);
  console.log(`[paper-check] PaperScript source commit ${compatibility.paperScriptCommit}.`);
}

await main();
