import { loadProfileSourceSnapshot } from "./profileSources.js";

const KEY_LINE_PATTERN = /^(\s*)([^#\s-][^:]*?):(?:\s*(.*))?$/;
const DEFAULT_SURROUNDING_LINE_COUNT = 2;

function toPosixPath(value) {
  return String(value).replace(/\\/g, "/");
}

function stripInlineComment(value) {
  if (!value) {
    return "";
  }

  return value.replace(/\s+#.*$/, "").trim();
}

function normalizeCommentLine(line) {
  return line.replace(/^\s*#\s?/, "").trimEnd();
}

function getLeadingSpaceCount(line) {
  const match = line.match(/^\s*/);
  return match ? match[0].length : 0;
}

function collectContinuationLines(lines, startIndex, entryIndent) {
  const collected = [];

  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const candidate = lines[index];
    const trimmed = candidate.trim();

    if (!trimmed) {
      break;
    }

    if (trimmed.startsWith("#")) {
      break;
    }

    if (KEY_LINE_PATTERN.test(candidate)) {
      break;
    }

    const candidateIndent = getLeadingSpaceCount(candidate);
    if (candidateIndent < entryIndent) {
      break;
    }

    collected.push(candidate);
  }

  return collected;
}

function buildSnippet(lines, lineNumber, commentBuffer, continuationLines = []) {
  const startLine = commentBuffer.length ? commentBuffer[0].lineNumber : lineNumber;
  const snippetLines = [
    ...commentBuffer.map((comment) => lines[comment.lineNumber - 1]),
    lines[lineNumber - 1],
    ...continuationLines,
  ];

  return {
    startLine,
    snippet: snippetLines.join("\n").trimEnd(),
  };
}

function extractTextForSearch(comments, yamlPath, key, value, continuationLines = []) {
  const commentText = comments.map((line) => normalizeCommentLine(line)).join("\n");
  const continuationText = continuationLines.join("\n");
  return [yamlPath, key, value, continuationText, commentText].join("\n").toLowerCase();
}

function attachIndexedYamlContext(entries, entryIndents, lines) {
  const document = Object.freeze({ lines: Object.freeze(lines) });
  const openEntries = [];

  function closeEntry(entryIndex, boundaryStartLine) {
    const entry = entries[entryIndex];
    let blockEndLine = Math.max(entry.lineNumber, boundaryStartLine - 1);
    while (blockEndLine > entry.lineNumber && !lines[blockEndLine - 1]?.trim()) {
      blockEndLine -= 1;
    }

    Object.defineProperty(entry, "indexedYamlContext", {
      value: Object.freeze({
        document,
        blockStartLine: entry.startLine,
        blockEndLine,
      }),
      enumerable: false,
      configurable: false,
      writable: false,
    });
  }

  for (let entryIndex = 0; entryIndex < entries.length; entryIndex += 1) {
    const indent = entryIndents[entryIndex];
    while (openEntries.length && entryIndents[openEntries.at(-1)] >= indent) {
      closeEntry(openEntries.pop(), entries[entryIndex].startLine);
    }
    openEntries.push(entryIndex);
  }

  while (openEntries.length) {
    closeEntry(openEntries.pop(), lines.length + 1);
  }
}

export function extractEntriesFromText(fileText, relativePath) {
  const lines = fileText.split(/\r?\n/);
  const entries = [];
  const entryIndents = [];
  const stack = [];
  let commentBuffer = [];

  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const line = lines[index];
    const trimmed = line.trim();

    if (!trimmed) {
      commentBuffer = [];
      continue;
    }

    if (trimmed.startsWith("#")) {
      commentBuffer.push({ lineNumber, line });
      continue;
    }

    const keyMatch = line.match(KEY_LINE_PATTERN);
    if (!keyMatch) {
      commentBuffer = [];
      continue;
    }

    const indent = keyMatch[1].length;
    const rawKey = keyMatch[2].trim();
    const value = stripInlineComment(keyMatch[3] ?? "");
    const continuationLines = value ? [] : collectContinuationLines(lines, index, indent);

    while (stack.length && stack[stack.length - 1].indent >= indent) {
      stack.pop();
    }

    const yamlPath = [...stack.map((item) => item.key), rawKey].join(".");
    const { startLine, snippet } = buildSnippet(lines, lineNumber, commentBuffer, continuationLines);

    entries.push({
      relativePath: toPosixPath(relativePath),
      lineNumber,
      startLine,
      key: rawKey,
      value,
      yamlPath,
      comments: commentBuffer.map((item) => item.line),
      snippet,
      searchText: extractTextForSearch(
        commentBuffer.map((item) => item.line),
        yamlPath,
        rawKey,
        value,
        continuationLines,
      ),
    });
    entryIndents.push(indent);

    stack.push({
      indent,
      key: rawKey,
    });
    commentBuffer = [];
  }

  attachIndexedYamlContext(entries, entryIndents, lines);

  return entries;
}

export async function loadEntriesForProfile(profile, workspaceRoot, { sourceFiles } = {}) {
  const files = sourceFiles ?? (await loadProfileSourceSnapshot(profile, workspaceRoot)).files;
  const entries = [];

  for (const { relativePath, fileText } of files) {
    entries.push(...extractEntriesFromText(fileText, relativePath));
  }

  return entries;
}

export function makeDisplayContext(
  entry,
  pluginId,
  formatDisplayPath,
  { includeIndexedYamlContext = false } = {},
) {
  const displayContext = {
    displayPath: formatDisplayPath(pluginId, entry.relativePath),
    relativePath: entry.relativePath,
    lineNumber: entry.lineNumber,
    yamlPath: entry.yamlPath,
    snippet: entry.snippet,
    comments: entry.comments ?? [],
    codeLanguage: entry.codeLanguage ?? "yml",
    sourceType: entry.sourceType ?? "yaml",
  };

  if (includeIndexedYamlContext && entry.indexedYamlContext) {
    Object.defineProperty(displayContext, "indexedYamlContext", {
      value: entry.indexedYamlContext,
      enumerable: false,
      configurable: false,
      writable: false,
    });
  }

  return displayContext;
}

export function materializeIndexedYamlContext(
  entry,
  { surroundingLineCount = DEFAULT_SURROUNDING_LINE_COUNT } = {},
) {
  const metadata = entry?.indexedYamlContext;
  const lines = metadata?.document?.lines;
  if (
    !Array.isArray(lines) ||
    !Number.isSafeInteger(metadata.blockStartLine) ||
    !Number.isSafeInteger(metadata.blockEndLine) ||
    metadata.blockStartLine < 1 ||
    metadata.blockEndLine < metadata.blockStartLine ||
    metadata.blockEndLine > lines.length
  ) {
    return null;
  }

  const parsedSurroundingLines = Number(surroundingLineCount);
  const surroundingLines = Number.isSafeInteger(parsedSurroundingLines)
    ? Math.max(0, Math.min(10, parsedSurroundingLines))
    : DEFAULT_SURROUNDING_LINE_COUNT;
  const startLine = Math.max(1, metadata.blockStartLine - surroundingLines);
  const endLine = Math.min(lines.length, metadata.blockEndLine + surroundingLines);

  return {
    startLine,
    endLine,
    blockStartLine: metadata.blockStartLine,
    blockEndLine: metadata.blockEndLine,
    snippet: lines.slice(startLine - 1, endLine).join("\n").trimEnd(),
  };
}

function getParentYamlPath(yamlPath) {
  const lastDotIndex = yamlPath.lastIndexOf(".");
  if (lastDotIndex === -1) {
    return "";
  }

  return yamlPath.slice(0, lastDotIndex);
}

export function findRelatedEntries(targetEntry, allEntries, limit = 2) {
  const sameFileEntries = allEntries.filter(
    (entry) => entry.relativePath === targetEntry.relativePath && entry.yamlPath !== targetEntry.yamlPath,
  );
  const parentYamlPath = getParentYamlPath(targetEntry.yamlPath);

  let candidates = [];

  if (parentYamlPath) {
    candidates = sameFileEntries.filter((entry) => getParentYamlPath(entry.yamlPath) === parentYamlPath);
  }

  if (!candidates.length) {
    candidates = sameFileEntries.filter((entry) => getParentYamlPath(entry.yamlPath) === targetEntry.yamlPath);
  }

  return candidates
    .sort((left, right) => {
      const leftDistance = Math.abs(left.lineNumber - targetEntry.lineNumber);
      const rightDistance = Math.abs(right.lineNumber - targetEntry.lineNumber);

      if (leftDistance !== rightDistance) {
        return leftDistance - rightDistance;
      }

      return left.lineNumber - right.lineNumber;
    })
    .slice(0, limit)
    .sort((left, right) => left.lineNumber - right.lineNumber)
    .map((entry) => ({
      yamlPath: entry.yamlPath,
      lineNumber: entry.lineNumber,
    }));
}

export function findLineContext(fileText, lineNumber) {
  const lines = fileText.split(/\r?\n/);
  const index = Math.max(0, Math.min(lines.length - 1, lineNumber - 1));
  const currentLine = lines[index] ?? "";
  const leadingSpaceCount = getLeadingSpaceCount(currentLine);

  let startIndex = index;
  while (startIndex > 0) {
    const candidate = lines[startIndex - 1];
    if (!candidate.trim().startsWith("#")) {
      break;
    }
    startIndex -= 1;
  }

  let endIndex = index;
  while (endIndex + 1 < lines.length) {
    const candidate = lines[endIndex + 1];
    if (!candidate.trim()) {
      break;
    }

    const candidateIndent = getLeadingSpaceCount(candidate);
    if (candidateIndent <= leadingSpaceCount && KEY_LINE_PATTERN.test(candidate)) {
      break;
    }

    if (candidate.trim().startsWith("#")) {
      break;
    }

    endIndex += 1;
  }

  return {
    startLine: startIndex + 1,
    snippet: lines.slice(startIndex, endIndex + 1).join("\n").trimEnd(),
  };
}
