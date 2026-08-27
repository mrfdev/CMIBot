import { loadEntriesFromLogProfile } from "./logIndex.js";
import { loadEntriesForProfile as loadYamlEntriesForProfile } from "./yamlIndex.js";

export async function loadEntriesForProfile(profile, workspaceRoot, options = {}) {
  if (profile.sourceType === "log") {
    return loadEntriesFromLogProfile(profile, workspaceRoot, options);
  }

  return loadYamlEntriesForProfile(profile, workspaceRoot, options);
}
