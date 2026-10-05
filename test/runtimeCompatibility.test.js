import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveJavaTool, runtimeServerPaths } from "../scripts/runtime-compatibility.mjs";

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

test("resolveJavaTool follows an installed Java feature when a patch path rolls over", async () => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cmibot-java-home-"));
  const resolvedHome = path.join(temporaryRoot, "jdk-26.0.2.1", "Contents", "Home");
  const resolvedJava = path.join(resolvedHome, "bin", "java");
  const javaHomeCommand = path.join(temporaryRoot, "java_home");

  try {
    await fs.mkdir(path.dirname(resolvedJava), { recursive: true });
    await fs.writeFile(resolvedJava, "installed Java 26 placeholder\n", "utf8");
    await fs.writeFile(javaHomeCommand, `#!/bin/sh\nprintf '%s\\n' '${resolvedHome}'\n`, "utf8");
    await fs.chmod(javaHomeCommand, 0o755);

    const javaTool = await resolveJavaTool(
      {
        javaTarget: 25,
        jdk26Home: path.join(temporaryRoot, "jdk-26.0.2", "Contents", "Home"),
      },
      {
        feature: 26,
        environment: {},
        javaHomeCommand,
      },
    );

    assert.equal(javaTool, resolvedJava);
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
});
