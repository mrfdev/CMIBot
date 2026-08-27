import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const remoteScript = path.join(repositoryRoot, "scripts", "remote");
const defaultConfiguration = {
  host: "test-private-host",
  nodePath: "/runtime/node",
  projectRoot: "/srv/lookupbot",
};
const sshPrefix = ["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", defaultConfiguration.host];

function execFileWithInput(file, args, options, input) {
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, options, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
    child.stdin.end(input);
  });
}

async function createFixture(
  temporaryRoot,
  { configuration = defaultConfiguration, exitCode = 0, captureStdin = false } = {},
) {
  const sshPath = path.join(temporaryRoot, "ssh");
  const argumentsPath = path.join(temporaryRoot, "ssh-arguments.txt");
  const stdinPath = path.join(temporaryRoot, "ssh-stdin.txt");
  const configurationPath = path.join(temporaryRoot, "remote.json");
  await fs.writeFile(configurationPath, `${JSON.stringify(configuration, null, 2)}\n`, { mode: 0o600 });
  await fs.writeFile(
    sshPath,
    [
      "#!/bin/sh",
      "set -eu",
      ": > \"$CMIBOT_TEST_SSH_ARGUMENTS\"",
      "for test_argument in \"$@\"; do",
      "  printf '%s\\n' \"$test_argument\" >> \"$CMIBOT_TEST_SSH_ARGUMENTS\"",
      "done",
      ...(captureStdin ? ["cat > \"$CMIBOT_TEST_SSH_STDIN\""] : []),
      "printf '%s\\n' 'remote output'",
      `exit ${exitCode}`,
      "",
    ].join("\n"),
    { mode: 0o755 },
  );

  return {
    argumentsPath,
    configurationPath,
    stdinPath,
    environment: {
      ...process.env,
      CMIBOT_REMOTE_CONFIG: configurationPath,
      CMIBOT_SSH: sshPath,
      CMIBOT_TEST_SSH_ARGUMENTS: argumentsPath,
      CMIBOT_TEST_SSH_STDIN: stdinPath,
    },
  };
}

async function runRemote(args, environment) {
  return execFileAsync(remoteScript, args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: environment,
  });
}

async function readArguments(argumentsPath) {
  return (await fs.readFile(argumentsPath, "utf8")).trim().split("\n");
}

test("remote status uses the private configuration without splitting the remote command", async () => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lookupbot-remote-"));
  try {
    const fixture = await createFixture(temporaryRoot);
    const result = await runRemote(["status"], fixture.environment);

    assert.match(result.stdout, /remote output/);
    assert.deepEqual(await readArguments(fixture.argumentsPath), [
      ...sshPrefix,
      "'/runtime/node' '/srv/lookupbot/scripts/cmibot-ops.mjs' 'status'",
    ]);
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("remote configure-alert-channel forwards private input only through stdin", async () => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lookupbot-remote-"));
  const testChannelId = "3".repeat(18);
  try {
    const fixture = await createFixture(temporaryRoot, { captureStdin: true });
    const result = await execFileWithInput(
      remoteScript,
      ["configure-alert-channel"],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
        env: fixture.environment,
      },
      `${testChannelId}\n`,
    );

    assert.deepEqual(await readArguments(fixture.argumentsPath), [
      ...sshPrefix,
      "'/runtime/node' '/srv/lookupbot/scripts/cmibot-ops.mjs' 'configure-alert-channel'",
    ]);
    assert.equal(await fs.readFile(fixture.stdinPath, "utf8"), `${testChannelId}\n`);
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(testChannelId));
    assert.doesNotMatch((await fs.readFile(fixture.argumentsPath, "utf8")), new RegExp(testChannelId));
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("remote paths containing spaces remain one safely quoted command", async () => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lookupbot-remote-"));
  try {
    const fixture = await createFixture(temporaryRoot, {
      configuration: {
        ...defaultConfiguration,
        nodePath: "/runtime with spaces/node",
        projectRoot: "/srv/private project",
      },
    });
    await runRemote(["restart"], fixture.environment);

    assert.deepEqual(await readArguments(fixture.argumentsPath), [
      ...sshPrefix,
      "'/runtime with spaces/node' '/srv/private project/scripts/cmibot-ops.mjs' 'restart'",
    ]);
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("remote paths containing apostrophes are shell quoted safely", async () => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lookupbot-remote-"));
  try {
    const fixture = await createFixture(temporaryRoot, {
      configuration: {
        ...defaultConfiguration,
        nodePath: "/runtime's/node",
        projectRoot: "/srv/operator's project",
      },
    });
    await runRemote(["restart"], fixture.environment);

    assert.deepEqual(await readArguments(fixture.argumentsPath), [
      ...sshPrefix,
      "'/runtime'\"'\"'s/node' '/srv/operator'\"'\"'s project/scripts/cmibot-ops.mjs' 'restart'",
    ]);
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("remote restart cannot accept additional command arguments", async () => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lookupbot-remote-"));
  try {
    const fixture = await createFixture(temporaryRoot);
    await assert.rejects(runRemote(["restart", "unexpected"], fixture.environment), (error) => {
      assert.equal(error.code, 64);
      assert.match(error.stderr, /restart does not accept arguments/);
      return true;
    });
    await assert.rejects(fs.access(fixture.argumentsPath), { code: "ENOENT" });
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("remote logs forwards only validated tail options", async () => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lookupbot-remote-"));
  try {
    const fixture = await createFixture(temporaryRoot);
    await runRemote(["logs", "--lines", "25", "--follow"], fixture.environment);

    assert.deepEqual(await readArguments(fixture.argumentsPath), [
      ...sshPrefix,
      "'/runtime/node' '/srv/lookupbot/scripts/cmibot-ops.mjs' 'logs' '--lines' '25' '--follow'",
    ]);
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("remote logs rejects shell-like input before invoking ssh", async () => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lookupbot-remote-"));
  try {
    const fixture = await createFixture(temporaryRoot);
    await assert.rejects(runRemote(["logs", "--lines", "1;touch-bad"], fixture.environment), (error) => {
      assert.equal(error.code, 64);
      assert.match(error.stderr, /--lines must be an integer/);
      return true;
    });
    await assert.rejects(fs.access(fixture.argumentsPath), { code: "ENOENT" });
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("remote deploy supports only deploy and rollback", async () => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lookupbot-remote-"));
  try {
    const fixture = await createFixture(temporaryRoot);
    await runRemote(["deploy", "--rollback"], fixture.environment);

    assert.deepEqual(await readArguments(fixture.argumentsPath), [
      ...sshPrefix,
      "'/runtime/node' '/srv/lookupbot/scripts/deploy.mjs' '--rollback'",
    ]);
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("remote update uses the safe updater with a minimal Node-aware path", async () => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lookupbot-remote-"));
  try {
    const fixture = await createFixture(temporaryRoot);
    await runRemote(["update"], fixture.environment);

    assert.deepEqual(await readArguments(fixture.argumentsPath), [
      ...sshPrefix,
      "PATH='/runtime:/usr/bin:/bin:/usr/sbin:/sbin' '/runtime/node' '/srv/lookupbot/scripts/safe-update.mjs'",
    ]);
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("remote operations preserve the ssh command exit status", async () => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lookupbot-remote-"));
  try {
    const fixture = await createFixture(temporaryRoot, { exitCode: 3 });
    await assert.rejects(runRemote(["status"], fixture.environment), (error) => {
      assert.equal(error.code, 3);
      assert.match(error.stdout, /remote output/);
      return true;
    });
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("remote operations reject group-readable configuration before invoking ssh", async () => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lookupbot-remote-"));
  try {
    const fixture = await createFixture(temporaryRoot);
    await fs.chmod(fixture.configurationPath, 0o640);

    await assert.rejects(runRemote(["status"], fixture.environment), (error) => {
      assert.equal(error.code, 78);
      assert.match(error.stderr, /permissions must be owner-only/);
      return true;
    });
    await assert.rejects(fs.access(fixture.argumentsPath), { code: "ENOENT" });
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("remote operations reject a symlinked configuration before invoking ssh", async () => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lookupbot-remote-"));
  try {
    const fixture = await createFixture(temporaryRoot);
    const symlinkPath = path.join(temporaryRoot, "remote-link.json");
    await fs.symlink(fixture.configurationPath, symlinkPath);

    await assert.rejects(
      runRemote(["status"], { ...fixture.environment, CMIBOT_REMOTE_CONFIG: symlinkPath }),
      (error) => {
        assert.equal(error.code, 78);
        assert.match(error.stderr, /configuration is unavailable/);
        return true;
      },
    );
    await assert.rejects(fs.access(fixture.argumentsPath), { code: "ENOENT" });
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("remote operations reject an unsafe SSH destination without echoing it", async () => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lookupbot-remote-"));
  try {
    const unsafeDestination = "-oProxyCommand=do-not-run";
    const fixture = await createFixture(temporaryRoot, {
      configuration: { ...defaultConfiguration, host: unsafeDestination },
    });

    await assert.rejects(runRemote(["status"], fixture.environment), (error) => {
      assert.equal(error.code, 78);
      assert.match(error.stderr, /invalid SSH destination/);
      assert.doesNotMatch(error.stderr, new RegExp(unsafeDestination));
      return true;
    });
    await assert.rejects(fs.access(fixture.argumentsPath), { code: "ENOENT" });
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
});
