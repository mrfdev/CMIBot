import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workflowPath = path.join(repositoryRoot, ".github", "workflows", "ci.yml");
const dependabotPath = path.join(repositoryRoot, ".github", "dependabot.yml");
const packagePath = path.join(repositoryRoot, "package.json");

test("CI covers supported Node versions, checks, and the production dependency audit", async () => {
  const workflow = await fs.readFile(workflowPath, "utf8");

  assert.match(workflow, /push:\n\s+branches:\n\s+- main/);
  assert.match(workflow, /\n  pull_request:\n/);
  assert.match(workflow, /\n  workflow_dispatch:\n/);
  assert.match(workflow, /  test:\n[\s\S]*?    runs-on: macos-latest/);
  assert.match(workflow, /node-version:\n\s+- "22\.x"\n\s+- "24\.x"\n\s+- "26\.x"/);
  assert.match(workflow, /run: npm ci\n/);
  assert.match(workflow, /run: npm run check:bot/);
  assert.match(workflow, /run: npm ci --ignore-scripts/);
  assert.match(workflow, /run: npm run audit:deps/);
});

test("CI uses a least-privilege, secret-free action configuration", async () => {
  const workflow = await fs.readFile(workflowPath, "utf8");
  const actionReferences = [...workflow.matchAll(/uses:\s+[^@\s]+@([^\s]+)/g)].map((match) => match[1]);

  assert.match(workflow, /permissions:\n\s+contents: read/);
  assert.doesNotMatch(workflow, /pull_request_target/);
  assert.doesNotMatch(workflow, /\$\{\{\s*secrets\./);
  assert.equal((workflow.match(/persist-credentials: false/g) ?? []).length, 2);
  assert.equal((workflow.match(/package-manager-cache: false/g) ?? []).length, 2);
  assert.equal(actionReferences.length, 4);
  assert.equal(actionReferences.every((reference) => /^[0-9a-f]{40}$/.test(reference)), true);
});

test("Dependabot covers GitHub Actions and the package declares the supported runtime floor", async () => {
  const [dependabot, packageContents] = await Promise.all([
    fs.readFile(dependabotPath, "utf8"),
    fs.readFile(packagePath, "utf8"),
  ]);
  const packageMetadata = JSON.parse(packageContents);

  assert.match(dependabot, /package-ecosystem: github-actions/);
  assert.equal(packageMetadata.engines.node, ">=22");
});
