import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const plistPath = path.join(repositoryRoot, "operations", "com.mrfdev.cmibot.plist");

test("the user LaunchAgent template is valid and contains no host-specific paths", async () => {
  await execFileAsync("/usr/bin/plutil", ["-lint", plistPath], { encoding: "utf8" });
  const { stdout } = await execFileAsync("/usr/bin/plutil", ["-convert", "json", "-o", "-", plistPath], {
    encoding: "utf8",
  });
  const plist = JSON.parse(stdout);

  assert.equal(plist.Label, "com.mrfdev.cmibot");
  assert.deepEqual(plist.ProgramArguments, [
    "__NODE_EXECUTABLE__",
    "__SERVICE_RUNNER__",
  ]);
  assert.equal(plist.WorkingDirectory, "__WORKING_DIRECTORY__");
  assert.equal(plist.RunAtLoad, true);
  assert.deepEqual(plist.KeepAlive, { SuccessfulExit: false });
  assert.equal(plist.ExitTimeOut, 30);
  assert.equal(plist.StandardOutPath, "/dev/null");
  assert.equal(plist.StandardErrorPath, "/dev/null");
  assert.deepEqual(plist.EnvironmentVariables, {
    NODE_ENV: "production",
    PATH: "__EXECUTABLE_PATH__",
  });
  assert.equal("UserName" in plist, false);
  assert.doesNotMatch(JSON.stringify(plist.EnvironmentVariables), /DISCORD|OPENAI|TOKEN|PASSWORD|SECRET/i);
  assert.doesNotMatch(stdout, /\/(?:Users|home)\//i);
});
