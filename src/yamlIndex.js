import fs from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";

const KEY_LINE_PATTERN = /^(\s*)([^#\s-][^:]*?):(?:\s*(.*))?$/;

function stripInlineComment(value) {
  if (!value) {
    return "";
  }

  return value.replace(/\s+#.*$/, "").trim();
}

function normalizeCommentLine(line) {
  return line.replace(/^\s*#\s?/, "").trimEnd();
}

function toPosixPath(value) {
  return value.split(path.sep).join("/");
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

function extractTextForSearch(comments, yamlPath, key, value, relativePath, continuationLines = []) {
  const commentText = comments.map((line) => normalizeCommentLine(line)).join("\n");
  const continuationText = continuationLines.join("\n");
  return [relativePath, yamlPath, key, value, continuationText, commentText].join("\n").toLowerCase();
}

export function extractEntriesFromText(fileText, relativePath) {
  const lines = fileText.split(/\r?\n/);
  const entries = [];
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
        relativePath,
        continuationLines,
      ),
    });

    stack.push({
      indent,
      key: rawKey,
    });
    commentBuffer = [];
  }

  return entries;
}

export async function loadEntriesForProfile(profile, workspaceRoot) {
  const relativePaths = await fg(profile.include, {
    cwd: workspaceRoot,
    ignore: profile.exclude,
    onlyFiles: true,
    unique: true,
    dot: false,
  });

  const entries = [];

  for (const relativePath of relativePaths.sort()) {
    const absolutePath = path.join(workspaceRoot, relativePath);
    const fileText = await fs.readFile(absolutePath, "utf8");
    entries.push(...extractEntriesFromText(fileText, relativePath));
  }

  return entries;
}

export function makeDisplayContext(entry, formatDisplayPath) {
  return {
    displayPath: formatDisplayPath(entry.relativePath),
    relativePath: entry.relativePath,
    lineNumber: entry.lineNumber,
    yamlPath: entry.yamlPath,
    snippet: entry.snippet,
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
