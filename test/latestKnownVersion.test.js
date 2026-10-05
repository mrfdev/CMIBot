import assert from "node:assert/strict";
import test from "node:test";
import {
  formatLatestVersions,
  formatPublicLatestVersions,
  getVersionAttentionSummary,
} from "../src/versionCatalog.js";

const TRADEME = { id: "trademe", label: "TradeMe" };

function laggingSnapshot() {
  return {
    checkEnabled: true,
    catalog: {
      generatedAt: "2026-10-05T10:00:00.000Z",
      paper: { label: "Paper", version: "26.3", build: 152, channel: "BETA" },
      companions: [],
      plugins: [
        { id: "trademe", contextId: "trademe", label: "TradeMe", version: "6.2.3.3", resourceId: 7544 },
        { id: "cmilib", label: "CMILib", version: "1.6.0.1" },
      ],
    },
    plugins: new Map([
      ["trademe", { version: "6.2.3.2", stale: false }],
      ["cmilib", { version: "1.6.0.1", stale: false }],
    ]),
    companions: new Map(),
  };
}

test("public latest does not recommend an older feed version than the verified TradeMe release", () => {
  const output = formatPublicLatestVersions(laggingSnapshot(), TRADEME);
  assert.match(output, /TradeMe:\*\* `6\.2\.3\.3` \(verified release; upstream listing is behind\)/);
  assert.doesNotMatch(output, /`6\.2\.3\.2`/);
  assert.match(output, /these latest known releases/);
});

test("private latest leads with the verified release but keeps the feed evidence and attention state", () => {
  const snapshot = laggingSnapshot();
  const before = structuredClone(snapshot);
  for (const scope of ["context", "all"]) {
    const output = formatLatestVersions(snapshot, TRADEME, scope);
    assert.match(output, /TradeMe:\*\* latest known `6\.2\.3\.3` \(verified clean snapshot\) \| upstream `6\.2\.3\.2` \(listing behind verified release\)/);
  }
  formatPublicLatestVersions(snapshot, TRADEME);
  assert.deepEqual(snapshot, before);
  assert.deepEqual(getVersionAttentionSummary(snapshot).updateKeys, []);
});

test("a matching or newer feed automatically takes priority again", () => {
  for (const version of ["6.2.3.3", "6.2.3.4"]) {
    const snapshot = laggingSnapshot();
    snapshot.plugins.set("trademe", { version });
    const output = formatPublicLatestVersions(snapshot, TRADEME);
    assert.ok(output.includes(`TradeMe:** \`${version}\``));
    assert.doesNotMatch(output, /verified release|listing is behind|latest known releases/);
    assert.match(output, /these current releases/);
    assert.deepEqual(getVersionAttentionSummary(snapshot).updateKeys, version === "6.2.3.4" ? ["plugin:trademe"] : []);
  }
});

test("selection is numeric and works for other plugin contexts and shared CMILib", () => {
  const snapshot = laggingSnapshot();
  Object.assign(snapshot.catalog.plugins[0], { id: "cmi", contextId: "cmi", label: "CMI", version: "9.8.10.10" });
  snapshot.catalog.plugins[1].version = "1.6.0.2";
  snapshot.plugins.set("cmi", { version: "9.8.10.9" });
  const output = formatPublicLatestVersions(snapshot, { id: "cmi", label: "CMI" });
  assert.match(output, /CMI:\*\* `9\.8\.10\.10` \(verified release; upstream listing is behind\)/);
  assert.match(output, /CMILib:\*\* `1\.6\.0\.2` \(verified release; upstream listing is behind\)/);
});

test("prerelease and development identifiers do not override the feed", () => {
  for (const version of ["6.2.3.4-SNAPSHOT", "6.2.3.4-beta.1", "6.2.3.4+custom", "v6.2.3.4"]) {
    const snapshot = laggingSnapshot();
    snapshot.catalog.plugins[0].version = version;
    const output = formatPublicLatestVersions(snapshot, TRADEME);
    assert.match(output, /TradeMe:\*\* `6\.2\.3\.2`/);
    assert.doesNotMatch(output, /verified release|listing is behind/);
  }
});

test("failed refreshes do not mislabel a verified release as a retained upstream result", () => {
  const snapshot = laggingSnapshot();
  snapshot.plugins.get("trademe").stale = true;
  snapshot.plugins.get("cmilib").stale = true;
  const output = formatPublicLatestVersions(snapshot, TRADEME);
  assert.match(output, /TradeMe:\*\* `6\.2\.3\.3` \(verified release; upstream listing is behind\) \*\*\(upstream refresh unavailable\)\*\*/);
  assert.match(output, /CMILib:\*\* `1\.6\.0\.1` \*\*\(last known; live refresh unavailable\)\*\*/);
  assert.match(output, /A live refresh failed for CMILib; the marked version is the last successfully checked result/);
  assert.doesNotMatch(output, /A live refresh failed for TradeMe/);
  assert.match(formatLatestVersions(snapshot, TRADEME), /upstream `6\.2\.3\.2` \(listing behind verified release; \*\*last known, refresh unavailable\*\*\)/);
});

test("missing or disabled upstream checks retain their existing public failure behavior", () => {
  const snapshot = laggingSnapshot();
  assert.throws(() => formatPublicLatestVersions({ ...snapshot, checkEnabled: false }, TRADEME), /checks are disabled/);
  snapshot.plugins.delete("trademe");
  assert.throws(() => formatPublicLatestVersions(snapshot, TRADEME), /currently unavailable for TradeMe/);
});

test("verified fallback rejects malformed identifiers and does not publish private catalog details", () => {
  for (const source of ["catalog", "upstream"]) {
    const snapshot = laggingSnapshot();
    const entry = source === "catalog" ? snapshot.catalog.plugins[0] : snapshot.plugins.get("trademe");
    entry.version = "6.2.3.3`\n@everyone";
    assert.throws(() => formatPublicLatestVersions(snapshot, TRADEME), /safe version identifier/);
  }
  const snapshot = laggingSnapshot();
  Object.assign(snapshot.catalog.plugins[0], {
    jar: "/private-fixture/example.jar",
    resourceUrl: "https://www.spigotmc.org/resources/7544/",
  });
  const output = formatPublicLatestVersions(snapshot, TRADEME);
  assert.match(output, /\[TradeMe\]\(<https:\/\/www\.spigotmc\.org\/resources\/7544\/>\):\*\* `6\.2\.3\.3`/);
  assert.doesNotMatch(output, /private-fixture|example\.jar|clean snapshot|2026-10-05|<t:/);
});
