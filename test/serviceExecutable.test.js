import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { stableServiceExecutable } from "../scripts/service-executable.mjs";

const execFileAsync = promisify(execFile);

async function createKeg(prefix, formula, version) {
  const keg = path.join(prefix, "Cellar", formula, version);
  await fs.mkdir(path.join(keg, "bin"), { recursive: true });
  await fs.writeFile(path.join(keg, "bin", "node"), `#!/bin/sh\nprintf '%s\\n' '${version}'\n`, { mode: 0o755 });
  return keg;
}

test("a service executable follows its Homebrew formula link after upgrade and old-keg cleanup", async () => {
  const prefix = await fs.mkdtemp(path.join(os.tmpdir(), "lookupbot-service-executable-"));
  try {
    const oldKeg = await createKeg(prefix, "node@24", "24.1.0");
    const otherKeg = await createKeg(prefix, "node", "26.1.0");
    await fs.mkdir(path.join(prefix, "opt"));
    await fs.mkdir(path.join(prefix, "bin"));
    const formulaLink = path.join(prefix, "opt", "node@24");
    await fs.symlink(oldKeg, formulaLink);
    await fs.symlink(path.join(otherKeg, "bin", "node"), path.join(prefix, "bin", "node"));

    const selected = await stableServiceExecutable(path.join(oldKeg, "bin", "node"));
    assert.equal(selected, path.join(formulaLink, "bin", "node"));
    const newKeg = await createKeg(prefix, "node@24", "24.2.0");
    await fs.unlink(formulaLink);
    await fs.symlink(newKeg, formulaLink);
    await fs.rm(oldKeg, { recursive: true });

    const result = await execFileAsync(selected, [], { encoding: "utf8" });
    assert.equal(result.stdout, "24.2.0\n");
  } finally {
    await fs.rm(prefix, { recursive: true, force: true });
  }
});

test("service executable selection only follows links to the original runtime", async () => {
  const prefix = await fs.mkdtemp(path.join(os.tmpdir(), "lookupbot-service-executable-"));
  try {
    const selectedKeg = await createKeg(prefix, "node", "26.1.0");
    const otherKeg = await createKeg(prefix, "node", "26.2.0");
    const executable = path.join(selectedKeg, "bin", "node");
    await fs.mkdir(path.join(prefix, "opt"));
    await fs.mkdir(path.join(prefix, "bin"));
    await fs.symlink(otherKeg, path.join(prefix, "opt", "node"));
    assert.equal(await stableServiceExecutable(executable), executable);

    const binaryLink = path.join(prefix, "bin", "node");
    await fs.symlink(executable, binaryLink);
    assert.equal(await stableServiceExecutable(executable), binaryLink);
    assert.equal(await stableServiceExecutable(binaryLink), binaryLink);

    await fs.unlink(binaryLink);
    await fs.symlink(path.join(otherKeg, "bin", "node"), binaryLink);
    assert.equal(await stableServiceExecutable(executable), executable);
  } finally {
    await fs.rm(prefix, { recursive: true, force: true });
  }
});
