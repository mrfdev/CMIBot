import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("current documentation covers the shipped August feature set without private values", async () => {
  const [readme, changelog, discordHelp] = await Promise.all([
    fs.readFile(path.join(repositoryRoot, "README.md"), "utf8"),
    fs.readFile(path.join(repositoryRoot, "CHANGELOG.md"), "utf8"),
    fs.readFile(path.join(repositoryRoot, "src", "discord", "help.js"), "utf8"),
  ]);

  for (const pattern of [
    /Previous\/Next pagination/i,
    /commit-pinned source links/i,
    /context-aware Discord autocomplete/i,
    /Did you mean/i,
    /\/lookup files.*\/lookup categories/i,
    /expandable YAML/i,
    /related:true.*commands.*permissions/i,
    /Discord-limit trimming.*complete links.*balanced code fences/i,
    /plugin-scoped synonyms/i,
    /latest changes:true/i,
    /exponential backoff.*circuit breakers/i,
    /admin-only `\/lookup health`/i,
    /plugin- and profile-selective reloads/i,
    /aggregate private alerts/i,
    /bounded LRU cache/i,
    /structured service records/i,
    /GitHub Actions checks/i,
    /generated documentation drifts/i,
    /Paper `26\.2 build 119`.*LuckPerms `5\.5\.79`/i,
  ]) {
    assert.match(changelog, pattern);
  }

  assert.match(readme, /configure-alert-channel/);
  assert.match(readme, /configure-test-channel/);
  assert.match(readme, /never accept it as a command-line argument/i);
  assert.match(discordHelp, /related: true\|false.*matching references across supported profiles/i);

  const publicDocumentation = `${readme}\n${changelog}`;
  assert.doesNotMatch(publicDocumentation, /\b\d{17,20}\b/);
  assert.doesNotMatch(publicDocumentation, /\/(?:Users|home)\/[^\s`]+/i);
  assert.doesNotMatch(
    publicDocumentation,
    /(?:^|[^0-9])(?:10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|127(?:\.\d{1,3}){3}|169\.254(?:\.\d{1,3}){2})(?:[^0-9]|$)/,
  );
});
