import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeVersionCatalog } from "./version-catalog.mjs";
import { readRuntimeCompatibility, runtimeServerPaths } from "./runtime-compatibility.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(scriptDirectory, "..");
const compatibility = await readRuntimeCompatibility(workspaceRoot);
const { serverDirectory } = runtimeServerPaths(workspaceRoot, compatibility);
const { catalog, outputPath } = await writeVersionCatalog(workspaceRoot, serverDirectory);

console.log(
  `Wrote ${catalog.plugins.length} plugin versions, ${catalog.companions.length} companion resources, and Paper metadata to ${outputPath}.`,
);
