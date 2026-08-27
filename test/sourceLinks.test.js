import assert from "node:assert/strict";
import test from "node:test";
import {
  buildPinnedSourceUrl,
  normalizePublicGitHubRepositoryUrl,
} from "../src/sourceLinks.js";

const REVISION = "abcdef1234567890abcdef1234567890abcdef12";

test("source links pin safe indexed paths to an exact deployed commit", () => {
  const sourceUrl = buildPinnedSourceUrl({
    repositoryUrl: "https://github.com/mrfdev/CMIBot.git",
    revision: REVISION,
    relativePath: "CMIPlugin/CMI/Settings/Chat config.yml",
    lineNumber: 42,
    allowedRoots: ["CMIPlugin"],
  });

  assert.equal(
    sourceUrl,
    `https://github.com/mrfdev/CMIBot/blob/${REVISION}/CMIPlugin/CMI/Settings/Chat%20config.yml#L42`,
  );
  assert.equal(
    normalizePublicGitHubRepositoryUrl("https://github.com/mrfdev/CMIBot.git"),
    "https://github.com/mrfdev/CMIBot",
  );
  assert.match(
    buildPinnedSourceUrl({
      repositoryUrl: "https://github.com/mrfdev/CMIBot",
      revision: REVISION,
      relativePath: "CMIPlugin/data/commands.log",
      lineNumber: 2,
      allowedRoots: ["CMIPlugin"],
    }),
    /CMIPlugin\/data\/commands\.log#L2$/,
  );
});

test("source links fail closed for mutable, private, sensitive, or escaping targets", () => {
  const base = {
    repositoryUrl: "https://github.com/mrfdev/CMIBot",
    revision: REVISION,
    relativePath: "CMIPlugin/CMI/config.yml",
    lineNumber: 1,
    allowedRoots: ["CMIPlugin"],
  };

  assert.equal(buildPinnedSourceUrl({ ...base, revision: "abcdef123456" }), "");
  assert.equal(buildPinnedSourceUrl({ ...base, repositoryUrl: "https://private-host/repo" }), "");
  assert.equal(buildPinnedSourceUrl({ ...base, repositoryUrl: "http://github.com/mrfdev/CMIBot" }), "");
  assert.equal(buildPinnedSourceUrl({ ...base, repositoryUrl: "https://github.com:444/mrfdev/CMIBot" }), "");
  assert.equal(buildPinnedSourceUrl({ ...base, relativePath: "../etc/passwd" }), "");
  assert.equal(buildPinnedSourceUrl({ ...base, relativePath: "CMIPlugin/secret.key" }), "");
  assert.equal(buildPinnedSourceUrl({ ...base, enabled: false }), "");
});
