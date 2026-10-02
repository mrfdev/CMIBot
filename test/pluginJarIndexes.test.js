import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readRuntimeExport } from "../scripts/plugin-jar-indexes.mjs";
import { loadEntriesFromLogProfile } from "../src/logIndex.js";

async function readFixture(t, rows) {
  const serverDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "cmibot-runtime-indexes-"));
  t.after(() => fs.rm(serverDirectory, { recursive: true, force: true }));
  const exportDirectory = path.join(serverDirectory, "plugins", "LookupRuntimeExporter");
  await fs.mkdir(exportDirectory, { recursive: true });
  await fs.writeFile(
    path.join(exportDirectory, "generated-indexes.tsv"),
    [
      "kind\tplugin\tkey\tdescription\targuments\taliases\tsource",
      ...rows.map(([kind, plugin, key]) =>
        [kind, plugin, key, "Runtime description", "", "", "runtime-enum"].join("\t")),
      "",
    ].join("\n"),
    "utf8",
  );
  return readRuntimeExport(serverDirectory);
}

test("CMI runtime placeholders normalize double-bracketed argument metadata", async (t) => {
  const runtime = await readFixture(t, [
    ["placeholder", "cmi", "%cmi_bungee_current_[[serverName]]%"],
    ["placeholder", "cmi", "%cmi_jail_reason_[[jailName]]_[[cellId]]%"],
    ["placeholder", "cmi", "%cmi_baltop_name_[[1-10]]%"],
    ["placeholder", "cmi", "%cmi_user_itemcount_[[itemIdName(:data)]]%"],
  ]);

  assert.deepEqual(runtime.rowsByPlugin.get("cmi").placeholder.map((row) => row.key), [
    "%cmi_bungee_current_[serverName]%",
    "%cmi_jail_reason_[jailName]_[cellId]%",
    "%cmi_baltop_name_[1-10]%",
    "%cmi_user_itemcount_[itemIdName(:data)]%",
  ]);
  assert.ok(runtime.rowsByPlugin.get("cmi").placeholder.every((row) =>
    row.description === "Runtime description" && row.source === "runtime-enum"));
  assert.deepEqual(runtime.globalWarnings, []);
});

test("CMI argument normalization preserves valid syntax and unrelated runtime metadata", async (t) => {
  const cmiKeys = [
    "%cmi_user_uuid%",
    "%cmi_user_uuid_[playerName]%",
    "%cmi_material_realname_$1%",
    "%cmi_user_options_[msg|tp|pay]%",
    "%cmi_user_vanish_state_[isVanished,damageToEntity,playerDamage]%",
    "%other_[[argument]]%",
  ];
  const runtime = await readFixture(t, [
    ...cmiKeys.map((key) => ["placeholder", "cmi", key]),
    ["placeholder", "jobs", "%jobs_[[argument]]%"],
    ["command", "cmi", "/cmi example [[argument]]"],
    ["permission", "cmi", "cmi.example.[[argument]]"],
  ]);

  assert.deepEqual(runtime.rowsByPlugin.get("cmi").placeholder.map((row) => row.key), cmiKeys);
  assert.equal(runtime.rowsByPlugin.get("jobs").placeholder[0].key, "%jobs_[[argument]]%");
  assert.equal(runtime.rowsByPlugin.get("cmi").command[0].key, "/cmi example [[argument]]");
  assert.equal(runtime.rowsByPlugin.get("cmi").permission[0].key, "cmi.example.[[argument]]");
});

test("normalized CMI runtime placeholders remain deduplicated against curated entries", async (t) => {
  const runtime = await readFixture(t, [
    ["placeholder", "cmi", "%cmi_bungee_current_[[serverName]]%"],
    ["placeholder", "cmi", "%cmi_user_vanish_state_[isVanished,damageToEntity]%"],
  ]);
  const entries = await loadEntriesFromLogProfile(
    { name: "placeholder", parserType: "commentBlocks" },
    process.cwd(),
    {
      sourceFiles: [
        {
          relativePath: "placeholders.log",
          fileText: "# Curated description\n%cmi_bungee_current_[serverName]%\n",
        },
        {
          relativePath: "generated-placeholders.log",
          fileText: runtime.rowsByPlugin.get("cmi").placeholder
            .map((row) => `# ${row.description}\n${row.key}`).join("\n\n"),
        },
      ],
    },
  );

  assert.deepEqual(entries.map((entry) => entry.key), [
    "%cmi_bungee_current_[serverName]%",
    "%cmi_user_vanish_state_[isVanished,damageToEntity]%",
  ]);
  assert.equal(entries[0].relativePath, "placeholders.log");
  assert.equal(entries[0].value, "Curated description");
});
