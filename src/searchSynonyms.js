import fs from "node:fs";
import path from "node:path";

const SYNONYM_SCHEMA_VERSION = 1;
const MAX_PLUGIN_GROUPS = 32;
const MAX_ALIASES_PER_PLUGIN = 100;
const MAX_TARGETS_PER_ALIAS = 8;
const MAX_TERM_LENGTH = 80;
const MAX_QUERY_VARIANTS = 16;
const SAFE_TERM_PATTERN = /^[a-z0-9][a-z0-9 ._-]*$/i;
const SAFE_PLUGIN_ID_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;
const SPECIAL_TOKEN_PATTERNS = [/^\{[^{}\s]+\}$/, /^%[^%\s]+%$/, /^\[[^\]\s]+\]$/];

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizePhrase(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function normalizeConfiguredTerm(value, label) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > MAX_TERM_LENGTH ||
    !SAFE_TERM_PATTERN.test(value.trim())
  ) {
    throw new Error(`${label} must be a short search term containing only letters, numbers, spaces, dots, underscores, or hyphens.`);
  }

  const normalized = normalizePhrase(value);
  if (!normalized) {
    throw new Error(`${label} must contain at least one letter or number.`);
  }
  return normalized;
}

function parseAliasGroup(group, pluginIndex) {
  if (!isRecord(group)) {
    throw new Error(`Search synonym plugin group ${pluginIndex} must be an object.`);
  }

  const entries = Object.entries(group);
  if (entries.length > MAX_ALIASES_PER_PLUGIN) {
    throw new Error(`Search synonym plugin group ${pluginIndex} defines too many aliases.`);
  }

  const aliases = new Map();
  for (const [rawAlias, rawTargets] of entries) {
    const alias = normalizeConfiguredTerm(rawAlias, `Search synonym alias in plugin group ${pluginIndex}`);
    if (aliases.has(alias)) {
      throw new Error(`Search synonym plugin group ${pluginIndex} contains aliases that normalize to the same term.`);
    }
    if (!Array.isArray(rawTargets) || !rawTargets.length || rawTargets.length > MAX_TARGETS_PER_ALIAS) {
      throw new Error(`Search synonym alias in plugin group ${pluginIndex} must define 1-${MAX_TARGETS_PER_ALIAS} targets.`);
    }

    const targets = [];
    const seenTargets = new Set();
    for (const rawTarget of rawTargets) {
      const target = normalizeConfiguredTerm(rawTarget, `Search synonym target in plugin group ${pluginIndex}`);
      if (target === alias) {
        throw new Error(`Search synonym alias in plugin group ${pluginIndex} cannot expand to itself.`);
      }
      if (seenTargets.has(target)) {
        throw new Error(`Search synonym alias in plugin group ${pluginIndex} contains duplicate targets.`);
      }
      seenTargets.add(target);
      targets.push(target);
    }

    aliases.set(alias, Object.freeze(targets));
  }

  return Object.freeze(Object.fromEntries(aliases));
}

export function parseSearchSynonymDocument(document) {
  if (!isRecord(document) || document.schemaVersion !== SYNONYM_SCHEMA_VERSION || !isRecord(document.plugins)) {
    throw new Error("Search synonym configuration has an unsupported schema.");
  }

  const pluginEntries = Object.entries(document.plugins);
  if (pluginEntries.length > MAX_PLUGIN_GROUPS) {
    throw new Error("Search synonym configuration defines too many plugin groups.");
  }

  const plugins = new Map();
  for (const [index, [pluginId, group]] of pluginEntries.entries()) {
    if (!SAFE_PLUGIN_ID_PATTERN.test(pluginId)) {
      throw new Error(`Search synonym plugin group ${index + 1} has an invalid identifier.`);
    }
    plugins.set(pluginId, parseAliasGroup(group, index + 1));
  }

  return Object.freeze(Object.fromEntries(plugins));
}

function resolveSafeSynonymFile(workspaceRoot, relativePath) {
  if (
    typeof relativePath !== "string" ||
    !relativePath.trim() ||
    path.extname(relativePath).toLowerCase() !== ".json" ||
    /[\u0000-\u001f\u007f]/.test(relativePath) ||
    relativePath.includes("\\") ||
    path.posix.isAbsolute(relativePath) ||
    path.win32.isAbsolute(relativePath) ||
    relativePath.split("/").some((segment) => segment === "..")
  ) {
    throw new Error("SEARCH_SYNONYMS_PATH must be a safe project-relative JSON file.");
  }

  try {
    const realWorkspaceRoot = fs.realpathSync(workspaceRoot);
    const candidatePath = path.resolve(realWorkspaceRoot, relativePath);
    const candidateStat = fs.lstatSync(candidatePath);
    if (!candidateStat.isFile() || candidateStat.isSymbolicLink()) {
      throw new Error("unsafe file type");
    }

    const realCandidatePath = fs.realpathSync(candidatePath);
    const relativeCandidate = path.relative(realWorkspaceRoot, realCandidatePath);
    if (!relativeCandidate || relativeCandidate === ".." || relativeCandidate.startsWith(`..${path.sep}`) || path.isAbsolute(relativeCandidate)) {
      throw new Error("file escaped workspace");
    }
    return realCandidatePath;
  } catch {
    throw new Error("Search synonym configuration could not be read safely.");
  }
}

export function loadSearchSynonyms(workspaceRoot, relativePath) {
  const synonymFile = resolveSafeSynonymFile(workspaceRoot, relativePath);
  let document;
  try {
    document = JSON.parse(fs.readFileSync(synonymFile, "utf8"));
  } catch {
    throw new Error("Search synonym configuration must contain valid JSON.");
  }
  return parseSearchSynonymDocument(document);
}

function isSpecialTokenQuery(query) {
  const trimmed = query.trim();
  return SPECIAL_TOKEN_PATTERNS.some((pattern) => pattern.test(trimmed));
}

function getTargets(synonyms, alias) {
  if (!Object.prototype.hasOwnProperty.call(synonyms, alias)) {
    return [];
  }
  return Array.isArray(synonyms[alias]) ? synonyms[alias] : [];
}

export function expandSearchQueries(query, synonyms = {}) {
  const trimmedQuery = query.trim();
  const normalizedQuery = normalizePhrase(trimmedQuery);
  if (!normalizedQuery || isSpecialTokenQuery(trimmedQuery) || !isRecord(synonyms)) {
    return [trimmedQuery];
  }

  const variants = [trimmedQuery];
  const seen = new Set([normalizedQuery]);
  const addVariant = (candidate) => {
    const normalizedCandidate = normalizePhrase(candidate);
    if (!normalizedCandidate || seen.has(normalizedCandidate) || variants.length >= MAX_QUERY_VARIANTS) {
      return;
    }
    seen.add(normalizedCandidate);
    variants.push(normalizedCandidate);
  };

  for (const target of getTargets(synonyms, normalizedQuery)) {
    addVariant(target);
  }

  const words = normalizedQuery.split(" ");
  let combinations = [""];
  for (const word of words) {
    const alternatives = [word, ...getTargets(synonyms, word)];
    const nextCombinations = [];
    for (const prefix of combinations) {
      for (const alternative of alternatives) {
        if (nextCombinations.length >= MAX_QUERY_VARIANTS) {
          break;
        }
        nextCombinations.push(`${prefix} ${alternative}`.trim());
      }
      if (nextCombinations.length >= MAX_QUERY_VARIANTS) {
        break;
      }
    }
    combinations = nextCombinations;
  }

  for (const combination of combinations) {
    addVariant(combination);
  }

  return variants;
}
