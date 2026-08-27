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

async function createLaunchctlFixture(
  temporaryRoot,
  { running = false, loaded = running, startDelayChecks = 0, stopDelayChecks = 0 } = {},
) {
  const launchctlPath = path.join(temporaryRoot, "launchctl");
  const statePath = path.join(temporaryRoot, "launchctl.state");
  const loadedPath = path.join(temporaryRoot, "launchctl.loaded");
  const counterPath = path.join(temporaryRoot, "launchctl.counter");
  const startDelayPath = path.join(temporaryRoot, "launchctl.start-delay");
  const stopDelayPath = path.join(temporaryRoot, "launchctl.stop-delay");
  const stopPendingPath = path.join(temporaryRoot, "launchctl.stop-pending");
  const launchAgentsDirectory = path.join(temporaryRoot, "LaunchAgents");
  const plistPath = path.join(launchAgentsDirectory, "com.mrfdev.cmibot.plist");

  await fs.mkdir(launchAgentsDirectory);
  await fs.writeFile(plistPath, "test plist\n", "utf8");
  if (loaded) {
    await fs.writeFile(loadedPath, "loaded\n", "utf8");
  }
  if (running) {
    await fs.writeFile(statePath, "2468\n", "utf8");
    await fs.writeFile(counterPath, "2468\n", "utf8");
  } else {
    await fs.writeFile(counterPath, "2467\n", "utf8");
  }
  await fs.writeFile(startDelayPath, `${startDelayChecks}\n`, "utf8");
  await fs.writeFile(stopDelayPath, `${stopDelayChecks}\n`, "utf8");
  await fs.writeFile(
    launchctlPath,
    [
      "#!/bin/sh",
      "set -eu",
      "case \"$1\" in",
      "  print)",
      "    if [ -f \"$CMIBOT_TEST_LAUNCHCTL_LOADED\" ]; then",
      "      if [ -f \"$CMIBOT_TEST_LAUNCHCTL_STOP_PENDING\" ]; then",
      "        test_delay=$(cat \"$CMIBOT_TEST_LAUNCHCTL_STOP_DELAY\")",
      "        if [ \"$test_delay\" -gt 0 ]; then",
      "          printf '%s\\n' \"$((test_delay - 1))\" > \"$CMIBOT_TEST_LAUNCHCTL_STOP_DELAY\"",
      "          printf '%s\\n' 'state = exited'",
      "          exit 0",
      "        fi",
      "        rm -f \"$CMIBOT_TEST_LAUNCHCTL_LOADED\" \"$CMIBOT_TEST_LAUNCHCTL_STOP_PENDING\"",
      "        exit 113",
      "      fi",
      "      if [ -f \"$CMIBOT_TEST_LAUNCHCTL_STATE\" ]; then",
      "        test_delay=$(cat \"$CMIBOT_TEST_LAUNCHCTL_START_DELAY\")",
      "        if [ \"$test_delay\" -gt 0 ]; then",
      "          printf '%s\\n' \"$((test_delay - 1))\" > \"$CMIBOT_TEST_LAUNCHCTL_START_DELAY\"",
      "          printf '%s\\n' 'state = waiting'",
      "          exit 0",
      "        fi",
      "        test_pid=$(cat \"$CMIBOT_TEST_LAUNCHCTL_STATE\")",
      "        printf '%s\\n' 'state = running' \"pid = $test_pid\"",
      "      else",
      "        printf '%s\\n' 'state = waiting'",
      "      fi",
      "      exit 0",
      "    fi",
      "    exit 113",
      "    ;;",
      "  bootstrap)",
      "    if [ -f \"$CMIBOT_TEST_LAUNCHCTL_LOADED\" ]; then exit 37; fi",
      "    : > \"$CMIBOT_TEST_LAUNCHCTL_LOADED\"",
      "    test_pid=$(cat \"$CMIBOT_TEST_LAUNCHCTL_COUNTER\")",
      "    test_pid=$((test_pid + 1))",
      "    printf '%s\\n' \"$test_pid\" > \"$CMIBOT_TEST_LAUNCHCTL_COUNTER\"",
      "    printf '%s\\n' \"$test_pid\" > \"$CMIBOT_TEST_LAUNCHCTL_STATE\"",
      "    exit 0",
      "    ;;",
      "  kickstart)",
      "    test_pid=$(cat \"$CMIBOT_TEST_LAUNCHCTL_COUNTER\")",
      "    test_pid=$((test_pid + 1))",
      "    printf '%s\\n' \"$test_pid\" > \"$CMIBOT_TEST_LAUNCHCTL_COUNTER\"",
      "    printf '%s\\n' \"$test_pid\" > \"$CMIBOT_TEST_LAUNCHCTL_STATE\"",
      "    exit 0",
      "    ;;",
      "  bootout)",
      "    rm -f \"$CMIBOT_TEST_LAUNCHCTL_STATE\"",
      "    test_delay=$(cat \"$CMIBOT_TEST_LAUNCHCTL_STOP_DELAY\")",
      "    if [ \"$test_delay\" -gt 0 ]; then",
      "      : > \"$CMIBOT_TEST_LAUNCHCTL_STOP_PENDING\"",
      "    else",
      "      rm -f \"$CMIBOT_TEST_LAUNCHCTL_LOADED\"",
      "    fi",
      "    exit 0",
      "    ;;",
      "esac",
      "exit 64",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );

  return {
    environment: {
      ...process.env,
      CMIBOT_LAUNCHCTL: launchctlPath,
      CMIBOT_LAUNCH_AGENTS_DIR: launchAgentsDirectory,
      CMIBOT_TEST_LAUNCHCTL_COUNTER: counterPath,
      CMIBOT_TEST_LAUNCHCTL_LOADED: loadedPath,
      CMIBOT_TEST_LAUNCHCTL_START_DELAY: startDelayPath,
      CMIBOT_TEST_LAUNCHCTL_STATE: statePath,
      CMIBOT_TEST_LAUNCHCTL_STOP_DELAY: stopDelayPath,
      CMIBOT_TEST_LAUNCHCTL_STOP_PENDING: stopPendingPath,
      CMIBOT_UID: "501",
      CMIBOT_START_INTERVAL_MS: "10",
      CMIBOT_START_TIMEOUT_MS: "1000",
      CMIBOT_STOP_INTERVAL_MS: "10",
      CMIBOT_STOP_TIMEOUT_MS: "1000",
    },
  };
}

async function runOperation(command, environment, args = [], options = {}) {
  const executionOptions = {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: environment,
  };
  if (options.input !== undefined) {
    return execFileWithInput(path.join(repositoryRoot, `scripts/${command}`), args, executionOptions, options.input);
  }
  return execFileAsync(path.join(repositoryRoot, `scripts/${command}`), args, executionOptions);
}

test("status reports the running launchd job and its PID", async () => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lookupbot-operations-"));

  try {
    const fixture = await createLaunchctlFixture(temporaryRoot, { running: true });
    const { stdout } = await runOperation("status", fixture.environment);

    assert.match(stdout, /LookupBot is running \(pid 2468\)\./);
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("start makes an unloaded launchd job observable as running", async () => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lookupbot-operations-"));

  try {
    const fixture = await createLaunchctlFixture(temporaryRoot);
    const started = await runOperation("start", fixture.environment);
    const status = await runOperation("status", fixture.environment);

    assert.match(`${started.stdout}${status.stdout}`, /LookupBot started\.[\s\S]*LookupBot is running \(pid 2468\)\./);
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("start kickstarts a loaded launchd job that is waiting", async () => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lookupbot-operations-"));

  try {
    const fixture = await createLaunchctlFixture(temporaryRoot, { loaded: true });
    const started = await runOperation("start", fixture.environment);
    const status = await runOperation("status", fixture.environment);

    assert.match(`${started.stdout}${status.stdout}`, /LookupBot started\.[\s\S]*LookupBot is running \(pid 2468\)\./);
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("start waits for launchd to advance a bootstrapped job to running", async () => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lookupbot-operations-"));

  try {
    const fixture = await createLaunchctlFixture(temporaryRoot, { startDelayChecks: 2 });
    const started = await runOperation("start", fixture.environment);
    const status = await runOperation("status", fixture.environment);

    assert.match(`${started.stdout}${status.stdout}`, /LookupBot started\.[\s\S]*LookupBot is running \(pid 2468\)\./);
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("stop makes a running launchd job observable as stopped", async () => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lookupbot-operations-"));

  try {
    const fixture = await createLaunchctlFixture(temporaryRoot, { running: true });
    const stopped = await runOperation("stop", fixture.environment);

    assert.match(stopped.stdout, /LookupBot stopped\./);
    await assert.rejects(runOperation("status", fixture.environment), (error) => {
      assert.equal(error.code, 3);
      assert.match(error.stdout, /LookupBot is stopped\./);
      return true;
    });
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("stop waits for launchd to finish unloading the job", async () => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lookupbot-operations-"));

  try {
    const fixture = await createLaunchctlFixture(temporaryRoot, { running: true, stopDelayChecks: 2 });
    const stopped = await runOperation("stop", fixture.environment);

    assert.match(stopped.stdout, /LookupBot stopped\./);
    await assert.rejects(runOperation("status", fixture.environment), (error) => {
      assert.equal(error.code, 3);
      return true;
    });
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("restart replaces the running launchd process with a new one", async () => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lookupbot-operations-"));

  try {
    const fixture = await createLaunchctlFixture(temporaryRoot, { running: true });
    const restarted = await runOperation("restart", fixture.environment);
    const status = await runOperation("status", fixture.environment);

    assert.match(`${restarted.stdout}${status.stdout}`, /LookupBot restarted\.[\s\S]*LookupBot is running \(pid 2469\)\./);
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("install renders a private local service definition without printing its paths", async () => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lookupbot-operations-"));

  try {
    const fixture = await createLaunchctlFixture(temporaryRoot);
    const result = await runOperation("install", {
      ...fixture.environment,
      CMIBOT_NODE: "/test-runtime/bin/node",
    });
    const plistPath = path.join(temporaryRoot, "LaunchAgents", "com.mrfdev.cmibot.plist");
    const installed = await fs.readFile(plistPath, "utf8");
    const mode = (await fs.stat(plistPath)).mode & 0o777;

    assert.match(result.stdout, /^LookupBot service definition installed\.\n$/);
    assert.doesNotMatch(result.stdout, /\/test-runtime|Users|home/i);
    assert.match(installed, /\/test-runtime\/bin\/node/);
    assert.match(installed, /scripts\/service-runner\.mjs/);
    const expectedCurrent = path.join(repositoryRoot, ".deploy", "current");
    assert.match(installed, new RegExp(expectedCurrent.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(installed, /__[A-Z0-9_]+__/);
    assert.match(installed, /<string>\/dev\/null<\/string>/);
    assert.equal(mode, 0o600);
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("configure-alert-channel atomically updates and hardens the private environment file", async () => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lookupbot-operations-"));
  const testChannelId = "1".repeat(18);

  try {
    const environmentPath = path.join(temporaryRoot, ".env");
    await fs.writeFile(
      environmentPath,
      `DISCORD_TOKEN=keep-private\nDISCORD_ADMIN_ALERT_CHANNEL_ID=old-value\nOTHER_SETTING=yes\n`,
      { mode: 0o644 },
    );

    const result = await runOperation(
      "cmibot-ops.mjs",
      { ...process.env, CMIBOT_PROJECT_ROOT: temporaryRoot },
      ["configure-alert-channel"],
      { input: `${testChannelId}\n` },
    );
    const updated = await fs.readFile(environmentPath, "utf8");
    const mode = (await fs.stat(environmentPath)).mode & 0o777;

    assert.equal(result.stdout, "LookupBot admin alert destination configured privately.\n");
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(testChannelId));
    assert.equal(
      updated,
      `DISCORD_TOKEN=keep-private\nDISCORD_ADMIN_ALERT_CHANNEL_ID=${testChannelId}\nOTHER_SETTING=yes\n`,
    );
    assert.equal(mode, 0o600);
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("configure-alert-channel rejects invalid input without changing the private environment file", async () => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lookupbot-operations-"));

  try {
    const environmentPath = path.join(temporaryRoot, ".env");
    const original = "DISCORD_TOKEN=keep-private\n";
    await fs.writeFile(environmentPath, original, { mode: 0o600 });

    await assert.rejects(
      runOperation(
        "cmibot-ops.mjs",
        { ...process.env, CMIBOT_PROJECT_ROOT: temporaryRoot },
        ["configure-alert-channel"],
        { input: "not-a-channel\n" },
      ),
      (error) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /Private configuration input is invalid/);
        assert.doesNotMatch(error.stderr, /not-a-channel/);
        return true;
      },
    );
    assert.equal(await fs.readFile(environmentPath, "utf8"), original);
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("configure-alert-channel rejects duplicate assignments without exposing either value", async () => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lookupbot-operations-"));
  const testChannelId = "2".repeat(18);

  try {
    const environmentPath = path.join(temporaryRoot, ".env");
    const original = [
      "DISCORD_ADMIN_ALERT_CHANNEL_ID=first-private-value",
      "export DISCORD_ADMIN_ALERT_CHANNEL_ID=second-private-value",
      "",
    ].join("\n");
    await fs.writeFile(environmentPath, original, { mode: 0o600 });

    await assert.rejects(
      runOperation(
        "cmibot-ops.mjs",
        { ...process.env, CMIBOT_PROJECT_ROOT: temporaryRoot },
        ["configure-alert-channel"],
        { input: `${testChannelId}\n` },
      ),
      (error) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /duplicate private setting/);
        assert.doesNotMatch(error.stderr, /private-value/);
        assert.doesNotMatch(error.stderr, new RegExp(testChannelId));
        return true;
      },
    );
    assert.equal(await fs.readFile(environmentPath, "utf8"), original);
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("configure-test-channel appends the private route to both channel lists", async () => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lookupbot-operations-"));
  const supportChannelId = "3".repeat(18);
  const existingTestChannelId = "4".repeat(18);
  const addedTestChannelId = "5".repeat(18);

  try {
    const environmentPath = path.join(temporaryRoot, ".env");
    await fs.writeFile(
      environmentPath,
      [
        "DISCORD_TOKEN=keep-private",
        `DISCORD_ALLOWED_CHANNEL_IDS='${supportChannelId}, ${existingTestChannelId}'`,
        `DISCORD_TEST_CHANNEL_IDS=${existingTestChannelId}`,
        "OTHER_SETTING=yes",
        "",
      ].join("\n"),
      { mode: 0o644 },
    );

    const result = await runOperation(
      "cmibot-ops.mjs",
      { ...process.env, CMIBOT_PROJECT_ROOT: temporaryRoot },
      ["configure-test-channel"],
      { input: `${addedTestChannelId}\n` },
    );
    const updated = await fs.readFile(environmentPath, "utf8");
    const mode = (await fs.stat(environmentPath)).mode & 0o777;

    assert.equal(result.stdout, "LookupBot private test channel configured.\n");
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(addedTestChannelId));
    assert.match(
      updated,
      new RegExp(`DISCORD_ALLOWED_CHANNEL_IDS=${supportChannelId},${existingTestChannelId},${addedTestChannelId}`),
    );
    assert.match(
      updated,
      new RegExp(`DISCORD_TEST_CHANNEL_IDS=${existingTestChannelId},${addedTestChannelId}`),
    );
    assert.match(updated, /DISCORD_TOKEN=keep-private/);
    assert.match(updated, /OTHER_SETTING=yes/);
    assert.equal(mode, 0o600);
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("configure-test-channel carries the active legacy route into the modern setting", async () => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lookupbot-operations-"));
  const existingTestChannelId = "6".repeat(18);
  const addedTestChannelId = "7".repeat(18);

  try {
    const environmentPath = path.join(temporaryRoot, ".env");
    await fs.writeFile(
      environmentPath,
      [
        `DISCORD_ALLOWED_CHANNEL_IDS=${existingTestChannelId}`,
        "DISCORD_TEST_CHANNEL_IDS=",
        `DISCORD_CMI_TEST_CHANNEL_IDS=${existingTestChannelId}`,
        "",
      ].join("\n"),
      { mode: 0o600 },
    );

    await runOperation(
      "cmibot-ops.mjs",
      { ...process.env, CMIBOT_PROJECT_ROOT: temporaryRoot },
      ["configure-test-channel"],
      { input: `${addedTestChannelId}\n` },
    );
    const updated = await fs.readFile(environmentPath, "utf8");

    assert.match(
      updated,
      new RegExp(`DISCORD_ALLOWED_CHANNEL_IDS=${existingTestChannelId},${addedTestChannelId}`),
    );
    assert.match(
      updated,
      new RegExp(`DISCORD_TEST_CHANNEL_IDS=${existingTestChannelId},${addedTestChannelId}`),
    );
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("configure-test-channel fails closed on malformed private channel settings", async () => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lookupbot-operations-"));
  const addedTestChannelId = "8".repeat(18);

  try {
    const environmentPath = path.join(temporaryRoot, ".env");
    const original = [
      "DISCORD_ALLOWED_CHANNEL_IDS=not-a-channel",
      `DISCORD_TEST_CHANNEL_IDS=${"9".repeat(18)}`,
      "",
    ].join("\n");
    await fs.writeFile(environmentPath, original, { mode: 0o600 });

    await assert.rejects(
      runOperation(
        "cmibot-ops.mjs",
        { ...process.env, CMIBOT_PROJECT_ROOT: temporaryRoot },
        ["configure-test-channel"],
        { input: `${addedTestChannelId}\n` },
      ),
      (error) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /existing private channel configuration is invalid/);
        assert.doesNotMatch(error.stderr, /not-a-channel/);
        assert.doesNotMatch(error.stderr, new RegExp(addedTestChannelId));
        return true;
      },
    );
    assert.equal(await fs.readFile(environmentPath, "utf8"), original);
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("configure-test-channel rejects a channel already assigned to a plugin route", async () => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lookupbot-operations-"));
  const routedChannelId = "1".repeat(17);

  try {
    const environmentPath = path.join(temporaryRoot, ".env");
    const original = [
      `DISCORD_ALLOWED_CHANNEL_IDS=${routedChannelId}`,
      `DISCORD_CMI_CHANNEL_IDS=${routedChannelId}`,
      "DISCORD_TEST_CHANNEL_IDS=",
      "",
    ].join("\n");
    await fs.writeFile(environmentPath, original, { mode: 0o600 });

    await assert.rejects(
      runOperation(
        "cmibot-ops.mjs",
        { ...process.env, CMIBOT_PROJECT_ROOT: temporaryRoot },
        ["configure-test-channel"],
        { input: `${routedChannelId}\n` },
      ),
      (error) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /already assigned to another route/);
        assert.doesNotMatch(error.stderr, new RegExp(routedChannelId));
        return true;
      },
    );
    assert.equal(await fs.readFile(environmentPath, "utf8"), original);
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("logs displays only the requested tail of both service logs", async () => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lookupbot-operations-"));

  try {
    const logsDirectory = path.join(temporaryRoot, "logs");
    await fs.mkdir(logsDirectory);
    await fs.writeFile(path.join(logsDirectory, "cmibot-service.log"), "old output\nlatest output\n", "utf8");
    await fs.writeFile(path.join(logsDirectory, "cmibot-service.error.log"), "old error\nlatest error\n", "utf8");

    const result = await runOperation(
      "logs",
      { ...process.env, CMIBOT_PROJECT_ROOT: temporaryRoot },
      ["--lines", "1"],
    );

    assert.match(result.stdout, /latest output[\s\S]*latest error/);
    assert.doesNotMatch(result.stdout, /old output|old error/);
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
});
