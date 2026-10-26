import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { javaProcessEnvironment, resolveJavaTool, runtimeServerPaths } from "../scripts/runtime-compatibility.mjs";

test("runtime server paths follow the manifest across Paper minor versions", () => {
  const root = path.join(os.tmpdir(), "cmibot-runtime-paths");
  for (const paperVersion of ["26.2", "26.3", "26.4-rc-1"]) {
    assert.deepEqual(runtimeServerPaths(root, { paperVersion }), {
      serversRoot: path.join(root, "servers"),
      templateDirectory: path.join(root, "servers", `_template-Paper-${paperVersion}`),
      serverDirectory: path.join(root, "servers", `Paper-${paperVersion}`),
    });
  }
});

test("runtime server paths reject missing versions and path traversal", () => {
  for (const paperVersion of [undefined, null, 26.3, "", "../26.3", "26.3/../../other", "26.3\\other"]) {
    assert.throws(() => runtimeServerPaths(os.tmpdir(), { paperVersion }), /Invalid Paper version/);
  }
});

const compatibility = { javaTarget: 25, javaTestTarget: 27 };

async function jdkFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cmibot-java-home-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const javaHomeCommand = path.join(root, "java_home");
  async function install(name, version, vendor = "Oracle Corporation", toolVersion = version) {
    const home = path.join(root, name);
    await fs.mkdir(path.join(home, "bin"), { recursive: true });
    for (const tool of ["java", "javac", "jar"]) {
      const binary = path.join(home, "bin", tool);
      await fs.writeFile(binary, `#!/bin/sh\n[ -z "$JAVA_TOOL_OPTIONS$_JAVA_OPTIONS$JDK_JAVA_OPTIONS$JDK_JAVAC_OPTIONS$CLASSPATH" ] || exit 42\nprintf '%s\\n' 'java.version = ${version}' 'java.vendor = ${vendor}' '${tool} ${toolVersion}'\n`);
      await fs.chmod(binary, 0o755);
    }
    return home;
  }
  async function discover(home, feature) {
    await fs.writeFile(javaHomeCommand, `#!/bin/sh\n[ "$1" = '-F' ] && [ "$2" = '-v' ] && [ "$3" = '${feature}' ] || exit 1\nprintf '%s\\n' '${home}'\n`);
    await fs.chmod(javaHomeCommand, 0o755);
  }
  return { root, install, discover, javaHomeCommand };
}

test("JDK discovery uses fail-fast major selection and follows patch replacements on every invocation", async t => {
  const f = await jdkFixture(t);
  for (const feature of [25, 27]) {
    for (const suffix of ["old", "new"]) {
      const home = await f.install(`jdk-${feature}-${suffix}`, `${feature}.0.${suffix === "old" ? 1 : 2}`);
      await f.discover(home, feature);
      const tool = feature === 25 ? "javac" : "java";
      assert.equal(await resolveJavaTool(compatibility, {
        feature, tool, environment: { JAVA_HOME: "/untrusted/default" }, javaHomeCommand: f.javaHomeCommand,
      }), path.join(home, "bin", tool));
    }
  }
});

test("explicit installed Oracle build and test homes are validated without discovery", async t => {
  const f = await jdkFixture(t);
  const build = await f.install("build", "25.0.5");
  const runtime = await f.install("test", "27.0.1");
  const environment = { ONE_MB_BUILD_JAVA_HOME: build, ONE_MB_TEST_JAVA_HOME: runtime };
  for (const [feature, tool, home] of [[25, "javac", build], [25, "jar", build], [27, "java", runtime]]) {
    assert.equal(await resolveJavaTool(compatibility, { feature, tool, environment, javaHomeCommand: "/missing" }), path.join(home, "bin", tool));
  }
});

test("wrong vendors and wrong majors fail for discovered and explicit selections", async t => {
  const f = await jdkFixture(t);
  for (const [version, vendor, error] of [["25.0.5", "Eclipse Adoptium", /Oracle Corporation is required/], ["27.0.1", "Oracle Corporation", /requires Java 25/]]) {
    const home = await f.install(`invalid-${version}`, version, vendor);
    await f.discover(home, 25);
    for (const environment of [{}, { ONE_MB_BUILD_JAVA_HOME: home }]) {
      await assert.rejects(resolveJavaTool(compatibility, { tool: "javac", environment, javaHomeCommand: f.javaHomeCommand }), error);
    }
  }
});

test("missing or invalid installed homes never download or fall back from an override", async t => {
  const f = await jdkFixture(t);
  const valid = await f.install("valid", "25.0.5");
  await f.discover(valid, 25);
  await assert.rejects(resolveJavaTool(compatibility, { environment: {}, javaHomeCommand: "/missing" }), /automatic downloads are disabled/);
  await assert.rejects(resolveJavaTool(compatibility, { environment: { ONE_MB_BUILD_JAVA_HOME: "/missing" }, javaHomeCommand: f.javaHomeCommand }), /missing or not executable/);
  await assert.rejects(resolveJavaTool(compatibility, { javaHome: "relative", environment: {}, javaHomeCommand: f.javaHomeCommand }), /valid installed Oracle JDK home/);
});

test("binary overrides, mismatched compiler JVMs and unsupported majors cannot bypass validation", async t => {
  const f = await jdkFixture(t);
  const home = await f.install("mismatch", "25.0.5", "Oracle Corporation", "27.0.1");
  for (const key of ["JAVA_BIN", "JAVAC_BIN", "JAR_BIN"]) {
    await assert.rejects(resolveJavaTool(compatibility, { environment: { [key]: "/override" } }), /Individual Java binary overrides/);
  }
  await assert.rejects(resolveJavaTool(compatibility, { feature: 26 }), /Only Oracle JDK 25/);
  await assert.rejects(resolveJavaTool(compatibility, { tool: "javac", javaHome: home, environment: {} }), /does not match its JVM/);
});

test("Java environment hooks cannot inject flags into validation or child JVMs", async t => {
  const f = await jdkFixture(t);
  const home = await f.install("installed", "25.0.5");
  const environment = { ONE_MB_BUILD_JAVA_HOME: home, PATH: "/usr/bin", JAVA_TOOL_OPTIONS: "bad", _JAVA_OPTIONS: "bad", JDK_JAVA_OPTIONS: "bad", JDK_JAVAC_OPTIONS: "--release 27", CLASSPATH: "bad" };
  assert.deepEqual(javaProcessEnvironment(environment), { ONE_MB_BUILD_JAVA_HOME: home, PATH: "/usr/bin" });
  assert.equal(environment.JDK_JAVAC_OPTIONS, "--release 27");
  assert.equal(await resolveJavaTool(compatibility, { tool: "javac", environment }), path.join(home, "bin", "javac"));
});
