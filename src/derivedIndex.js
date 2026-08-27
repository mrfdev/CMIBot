import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { gzip as gzipCallback, gunzip as gunzipCallback } from "node:zlib";
import { serviceLogger } from "./logger.js";

const gzip = promisify(gzipCallback);
const gunzip = promisify(gunzipCallback);

export const DERIVED_INDEX_SCHEMA_VERSION = 1;
// Increment this whenever parser output or hydrated entry semantics change.
export const DERIVED_INDEX_FORMAT_VERSION = 1;

const DEFAULT_CACHE_DIRECTORY = "logs/derived-indexes";
const DEFAULT_MAX_ARTIFACT_BYTES = 32 * 1024 * 1024;
const MAX_UNCOMPRESSED_BYTES = 256 * 1024 * 1024;
const MAX_ENTRY_COUNT = 2_000_000;
const MAX_DOCUMENT_COUNT = 100_000;

class InvalidDerivedIndexError extends Error {
  constructor(reason) {
    super("The derived index artifact is unavailable.");
    this.name = "InvalidDerivedIndexError";
    this.reason = reason;
  }
}

function isInside(root, candidate) {
  return candidate !== root && candidate.startsWith(`${root}${path.sep}`);
}

function normalizeMaximumBytes(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0
    ? Math.min(parsed, 128 * 1024 * 1024)
    : DEFAULT_MAX_ARTIFACT_BYTES;
}

function makeProfileFingerprint(profile, sourceFingerprint) {
  const descriptor = {
    name: profile.name ?? "",
    sourceType: profile.sourceType ?? "yaml",
    parserType: profile.parserType ?? "",
    codeLanguage: profile.codeLanguage ?? "",
    allowEmpty: profile.allowEmpty === true,
    include: [...(profile.include ?? [])],
    exclude: [...(profile.exclude ?? [])],
  };
  return createHash("sha256")
    .update(String(DERIVED_INDEX_FORMAT_VERSION))
    .update("\n")
    .update(JSON.stringify(descriptor))
    .update("\n")
    .update(String(sourceFingerprint))
    .digest("hex");
}

function getArtifactName(scopeKey) {
  const digest = createHash("sha256").update(String(scopeKey)).digest("hex");
  return `${digest}.idx.json.gz`;
}

function serializeEntries(entries) {
  const documents = [];
  const documentIndexes = new Map();
  const records = entries.map((entry) => {
    const metadata = entry?.indexedYamlContext;
    let context = null;

    if (
      Array.isArray(metadata?.document?.lines) &&
      Number.isSafeInteger(metadata.blockStartLine) &&
      Number.isSafeInteger(metadata.blockEndLine)
    ) {
      let documentIndex = documentIndexes.get(metadata.document);
      if (documentIndex == null) {
        documentIndex = documents.length;
        documentIndexes.set(metadata.document, documentIndex);
        documents.push(metadata.document.lines);
      }
      context = [documentIndex, metadata.blockStartLine, metadata.blockEndLine];
    }

    return {
      e: { ...entry },
      ...(context ? { c: context } : {}),
    };
  });

  return { documents, records };
}

function hydrateEntries(payload) {
  if (
    !Array.isArray(payload?.d) ||
    !Array.isArray(payload?.e) ||
    payload.d.length > MAX_DOCUMENT_COUNT ||
    payload.e.length > MAX_ENTRY_COUNT
  ) {
    throw new InvalidDerivedIndexError("malformed");
  }

  const documents = payload.d.map((lines) => {
    if (!Array.isArray(lines) || lines.some((line) => typeof line !== "string")) {
      throw new InvalidDerivedIndexError("malformed");
    }
    return Object.freeze({ lines: Object.freeze(lines) });
  });

  return payload.e.map((record) => {
    if (!record || typeof record !== "object" || !record.e || typeof record.e !== "object") {
      throw new InvalidDerivedIndexError("malformed");
    }
    const entry = { ...record.e };
    if (record.c != null) {
      if (
        !Array.isArray(record.c) ||
        record.c.length !== 3 ||
        !record.c.every(Number.isSafeInteger)
      ) {
        throw new InvalidDerivedIndexError("malformed");
      }
      const [documentIndex, blockStartLine, blockEndLine] = record.c;
      const document = documents[documentIndex];
      if (
        !document ||
        blockStartLine < 1 ||
        blockEndLine < blockStartLine ||
        blockEndLine > document.lines.length
      ) {
        throw new InvalidDerivedIndexError("malformed");
      }
      Object.defineProperty(entry, "indexedYamlContext", {
        value: Object.freeze({ document, blockStartLine, blockEndLine }),
        enumerable: false,
        configurable: false,
        writable: false,
      });
    }
    return entry;
  });
}

function getSafeReason(error) {
  if (error?.code === "ENOENT") {
    return "missing";
  }
  if (error instanceof InvalidDerivedIndexError) {
    return error.reason;
  }
  return "unavailable";
}

export function createDerivedIndexStore({
  workspaceRoot,
  cacheDirectory = DEFAULT_CACHE_DIRECTORY,
  maxArtifactBytes = DEFAULT_MAX_ARTIFACT_BYTES,
  logger = serviceLogger,
} = {}) {
  const root = path.resolve(workspaceRoot);
  const directory = path.resolve(root, cacheDirectory);
  if (!isInside(root, directory)) {
    throw new Error("The derived index directory must stay within the project workspace.");
  }

  const maximumBytes = normalizeMaximumBytes(maxArtifactBytes);
  const maximumOutputBytes = Math.min(MAX_UNCOMPRESSED_BYTES, maximumBytes * 16);
  const counters = {
    hits: 0,
    misses: 0,
    rebuilds: 0,
    forcedRebuilds: 0,
    rejectedArtifacts: 0,
    artifactsWritten: 0,
    writeFailures: 0,
  };

  async function ensurePrivateDirectory() {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const stats = await fs.lstat(directory);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new InvalidDerivedIndexError("unsafe-directory");
    }
    if (typeof process.getuid === "function" && stats.uid !== process.getuid()) {
      throw new InvalidDerivedIndexError("unsafe-owner");
    }
    await fs.chmod(directory, 0o700);
  }

  async function readArtifact(artifactPath, expectedFingerprint) {
    await ensurePrivateDirectory();
    let handle;
    try {
      handle = await fs.open(
        artifactPath,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      );
      const stats = await handle.stat();
      if (!stats.isFile() || stats.size <= 0 || stats.size > maximumBytes) {
        throw new InvalidDerivedIndexError("invalid-size");
      }
      if (typeof process.getuid === "function" && stats.uid !== process.getuid()) {
        throw new InvalidDerivedIndexError("unsafe-owner");
      }
      if ((stats.mode & 0o077) !== 0) {
        await handle.chmod(0o600);
      }
      const compressed = await handle.readFile();
      const decoded = await gunzip(compressed, { maxOutputLength: maximumOutputBytes });
      const payload = JSON.parse(decoded.toString("utf8"));
      if (
        payload?.s !== DERIVED_INDEX_SCHEMA_VERSION ||
        payload?.v !== DERIVED_INDEX_FORMAT_VERSION ||
        payload?.f !== expectedFingerprint
      ) {
        throw new InvalidDerivedIndexError("stale");
      }
      return hydrateEntries(payload);
    } catch (error) {
      if (error?.code === "ELOOP") {
        throw new InvalidDerivedIndexError("unsafe-artifact");
      }
      throw error;
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  async function writeArtifact(artifactPath, fingerprint, entries) {
    await ensurePrivateDirectory();
    const { documents, records } = serializeEntries(entries);
    const payload = {
      s: DERIVED_INDEX_SCHEMA_VERSION,
      v: DERIVED_INDEX_FORMAT_VERSION,
      f: fingerprint,
      d: documents,
      e: records,
    };
    const compressed = await gzip(Buffer.from(JSON.stringify(payload), "utf8"), { level: 6 });
    if (compressed.byteLength > maximumBytes) {
      throw new InvalidDerivedIndexError("too-large");
    }

    const temporaryPath = path.join(
      directory,
      `.tmp-${process.pid}-${randomUUID()}.idx.json.gz`,
    );
    let handle;
    try {
      handle = await fs.open(
        temporaryPath,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          (constants.O_NOFOLLOW ?? 0),
        0o600,
      );
      await handle.writeFile(compressed);
      await handle.sync();
      await handle.close();
      handle = null;
      await fs.rename(temporaryPath, artifactPath);
      await fs.chmod(artifactPath, 0o600);
    } finally {
      await handle?.close().catch(() => {});
      await fs.rm(temporaryPath, { force: true }).catch(() => {});
    }
  }

  return {
    async loadOrBuild({
      scopeKey,
      profile,
      sourceFingerprint,
      forceRebuild = false,
      build,
      validate,
    }) {
      const fingerprint = makeProfileFingerprint(profile, sourceFingerprint);
      const artifactPath = path.join(directory, getArtifactName(scopeKey));

      if (!forceRebuild) {
        try {
          const entries = await readArtifact(artifactPath, fingerprint);
          validate?.(entries);
          counters.hits += 1;
          return entries;
        } catch (error) {
          counters.misses += 1;
          if (getSafeReason(error) !== "missing") {
            counters.rejectedArtifacts += 1;
            logger.warn("cache.derived_artifact_rejected", {
              reason: getSafeReason(error),
            });
          }
        }
      } else {
        counters.forcedRebuilds += 1;
      }

      const entries = await build();
      validate?.(entries);
      counters.rebuilds += 1;

      try {
        await writeArtifact(artifactPath, fingerprint, entries);
        counters.artifactsWritten += 1;
      } catch (error) {
        counters.writeFailures += 1;
        logger.warn("cache.derived_artifact_write_failed", {
          reason: getSafeReason(error),
        });
      }
      return entries;
    },
    getSummary() {
      return {
        enabled: true,
        ...counters,
      };
    },
  };
}
