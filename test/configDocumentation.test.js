import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.js";
import { renderConfigArtifacts, validateConfigMetadata } from "../src/configDocumentation.js";
import { configMetadata, getEnvironmentVariables, pluginProfileMetadata } from "../src/configMetadata.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("generated configuration artifacts never read or expose live environment values", () => {
  const canaryValue = "never-copy-this-live-value";
  const overrides = {
    CMIBOT_DOCUMENTATION_CANARY: canaryValue,
    DISCORD_TOKEN: canaryValue,
    DISCORD_GUILD_ID: "987654321098765432",
    OLLAMA_MODEL: canaryValue,
  };
  const previous = Object.fromEntries(
    Object.keys(overrides).map((name) => [name, process.env[name]]),
  );
  Object.assign(process.env, overrides);
  try {
    const artifacts = renderConfigArtifacts();
    const combined = Object.values(artifacts).join("\n");
    assert.doesNotMatch(combined, new RegExp(canaryValue));
    assert.doesNotMatch(combined, /\b\d{17,20}\b|\/(?:Users|home)\/|\.\.\/etc|Bearer\s+\S{16,}/i);
    assert.match(artifacts[".env.example"], /^DISCORD_TOKEN=$/m);
    assert.match(artifacts[".env.example"], /^DISCORD_GUILD_ID=$/m);
    assert.match(artifacts[".env.example"], /^OLLAMA_MODEL=qwen3:8b$/m);

    const schema = JSON.parse(artifacts["docs/generated/environment.schema.json"]);
    assert.equal("default" in schema.properties.DISCORD_TOKEN, false);
    assert.equal("default" in schema.properties.DISCORD_GUILD_ID, false);
    assert.equal(schema.properties.DISCORD_TOKEN.writeOnly, true);
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
});

test("metadata rejects sensitive defaults and path traversal", () => {
  const secretMetadata = structuredClone(configMetadata);
  secretMetadata.environmentSections[0].variables[0].defaultValue = "do-not-publish";
  assert.throws(() => validateConfigMetadata(secretMetadata), /sensitive default/i);

  const traversalMetadata = structuredClone(configMetadata);
  traversalMetadata.pluginProfiles[0].profiles[0].includeDefault = "../etc/passwd";
  assert.throws(() => validateConfigMetadata(traversalMetadata), /unsafe generated path/i);
});

test("configuration metadata covers runtime environment access and plugin profiles", async () => {
  const source = await fs.readFile(path.join(repositoryRoot, "src", "config.js"), "utf8");
  const staticEnvironmentNames = [...source.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)].map(
    (match) => match[1],
  );
  const documentedNames = new Set(getEnvironmentVariables().map((entry) => entry.name));
  assert.deepEqual(staticEnvironmentNames.filter((name) => !documentedNames.has(name)), []);

  for (const plugin of pluginProfileMetadata) {
    for (const profile of plugin.profiles) {
      assert.equal(documentedNames.has(profile.includeVariable), true);
      assert.equal(documentedNames.has(profile.excludeVariable), true);
    }
  }

  const config = loadConfig();
  const runtimeGroups = new Map([
    ["cmilib", config.sharedCmilib],
    ...Object.entries(config.plugins),
  ]);
  for (const plugin of pluginProfileMetadata) {
    const runtime = runtimeGroups.get(plugin.id);
    assert.ok(runtime);
    assert.deepEqual(Object.keys(runtime.profiles).sort(), plugin.profiles.map((profile) => profile.id).sort());
    for (const profile of plugin.profiles) {
      assert.equal(runtime.profiles[profile.id].sourceType, profile.sourceType);
    }
  }
});
