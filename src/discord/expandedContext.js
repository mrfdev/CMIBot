import { sanitizeForDisplay } from "../security.js";
import { materializeIndexedYamlContext } from "../yamlIndex.js";
import { NO_MENTIONS } from "./constants.js";

const DISCORD_MESSAGE_LIMIT = 2_000;
const DEFAULT_INLINE_SNIPPET_LIMIT = 1_400;
const DEFAULT_ATTACHMENT_SIZE_LIMIT = 8 * 1024 * 1024;
const MAX_CONTEXT_ATTACHMENT_BYTES = 1024 * 1024;
const YAML_KEY_LINE_PATTERN = /^(\s*)([^#\s-][^:]*?):(?:\s*(.*))?$/;
const SAFE_EMPTY_YAML_VALUE_PATTERN = /^(?:["']{2}|null|~|\[\]|\{\}|#.*)$/i;
const YAML_BLOCK_SCALAR_PATTERN = /^[>|](?:[1-9][+-]?|[+-][1-9]?)?(?:\s+#.*)?$/;
const SENSITIVE_YAML_KEY_PATTERN =
  /(?:^|[-_. ])(?:password|passwd|secret|token|credentials?|authorization|api[-_. ]?key|private[-_. ]?key|access[-_. ]?key|client[-_. ]?secret|auth[-_. ]?token|bearer[-_. ]?token|refresh[-_. ]?token)(?:$|[-_. ])/i;
const SENSITIVE_YAML_KEY_SUFFIX_PATTERN =
  /(?:password|passwd|secret|token|credential|credentials|authorization|apikey|privatekey|accesskey|clientsecret|authtoken|bearertoken|refreshtoken)$/i;

function clampInteger(value, minimum, maximum, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed)
    ? Math.max(minimum, Math.min(maximum, parsed))
    : fallback;
}

function sanitizeCodeBlock(value) {
  return String(value).replaceAll("```", "``\u200b`");
}

function getIndentWidth(line) {
  return line.match(/^\s*/)?.[0].length ?? 0;
}

function hasIndentedContent(lines, startIndex, parentIndent) {
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim()) {
      continue;
    }
    return getIndentWidth(line) > parentIndent;
  }
  return false;
}

function isSensitiveYamlKey(value) {
  const key = String(value).replace(/^['"]|['"]$/g, "");
  const separatedKey = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  const compactKey = key.replace(/[^a-z0-9]/gi, "");
  return (
    SENSITIVE_YAML_KEY_PATTERN.test(separatedKey) ||
    SENSITIVE_YAML_KEY_SUFFIX_PATTERN.test(compactKey)
  );
}

function redactSensitiveYamlValues(snippet) {
  const lines = String(snippet).split("\n");
  let redactedBlockIndent = null;
  let redacted = false;

  const safeLines = lines.map((line, index) => {
    if (redactedBlockIndent != null) {
      if (!line.trim()) {
        return line;
      }
      const indent = getIndentWidth(line);
      if (indent > redactedBlockIndent) {
        redacted = true;
        return `${line.slice(0, indent)}# redacted`;
      }
      redactedBlockIndent = null;
    }

    const match = line.match(YAML_KEY_LINE_PATTERN);
    if (!match || !isSensitiveYamlKey(match[2])) {
      return line;
    }

    const value = (match[3] ?? "").trim();
    const hasNestedValue = !value && hasIndentedContent(lines, index, match[1].length);
    if ((!value && !hasNestedValue) || SAFE_EMPTY_YAML_VALUE_PATTERN.test(value)) {
      return line;
    }

    redacted = true;
    if (hasNestedValue || YAML_BLOCK_SCALAR_PATTERN.test(value)) {
      redactedBlockIndent = match[1].length;
    }
    return `${match[1]}${match[2]}: <redacted>`;
  });

  return {
    snippet: safeLines.join("\n"),
    redacted,
  };
}

function safeYamlPath(value) {
  const sanitized = sanitizeForDisplay(String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim());
  return sanitized.slice(0, 180) || "indexed YAML entry";
}

function getSafeSourceUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      url.hostname.toLowerCase() === "github.com" &&
      !url.username &&
      !url.password
      ? url.href
      : "";
  } catch {
    return "";
  }
}

function formatLineRange(startLine, endLine) {
  return startLine === endLine ? `line ${startLine}` : `lines ${startLine}-${endLine}`;
}

function buildHeader(result, context) {
  const sourceUrl = getSafeSourceUrl(result?.sourceUrl);
  const sourceLabel = sourceUrl
    ? `[source line ${result.lineNumber}](<${sourceUrl}>)`
    : `source line ${result?.lineNumber ?? context.blockStartLine}`;

  return [
    "### Expanded YAML Context",
    `Entry: \`${safeYamlPath(result?.yamlPath)}\` · ${sourceLabel}`,
    `Matched block: \`${formatLineRange(context.blockStartLine, context.blockEndLine)}\`; surrounding excerpt: \`${formatLineRange(context.startLine, context.endLine)}\`.`,
  ].join("\n");
}

export function canExpandYamlContext(result) {
  return Boolean(result?.indexedYamlContext?.document?.lines);
}

export function createExpandedYamlContextPayload(result, {
  attachmentSizeLimit = DEFAULT_ATTACHMENT_SIZE_LIMIT,
  inlineSnippetLimit = DEFAULT_INLINE_SNIPPET_LIMIT,
} = {}) {
  const context = materializeIndexedYamlContext(result);
  if (!context?.snippet) {
    return null;
  }

  const redaction = redactSensitiveYamlValues(context.snippet);
  const redactionNotice = redaction.redacted
    ? "\nSensitive-looking non-empty values were redacted."
    : "";
  const header = `${buildHeader(result, context)}${redactionNotice}`;
  const safeSnippet = sanitizeCodeBlock(redaction.snippet);
  const inlineLimit = clampInteger(inlineSnippetLimit, 200, 1_700, DEFAULT_INLINE_SNIPPET_LIMIT);
  const inlineContent = `${header}\n\`\`\`yaml\n${safeSnippet}\n\`\`\``;
  if (safeSnippet.length <= inlineLimit && inlineContent.length <= DISCORD_MESSAGE_LIMIT) {
    return {
      content: inlineContent,
      allowedMentions: NO_MENTIONS,
    };
  }

  const attachment = Buffer.from(redaction.snippet, "utf8");
  const uploadLimit = Math.min(
    clampInteger(
      attachmentSizeLimit,
      1,
      DEFAULT_ATTACHMENT_SIZE_LIMIT,
      DEFAULT_ATTACHMENT_SIZE_LIMIT,
    ),
    MAX_CONTEXT_ATTACHMENT_BYTES,
  );
  if (attachment.byteLength <= uploadLimit) {
    return {
      content: `${header}\nThe expanded indexed excerpt is attached privately because it is too long for an inline Discord code block.`,
      files: [{
        attachment,
        name: "lookup-context.yml",
        description: "Expanded indexed YAML block with bounded surrounding context",
      }],
      allowedMentions: NO_MENTIONS,
    };
  }

  return {
    content: getSafeSourceUrl(result?.sourceUrl)
      ? `${header}\nThis indexed block is too large to attach safely. Use the pinned source link above to inspect it.`
      : `${header}\nThis indexed block is too large to attach safely. Search for a more specific nested key to reduce the block size.`,
    allowedMentions: NO_MENTIONS,
  };
}
