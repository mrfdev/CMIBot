import assert from "node:assert/strict";
import test from "node:test";
import {
  canExpandYamlContext,
  createExpandedYamlContextPayload,
} from "../src/discord/expandedContext.js";
import { extractEntriesFromText, makeDisplayContext } from "../src/yamlIndex.js";

function makeExpandableResult(fileText, yamlPath = "Root.Target") {
  const entries = extractEntriesFromText(fileText, "CMIPlugin/CMI/config.yml");
  const entry = entries.find((candidate) => candidate.yamlPath === yamlPath);
  const result = makeDisplayContext(entry, "cmi", (_pluginId, relativePath) => relativePath, {
    includeIndexedYamlContext: true,
  });
  result.sourceUrl =
    "https://github.com/example/project/blob/0123456789012345678901234567890123456789/CMIPlugin/CMI/config.yml#L4";
  return result;
}

test("expanded YAML context is private-reply ready and includes the full matched block", () => {
  const result = makeExpandableResult([
    "Root:",
    "  Before: true",
    "  Target:",
    "    Child: one",
    "    Nested:",
    "      Value: two",
    "  After: false",
    "Tail: done",
  ].join("\n"));

  assert.equal(canExpandYamlContext(result), true);
  const payload = createExpandedYamlContextPayload(result);
  assert.equal(payload.files, undefined);
  assert.deepEqual(payload.allowedMentions, { parse: [] });
  assert.match(payload.content, /Expanded YAML Context/);
  assert.match(payload.content, /matched block: `lines 3-6`/i);
  assert.match(payload.content, /Before: true/);
  assert.match(payload.content, /Target:[\s\S]*Nested:[\s\S]*Value: two/);
  assert.match(payload.content, /After: false/);
  assert.match(payload.content, /Tail: done/);
  assert.ok(payload.content.length <= 2_000);
});

test("long expanded YAML context uses a generic bounded attachment", () => {
  const result = makeExpandableResult([
    "Root:",
    "  Target:",
    `    LongValue: ${"x".repeat(600)}`,
    "    ApiToken: private-token-value",
    "Tail: done",
  ].join("\n"));

  const payload = createExpandedYamlContextPayload(result, {
    inlineSnippetLimit: 200,
    attachmentSizeLimit: 2_000,
  });
  assert.equal(payload.files.length, 1);
  assert.equal(payload.files[0].name, "lookup-context.yml");
  assert.ok(Buffer.isBuffer(payload.files[0].attachment));
  const attachmentText = payload.files[0].attachment.toString("utf8");
  assert.match(attachmentText, /LongValue: x{600}/);
  assert.match(attachmentText, /ApiToken: <redacted>/);
  assert.doesNotMatch(attachmentText, /private-token-value/);
  assert.doesNotMatch(payload.content, /x{100}/);
  assert.deepEqual(payload.allowedMentions, { parse: [] });
});

test("expanded YAML context rejects missing metadata and non-GitHub source links", () => {
  assert.equal(canExpandYamlContext({}), false);
  assert.equal(createExpandedYamlContextPayload({}), null);

  const result = makeExpandableResult("Root:\n  Target: true");
  result.sourceUrl = "https://internal.invalid/private/source";
  const payload = createExpandedYamlContextPayload(result);
  assert.doesNotMatch(payload.content, /internal\.invalid|private\/source/);
  assert.match(payload.content, /source line 2/);
});

test("expanded YAML context redacts non-empty credential values without hiding blank defaults", () => {
  const result = makeExpandableResult([
    "Root:",
    "  Target:",
    "    Password: hunter2",
    "    Api-Key: |",
    "      first-private-line",
    "      second-private-line",
    "    EmptyPassword: ''",
    "    VisibleSetting: safe-value",
  ].join("\n"));

  const payload = createExpandedYamlContextPayload(result);
  assert.match(payload.content, /Sensitive-looking non-empty values were redacted/);
  assert.match(payload.content, /Password: <redacted>/);
  assert.match(payload.content, /Api-Key: <redacted>/);
  assert.match(payload.content, /EmptyPassword: ''/);
  assert.match(payload.content, /VisibleSetting: safe-value/);
  assert.doesNotMatch(payload.content, /hunter2|first-private-line|second-private-line/);
});
