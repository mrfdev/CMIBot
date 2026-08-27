#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderConfigArtifacts } from "../src/configDocumentation.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function checkArtifacts(artifacts) {
  const stale = [];
  for (const [relativePath, expected] of Object.entries(artifacts)) {
    try {
      const actual = await fs.readFile(path.join(repositoryRoot, relativePath), "utf8");
      if (actual !== expected) {
        stale.push(relativePath);
      }
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
      stale.push(relativePath);
    }
  }
  if (stale.length) {
    throw new Error("Generated configuration artifacts are stale. Run npm run docs:generate.");
  }
}

async function writeArtifacts(artifacts) {
  for (const [relativePath, content] of Object.entries(artifacts)) {
    const destination = path.join(repositoryRoot, relativePath);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, content, "utf8");
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== "--check")) {
    throw new Error("Usage: generate-config-docs.mjs [--check]");
  }
  const artifacts = renderConfigArtifacts();
  if (args[0] === "--check") {
    await checkArtifacts(artifacts);
    console.log("Generated configuration artifacts are current.");
    return;
  }
  await writeArtifacts(artifacts);
  console.log("Generated configuration artifacts updated.");
}

main().catch((error) => {
  console.error(`Configuration documentation generation failed: ${error.message}`);
  process.exitCode = 1;
});
