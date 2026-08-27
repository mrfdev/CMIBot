const YAML_KEY_LINE_PATTERN = /^(\s*)([^#\s-][^:]*?):(?:\s*(.*))?$/;
const SAFE_EMPTY_YAML_VALUE_PATTERN = /^(?:["']{2}|null|~|\[\]|\{\}|#.*)$/i;
const YAML_BLOCK_SCALAR_PATTERN = /^[>|](?:[1-9][+-]?|[+-][1-9]?)?(?:\s+#.*)?$/;
const SENSITIVE_YAML_KEY_PATTERN =
  /(?:^|[-_. ])(?:password|passwd|secret|token|credentials?|authorization|api[-_. ]?key|private[-_. ]?key|access[-_. ]?key|client[-_. ]?secret|auth[-_. ]?token|bearer[-_. ]?token|refresh[-_. ]?token)(?:$|[-_. ])/i;
const SENSITIVE_YAML_KEY_SUFFIX_PATTERN =
  /(?:password|passwd|secret|token|credential|credentials|authorization|apikey|privatekey|accesskey|clientsecret|authtoken|bearertoken|refreshtoken)$/i;
const PRIVATE_KEY_BLOCK_PATTERN = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/gi;
const AUTHORIZATION_TOKEN_PATTERN = /\b(?:Bot|Bearer)\s+[A-Za-z0-9._~+/-]{8,}/gi;
const COMMON_API_TOKEN_PATTERN = /\b(?:sk-[A-Za-z0-9_-]{8,}|AIza[A-Za-z0-9_-]{12,})\b/g;
const DISCORD_TOKEN_PATTERN = /\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{20,}\b/g;
const DISCORD_SNOWFLAKE_PATTERN = /\b\d{17,20}\b/g;
const ABSOLUTE_PRIVATE_PATH_PATTERN = /(?:\/(?:Users|home|private|var|etc|opt|tmp)(?:\/[^\s"'`]+)+|[A-Za-z]:\\[^\s"'`]+)/g;
const SENSITIVE_ASSIGNMENT_PATTERN =
  /\b(password|passwd|secret|token|credentials?|authorization|api[-_. ]?key|private[-_. ]?key|access[-_. ]?key|client[-_. ]?secret)\b(\s*[:=]\s*)(?!<redacted>)([^\s,;]{6,})/gi;

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

export function redactSensitiveYamlValues(snippet) {
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

export function redactSensitiveText(value) {
  let valueText = String(value);
  let redacted = false;
  const replace = (pattern, replacement) => {
    valueText = valueText.replace(pattern, (...args) => {
      redacted = true;
      return typeof replacement === "function" ? replacement(...args) : replacement;
    });
  };

  replace(PRIVATE_KEY_BLOCK_PATTERN, "<redacted private key>");
  replace(AUTHORIZATION_TOKEN_PATTERN, "<redacted authorization>");
  replace(COMMON_API_TOKEN_PATTERN, "<redacted token>");
  replace(DISCORD_TOKEN_PATTERN, "<redacted token>");
  replace(DISCORD_SNOWFLAKE_PATTERN, "<redacted id>");
  replace(ABSOLUTE_PRIVATE_PATH_PATTERN, "<redacted path>");
  replace(SENSITIVE_ASSIGNMENT_PATTERN, (_match, key, separator) => `${key}${separator}<redacted>`);

  return { text: valueText, redacted };
}

export function redactIndexedEvidence(value) {
  const yaml = redactSensitiveYamlValues(value);
  const generic = redactSensitiveText(yaml.snippet);
  return {
    text: generic.text,
    redacted: yaml.redacted || generic.redacted,
  };
}
