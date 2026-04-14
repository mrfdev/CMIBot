import { loadEntriesFromLogProfile } from "./logIndex.js";
import { loadEntriesForProfile as loadYamlEntriesForProfile } from "./yamlIndex.js";

export async function loadEntriesForProfile(profile, workspaceRoot) {
  if (profile.sourceType === "log") {
    return loadEntriesFromLogProfile(profile, workspaceRoot);
  }

  return loadYamlEntriesForProfile(profile, workspaceRoot);
}
