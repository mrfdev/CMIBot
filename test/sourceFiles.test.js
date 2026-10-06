import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildLanguageCategoryStats } from "../src/langStats.js";
import { loadProfileSourceSnapshot } from "../src/profileSources.js";
import { discoverSourceFiles } from "../src/sourceFiles.js";

async function makeWorkspace(t, files) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cmibot-source-files-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const relativePath of files) {
    const filePath = path.join(root, relativePath);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, `Source: ${relativePath}\n`);
  }
  return root;
}

test("source discovery preserves overlapping globs, exclusions and hidden-file behavior", async (t) => {
  const root = await makeWorkspace(t, [
    "Plugin/config.yml",
    "Plugin/Settings/feature.yml",
    "Plugin/Settings/skip.yml",
    "Plugin/Logs/private.yml",
    "Plugin/.hidden.yml",
    "Plugin/.hidden/nested.yml",
  ]);
  await fs.mkdir(path.join(root, "Plugin/directory.yml"));
  const profile = {
    include: ["Plugin/**/*.yml", "Plugin/config.yml", "!Plugin/Settings/skip.yml"],
    exclude: ["**/Logs/**"],
  };
  const snapshot = await loadProfileSourceSnapshot(profile, root);
  assert.deepEqual(snapshot.files.map((file) => file.relativePath), [
    "Plugin/Settings/feature.yml",
    "Plugin/config.yml",
  ]);
  const reordered = await loadProfileSourceSnapshot({
    ...profile,
    include: [...profile.include].reverse(),
  }, root);
  assert.equal(reordered.fingerprint, snapshot.fingerprint);
  assert.deepEqual((await discoverSourceFiles(root, [
    "Plugin/.hidden.yml", "Plugin/.hidden/*.yml",
  ])).sort(), ["Plugin/.hidden.yml", "Plugin/.hidden/nested.yml"]);
  assert.deepEqual(await discoverSourceFiles(root, []), []);
  assert.deepEqual(await discoverSourceFiles(root, ["!Plugin/**"]), []);
  assert.deepEqual(await discoverSourceFiles(root, ["missing/**/*.yml"]), []);
  assert.deepEqual(await discoverSourceFiles(root, ["Plugin/config.yml"], ["./Plugin/config.yml"]), []);
  assert.deepEqual(await discoverSourceFiles(root, ["Plugin/**/*.yml"], ["Plugin"]), []);
  assert.deepEqual(await discoverSourceFiles(root, ["Plugin/Logs/private.yml"], ["**/Logs/**"]), []);
});

test("source discovery skips symlink files and directory paths, including explicit paths", async (t) => {
  const root = await makeWorkspace(t, ["Plugin/config.yml"]);
  const outside = await makeWorkspace(t, ["private.yml", "nested/private.yml"]);
  await fs.symlink(path.join(outside, "private.yml"), path.join(root, "Plugin/link.yml"));
  await fs.symlink(outside, path.join(root, "Plugin/linked-directory"), "dir");
  await fs.symlink(path.join(root, "Plugin"), path.join(root, "alias"), "dir");
  const snapshot = await loadProfileSourceSnapshot({
    include: [
      "**/*.yml",
      "Plugin/link.yml",
      "Plugin/linked-directory/*.yml",
      "Plugin/linked-directory/nested/private.yml",
      "alias/config.yml",
    ],
    exclude: [],
  }, root);
  assert.deepEqual(snapshot.files.map((file) => file.relativePath), ["Plugin/config.yml"]);
  for (const pattern of ["../private.yml", "/private.yml", "Plugin/../private.yml"]) {
    await assert.rejects(
      () => loadProfileSourceSnapshot({ include: [pattern], exclude: [] }, root),
      /discovery failed safely/,
    );
  }
});

test("language statistics count regular siblings once across locale filename conventions", async (t) => {
  const root = await makeWorkspace(t, [
    "CMIPlugin/CMI/Translations/Locale_EN.yml",
    "CMIPlugin/CMI/Translations/Locale_NL.yml",
    "CMIPlugin/CMI/Translations/.hidden/Locale_FR.yml",
    "JobsPlugin/locale/messages_en.yml",
    "JobsPlugin/locale/messages_de.yml",
    "ResidencePlugin/Language/English.yml",
    "ResidencePlugin/Language/Spanish.yml",
  ]);
  const locales = "CMIPlugin/CMI/Translations";
  await fs.mkdir(path.join(root, locales, "Locale_JP.yml"));
  await fs.symlink("Locale_EN.yml", path.join(root, locales, "Locale_FR.yml"));
  const categories = await buildLanguageCategoryStats(root, [
    `${locales}/**/Locale_EN.yml`,
    `${locales}/Locale_EN.yml`,
    "JobsPlugin/locale/messages_en.yml",
    "ResidencePlugin/Language/English.yml",
  ]);
  assert.deepEqual(categories.map(({ languageCodes, languageCount }) => ({ languageCodes, languageCount })), [
    { languageCodes: ["EN", "NL"], languageCount: 2 },
    { languageCodes: ["DE", "EN"], languageCount: 2 },
    { languageCodes: ["EN", "ES"], languageCount: 2 },
  ]);
});
