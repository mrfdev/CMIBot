export const MAX_VERSION_IDENTIFIER_LENGTH = 64;
const VERSION_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
const INLINE_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+ -]{0,95}$/;

export function normalizeVersionIdentifier(value, label = "Upstream version") {
  if (
    typeof value !== "string" ||
    value.length > MAX_VERSION_IDENTIFIER_LENGTH ||
    !VERSION_IDENTIFIER_PATTERN.test(value)
  ) {
    throw new Error(`${label} must be a safe version identifier.`);
  }
  return value;
}

export function tryNormalizeVersionIdentifier(value, label = "Upstream version") {
  try {
    return normalizeVersionIdentifier(value, label);
  } catch {
    return null;
  }
}

export function normalizeInlineVersion(value, label = "Version") {
  const text = typeof value === "string" ? value : String(value ?? "");
  if (!INLINE_VERSION_PATTERN.test(text)) {
    throw new Error(`${label} must be a safe inline version.`);
  }
  return text;
}

export function formatInlineVersion(value, label = "Version") {
  const text = normalizeInlineVersion(value, label);
  return `\`${text}\``;
}
