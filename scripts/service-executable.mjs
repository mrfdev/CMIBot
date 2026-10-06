import fs from "node:fs/promises";
import path from "node:path";

// Node resolves its executable symlink, but a LaunchAgent must survive cleanup of
// that Homebrew keg. Only select a stable link when it names this same executable.
export async function stableServiceExecutable(executable) {
  const match = executable.match(/^(.*)\/Cellar\/([^/]+)\/[^/]+\/(.+)$/);
  if (!match) return executable;

  const [, prefix, formula, relativeExecutable] = match;
  const current = await fs.realpath(executable).catch(() => null);
  if (!current) return executable;

  const candidates = [
    path.join(prefix, "opt", formula, relativeExecutable),
    path.join(prefix, relativeExecutable),
  ];
  for (const candidate of candidates) {
    if (await fs.realpath(candidate).catch(() => null) === current) return candidate;
  }
  return executable;
}
