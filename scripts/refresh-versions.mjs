import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeVersionCatalog } from "./version-catalog.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(scriptDirectory, "..");
const serverDirectory = path.join(workspaceRoot, "servers", "Paper-26.2");
const { catalog, outputPath } = await writeVersionCatalog(workspaceRoot, serverDirectory);

console.log(`Wrote ${catalog.plugins.length} plugin versions and Paper metadata to ${outputPath}.`);
