import fs from "node:fs/promises";
import path from "node:path";

export async function writeAuditLog(workspaceRoot, relativePath, payload) {
  try {
    const absolutePath = path.join(workspaceRoot, relativePath);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.appendFile(absolutePath, `${JSON.stringify(payload)}\n`, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[CMIBot] Failed to write audit log: ${message}`);
  }
}
