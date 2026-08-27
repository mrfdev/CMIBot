import assert from "node:assert/strict";
import test from "node:test";
import {
  extractEntriesFromText,
  makeDisplayContext,
  materializeIndexedYamlContext,
} from "../src/yamlIndex.js";

const YAML_DOCUMENT = [
  "Root:",
  "  Before: true",
  "  # target comment",
  "  Target:",
  "    Child: one",
  "    Nested:",
  "      Value: two",
  "  After: false",
  "Tail: done",
].join("\n");

test("indexed YAML entries retain exact nested blocks with bounded surrounding lines", () => {
  const entries = extractEntriesFromText(YAML_DOCUMENT, "CMIPlugin/CMI/config.yml");
  const target = entries.find((entry) => entry.yamlPath === "Root.Target");
  const root = entries.find((entry) => entry.yamlPath === "Root");

  const targetContext = materializeIndexedYamlContext(target, { surroundingLineCount: 1 });
  assert.deepEqual(
    {
      startLine: targetContext.startLine,
      endLine: targetContext.endLine,
      blockStartLine: targetContext.blockStartLine,
      blockEndLine: targetContext.blockEndLine,
    },
    { startLine: 2, endLine: 8, blockStartLine: 3, blockEndLine: 7 },
  );
  assert.match(targetContext.snippet, /^  Before: true/m);
  assert.match(targetContext.snippet, /  # target comment\n  Target:/);
  assert.match(targetContext.snippet, /    Nested:\n      Value: two/);
  assert.match(targetContext.snippet, /  After: false$/m);
  assert.doesNotMatch(targetContext.snippet, /Tail: done/);

  const rootContext = materializeIndexedYamlContext(root, { surroundingLineCount: 0 });
  assert.equal(rootContext.startLine, 1);
  assert.equal(rootContext.endLine, 8);
  assert.match(rootContext.snippet, /Root:[\s\S]*  After: false$/);
  assert.doesNotMatch(rootContext.snippet, /Tail: done/);
});

test("indexed YAML source metadata is opt-in and omitted from serialization", () => {
  const entries = extractEntriesFromText(YAML_DOCUMENT, "CMIPlugin/CMI/config.yml");
  const target = entries.find((entry) => entry.yamlPath === "Root.Target");

  assert.equal(Object.keys(target).includes("indexedYamlContext"), false);
  assert.doesNotMatch(JSON.stringify(target), /Before: true|After: false|indexedYamlContext/);

  const formatDisplayPath = (_pluginId, relativePath) => relativePath;
  const compact = makeDisplayContext(target, "cmi", formatDisplayPath);
  assert.equal(materializeIndexedYamlContext(compact), null);

  const expandable = makeDisplayContext(target, "cmi", formatDisplayPath, {
    includeIndexedYamlContext: true,
  });
  assert.equal(Object.keys(expandable).includes("indexedYamlContext"), false);
  assert.match(materializeIndexedYamlContext(expandable).snippet, /Nested:\n      Value: two/);
  assert.doesNotMatch(JSON.stringify(expandable), /Before: true|After: false|indexedYamlContext/);
});
