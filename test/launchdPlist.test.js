import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const plistPath = path.join(repositoryRoot, "operations", "com.mrfdev.cmibot.plist");

test("the user LaunchAgent is valid, private, and points at the managed release", async () => {
  await execFileAsync("/usr/bin/plutil", ["-lint", plistPath], { encoding: "utf8" });
  const { stdout } = await execFileAsync("/usr/bin/plutil", ["-convert", "json", "-o", "-", plistPath], {
    encoding: "utf8",
  });
  const plist = JSON.parse(stdout);

  assert.equal(plist.Label, "com.mrfdev.cmibot");
  assert.deepEqual(plist.ProgramArguments, [
    "/opt/homebrew/bin/node",
    "/Users/floris/Projects/Codex/CMIBot/.deploy/current/src/index.js",
  ]);
  assert.equal(plist.WorkingDirectory, "/Users/floris/Projects/Codex/CMIBot/.deploy/current");
  assert.equal(plist.RunAtLoad, true);
  assert.deepEqual(plist.KeepAlive, { SuccessfulExit: false });
  assert.equal(plist.ExitTimeOut, 30);
  assert.equal(plist.StandardOutPath, "/Users/floris/Projects/Codex/CMIBot/logs/cmibot-service.log");
  assert.equal(plist.StandardErrorPath, "/Users/floris/Projects/Codex/CMIBot/logs/cmibot-service.error.log");
  assert.deepEqual(plist.EnvironmentVariables, {
    NODE_ENV: "production",
    PATH: "/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin",
  });
  assert.equal("UserName" in plist, false);
  assert.doesNotMatch(JSON.stringify(plist.EnvironmentVariables), /DISCORD|OPENAI|TOKEN|PASSWORD|SECRET/i);
});
