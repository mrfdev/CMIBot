import path from "node:path";
import { fileURLToPath } from "node:url";
import { runSafeSourceUpdate, SafeUpdateError } from "./safe-update-lib.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(scriptDirectory, "..");
const knownArguments = new Set(["--check"]);
const unknownArguments = process.argv.slice(2).filter((argument) => !knownArguments.has(argument));

if (unknownArguments.length) {
  console.error(`[update] Unknown argument${unknownArguments.length === 1 ? "" : "s"}: ${unknownArguments.join(", ")}`);
  process.exitCode = 1;
} else {
  try {
    await runSafeSourceUpdate({
      workspaceRoot,
      checkOnly: process.argv.includes("--check"),
    });
  } catch (error) {
    const message = error instanceof SafeUpdateError || error instanceof Error
      ? error.message
      : String(error);
    console.error(`[update] ${message}`);
    process.exitCode = 1;
  }
}
