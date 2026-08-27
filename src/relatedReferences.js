const MAX_INDEX_TOKENS_PER_ENTRY = 64;
const MAX_ANCHOR_TOKENS = 12;
const DEFAULT_MAX_REFERENCES = 6;
const MINIMUM_REFERENCE_SCORE = 100;

const NAMESPACE_TOKENS = new Set([
  "bottle",
  "bottledexp",
  "cmi",
  "cmilib",
  "jobs",
  "jobsr",
  "mfm",
  "res",
  "residence",
  "svis",
  "trademe",
  "tryme",
]);

const STRUCTURAL_TOKENS = new Set([
  "all",
  "allow",
  "allows",
  "command",
  "commands",
  "config",
  "configuration",
  "current",
  "default",
  "description",
  "disable",
  "disabled",
  "enable",
  "enabled",
  "false",
  "fixed",
  "formatted",
  "general",
  "info",
  "information",
  "main",
  "manage",
  "manager",
  "message",
  "messages",
  "name",
  "none",
  "number",
  "option",
  "options",
  "other",
  "others",
  "player",
  "players",
  "plugin",
  "setting",
  "settings",
  "show",
  "support",
  "true",
  "use",
  "user",
  "users",
  "value",
  "values",
]);

const CONTENT_STOP_TOKENS = new Set([
  ...STRUCTURAL_TOKENS,
  "about",
  "after",
  "also",
  "and",
  "are",
  "before",
  "can",
  "category",
  "check",
  "com",
  "does",
  "faq",
  "for",
  "from",
  "get",
  "github",
  "has",
  "have",
  "http",
  "https",
  "into",
  "keywords",
  "only",
  "that",
  "the",
  "their",
  "this",
  "through",
  "url",
  "with",
  "your",
]);

const MODIFIER_TOKENS = new Set([
  "admin",
  "bypass",
  "clean",
  "formatted",
  "fixed",
  "other",
  "others",
]);

const TARGET_PROFILE_ORDER = {
  command: ["permission", "config", "placeholder", "faq", "tabcomplete", "language", "material"],
  permission: ["command", "config", "faq", "placeholder", "language", "tabcomplete", "material"],
  placeholder: ["command", "permission", "config", "faq", "language", "tabcomplete", "material"],
  faq: ["command", "permission", "config", "placeholder", "language", "tabcomplete", "material"],
  config: ["command", "permission", "placeholder", "faq", "language", "tabcomplete", "material"],
  language: ["command", "permission", "config", "placeholder", "faq", "tabcomplete", "material"],
  tabcomplete: ["command", "permission", "config", "placeholder", "faq", "language", "material"],
  material: ["config", "language", "command", "permission", "placeholder", "faq", "tabcomplete"],
};

const TARGET_PROFILE_LIMITS = {
  config: 2,
  permission: 2,
};

function clampInteger(value, minimum, maximum, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed)
    ? Math.max(minimum, Math.min(maximum, parsed))
    : fallback;
}

function tokenize(value) {
  return (
    String(value ?? "")
      .slice(0, 4_000)
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
      .match(/[a-z0-9]+/gi) ?? []
  )
    .map((token) => token.toLowerCase())
    .filter((token) => token.length >= 2 && token.length <= 40 && !/^\d+$/.test(token));
}

function uniqueTokens(value, { excludeContentStops = false } = {}) {
  const output = [];
  const seen = new Set();
  for (const token of tokenize(value)) {
    if (
      seen.has(token) ||
      NAMESPACE_TOKENS.has(token) ||
      (excludeContentStops && token.length < 3) ||
      (excludeContentStops && CONTENT_STOP_TOKENS.has(token))
    ) {
      continue;
    }
    seen.add(token);
    output.push(token);
    if (output.length >= MAX_INDEX_TOKENS_PER_ENTRY) {
      break;
    }
  }
  return output;
}

function getCommandLiterals(entry) {
  const raw = String(entry?.key || entry?.yamlPath || "").trim();
  const literals = [];
  for (const rawPart of raw.split(/\s+/)) {
    if (!rawPart || /^[([{-]/.test(rawPart)) {
      break;
    }
    const part = rawPart.replace(/^\/+/, "").replace(/[^a-z0-9_/-]+$/gi, "");
    if (!part) {
      continue;
    }
    literals.push(part);
  }
  return literals;
}

function getCanonicalSubject(profileName, entry) {
  if (profileName === "command") {
    const literals = getCommandLiterals(entry);
    const subject = literals.length > 1 ? literals[1] : literals[0];
    return uniqueTokens(subject).find((token) => !NAMESPACE_TOKENS.has(token)) ?? "";
  }

  const rawIdentifier = String(entry?.yamlPath || entry?.key || "");
  const identifierTokens = uniqueTokens(rawIdentifier);
  if (profileName === "permission") {
    const commandIndex = identifierTokens.indexOf("command");
    if (commandIndex >= 0 && identifierTokens[commandIndex + 1]) {
      return identifierTokens[commandIndex + 1];
    }
    return [...identifierTokens]
      .reverse()
      .find((token) => !MODIFIER_TOKENS.has(token) && !STRUCTURAL_TOKENS.has(token)) ?? "";
  }

  if (profileName === "placeholder") {
    return identifierTokens.find(
      (token) => !MODIFIER_TOKENS.has(token) && !STRUCTURAL_TOKENS.has(token),
    ) ?? "";
  }

  if (["config", "language"].includes(profileName)) {
    return identifierTokens.find((token) => !STRUCTURAL_TOKENS.has(token)) ?? "";
  }

  if (profileName === "faq") {
    return identifierTokens.find((token) => !STRUCTURAL_TOKENS.has(token)) ?? "";
  }

  return identifierTokens.find((token) => !STRUCTURAL_TOKENS.has(token)) ?? "";
}

function buildEntryRecord(profileName, entry) {
  const commandLiterals = profileName === "command" ? getCommandLiterals(entry).join(" ") : "";
  const identifierText = profileName === "command"
    ? commandLiterals
    : [entry?.key, entry?.yamlPath].filter(Boolean).join("\n");
  const contentText = [
    entry?.value,
    ...(entry?.comments ?? []),
  ].filter(Boolean).join("\n");
  return {
    profileName,
    entry,
    canonicalSubject: getCanonicalSubject(profileName, entry),
    identifierTokens: new Set(uniqueTokens(identifierText)),
    identifierKey: uniqueTokens(identifierText).join(" "),
    contentTokens: new Set(uniqueTokens(contentText, { excludeContentStops: true })),
  };
}

function collectAnchors(sourceRecord, query) {
  const anchors = new Map();
  function add(token, weight) {
    if (!token || NAMESPACE_TOKENS.has(token)) {
      return;
    }
    const previous = anchors.get(token) ?? 0;
    if (weight > previous) {
      anchors.set(token, weight);
    }
  }

  add(sourceRecord.canonicalSubject, 120);

  const queryTokens = uniqueTokens(query);
  const meaningfulQueryTokens = queryTokens.filter((token) => !STRUCTURAL_TOKENS.has(token));
  for (const token of meaningfulQueryTokens.length ? meaningfulQueryTokens : queryTokens) {
    add(token, 100);
  }
  for (const token of sourceRecord.identifierTokens) {
    if (!STRUCTURAL_TOKENS.has(token)) {
      add(token, 60);
    }
  }

  if (["command", "permission", "placeholder", "faq"].includes(sourceRecord.profileName)) {
    let contentAnchorCount = 0;
    for (const token of sourceRecord.contentTokens) {
      if (!anchors.has(token)) {
        add(token, 30);
        contentAnchorCount += 1;
      }
      if (contentAnchorCount >= 4) {
        break;
      }
    }
  }

  return [...anchors.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, MAX_ANCHOR_TOKENS);
}

function getCanonicalMatchBonus(sourceRecord, candidateRecord) {
  if (
    !sourceRecord.canonicalSubject ||
    sourceRecord.canonicalSubject !== candidateRecord.canonicalSubject
  ) {
    return 0;
  }
  const pair = new Set([sourceRecord.profileName, candidateRecord.profileName]);
  if (pair.has("command") && pair.has("permission")) {
    return 1_500;
  }
  if (pair.has("placeholder") && (pair.has("command") || pair.has("permission"))) {
    return 900;
  }
  return 650;
}

function scoreCandidate(sourceRecord, candidateRecord, anchors) {
  let score = getCanonicalMatchBonus(sourceRecord, candidateRecord);
  let identifierMatches = 0;
  let contentMatches = 0;
  const identifierMultiplier = candidateRecord.profileName === "faq" ? 1 : 4;
  for (const [token, weight] of anchors) {
    if (candidateRecord.identifierTokens.has(token)) {
      score += weight * identifierMultiplier;
      identifierMatches += 1;
    } else if (candidateRecord.contentTokens.has(token)) {
      score += weight;
      contentMatches += 1;
    }
  }
  const totalMatches = identifierMatches + contentMatches;
  if (totalMatches > 1) {
    score += (totalMatches - 1) * 100;
  }
  return {
    score,
    identifierMatches,
    contentMatches,
    totalMatches,
    exactIdentityMatch:
      sourceRecord.identifierKey.length > 0 &&
      sourceRecord.identifierKey === candidateRecord.identifierKey,
  };
}

function compareCandidates(left, right) {
  return (
    right.score - left.score ||
    right.identifierMatches - left.identifierMatches ||
    right.contentMatches - left.contentMatches ||
    String(left.record.entry.yamlPath).length - String(right.record.entry.yamlPath).length ||
    Number(left.record.entry.lineNumber) - Number(right.record.entry.lineNumber) ||
    String(left.record.entry.yamlPath).localeCompare(
      String(right.record.entry.yamlPath),
      undefined,
      { sensitivity: "base" },
    )
  );
}

export function createRelatedReferenceIndex(entriesByProfile = {}) {
  const profileIndexes = new Map();
  for (const [profileName, entries] of Object.entries(entriesByProfile)) {
    const records = (entries ?? []).map((entry) => buildEntryRecord(profileName, entry));
    const recordsByToken = new Map();
    for (const record of records) {
      for (const token of new Set([...record.identifierTokens, ...record.contentTokens])) {
        const tokenRecords = recordsByToken.get(token) ?? [];
        tokenRecords.push(record);
        recordsByToken.set(token, tokenRecords);
      }
    }
    profileIndexes.set(profileName, { records, recordsByToken });
  }

  return {
    find({
      sourceProfileName,
      sourceEntry,
      query = "",
      maxReferences = DEFAULT_MAX_REFERENCES,
      isEntryAllowed = () => true,
    }) {
      const sourceRecord = buildEntryRecord(sourceProfileName, sourceEntry);
      const anchors = collectAnchors(sourceRecord, query);
      if (!anchors.length) {
        return [];
      }

      const maximum = clampInteger(maxReferences, 1, 10, DEFAULT_MAX_REFERENCES);
      const requiredMatchCount = sourceProfileName === "material" ? 2 : 1;
      const profileOrder = TARGET_PROFILE_ORDER[sourceProfileName] ?? [...profileIndexes.keys()];
      const references = [];
      for (const targetProfileName of profileOrder) {
        if (targetProfileName === sourceProfileName || references.length >= maximum) {
          continue;
        }
        const targetIndex = profileIndexes.get(targetProfileName);
        if (!targetIndex) {
          continue;
        }

        const candidates = new Set();
        for (const [token] of anchors) {
          for (const record of targetIndex.recordsByToken.get(token) ?? []) {
            candidates.add(record);
          }
        }
        const ranked = [...candidates]
          .filter((record) => isEntryAllowed(record.entry, targetProfileName))
          .map((record) => ({
            record,
            ...scoreCandidate(sourceRecord, record, anchors),
          }))
          .filter(
            (candidate) =>
              candidate.score >= MINIMUM_REFERENCE_SCORE &&
              (candidate.totalMatches >= requiredMatchCount || candidate.exactIdentityMatch),
          )
          .sort(compareCandidates);
        const profileLimit = TARGET_PROFILE_LIMITS[targetProfileName] ?? 1;
        for (const candidate of ranked.slice(0, profileLimit)) {
          references.push({
            profileName: targetProfileName,
            entry: candidate.record.entry,
          });
          if (references.length >= maximum) {
            break;
          }
        }
      }
      return references;
    },
    getProfileCount() {
      return profileIndexes.size;
    },
  };
}
