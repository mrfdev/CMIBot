import fs from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";

function toPosixPath(value) {
  return value.split(path.sep).join("/");
}

function normalizeCommentLine(line) {
  return line.replace(/^\s*#\s?/, "").trimEnd();
}

function buildEntry({
  relativePath,
  lineNumber,
  startLine = lineNumber,
  key,
  value = "",
  yamlPath = key,
  comments = [],
  snippet,
  codeLanguage = "text",
}) {
  return {
    relativePath: toPosixPath(relativePath),
    lineNumber,
    startLine,
    key,
    value,
    yamlPath,
    comments,
    snippet,
    searchText: extractTextForSearch(comments, `${yamlPath}\n${value}`, relativePath),
    codeLanguage,
    sourceType: "log",
  };
}

function extractTextForSearch(comments, key, relativePath) {
  const commentText = comments.map((line) => normalizeCommentLine(line)).join("\n");
  return [relativePath, key, commentText].join("\n").toLowerCase();
}

export function extractEntriesFromCommentLogText(fileText, relativePath) {
  const lines = fileText.split(/\r?\n/);
  const entries = [];
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

    entries.push(buildEntry({
      relativePath,
      lineNumber,
      startLine: commentBuffer[0]?.lineNumber ?? lineNumber,
      key: trimmed,
      value: commentBuffer.map((item) => normalizeCommentLine(item.line)).join(" ").trim(),
      yamlPath: trimmed,
      comments: commentBuffer.map((item) => item.line),
      snippet: [...commentBuffer.map((item) => item.line), line].join("\n").trimEnd(),
      codeLanguage: "text",
    }));

    commentBuffer = [];
  }

  return entries;
}

export function extractEntriesFromTokenListText(fileText, relativePath) {
  const lines = fileText.split(/\r?\n/);
  const entries = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    const lineNumber = index + 1;
    entries.push(
      buildEntry({
        relativePath,
        lineNumber,
        key: trimmed,
        value: "",
        yamlPath: trimmed,
        comments: [],
        snippet: trimmed,
        codeLanguage: "text",
      }),
    );
  }

  return entries;
}

function makeSyntheticComment(description) {
  return description ? [`# ${description}`] : [];
}

function splitDelimitedLine(line) {
  const delimiter = " - ";
  const index = line.indexOf(delimiter);
  if (index === -1) {
    return {
      key: line.trim(),
      description: "",
    };
  }

  return {
    key: line.slice(0, index).trim(),
    description: line.slice(index + delimiter.length).trim(),
  };
}

export function extractEntriesFromDelimitedText(fileText, relativePath, { preserveLine = false } = {}) {
  const lines = fileText.split(/\r?\n/);
  const entries = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    const { key, description } = splitDelimitedLine(trimmed);
    const comments = makeSyntheticComment(description);
    const lineNumber = index + 1;
    const snippet = preserveLine ? trimmed : [...comments, key].join("\n").trimEnd();

    entries.push(
      buildEntry({
        relativePath,
        lineNumber,
        key,
        value: description,
        yamlPath: key,
        comments,
        snippet,
        codeLanguage: "yml",
      }),
    );
  }

  return entries;
}

export function extractEntriesFromCmdPermsText(fileText, relativePath) {
  const lines = fileText.split(/\r?\n/);
  const entries = [];
  let current = null;

  function flushCurrent() {
    if (!current) {
      return;
    }

    const comments = [];
    if (current.description) {
      comments.push(`# ${current.description}`);
    }
    if (current.defaultValue) {
      comments.push(`# Default: ${current.defaultValue}`);
    }

    entries.push(
      buildEntry({
        relativePath,
        lineNumber: current.lineNumber,
        key: current.key,
        value: [current.description, current.defaultValue].filter(Boolean).join(" | "),
        yamlPath: current.key,
        comments,
        snippet: current.snippetLines.join("\n").trimEnd(),
        codeLanguage: "yml",
      }),
    );
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    const lineNumber = index + 1;

    if (!trimmed) {
      continue;
    }

    if (!line.startsWith(" ") && trimmed.endsWith(":")) {
      flushCurrent();
      current = {
        key: trimmed.slice(0, -1),
        lineNumber,
        description: "",
        defaultValue: "",
        snippetLines: [line],
      };
      continue;
    }

    if (!current) {
      continue;
    }

    current.snippetLines.push(line);

    const descriptionMatch = trimmed.match(/^description:\s*(.+)$/i);
    if (descriptionMatch) {
      current.description = descriptionMatch[1].trim();
      continue;
    }

    const defaultMatch = trimmed.match(/^default:\s*(.+)$/i);
    if (defaultMatch) {
      current.defaultValue = defaultMatch[1].trim();
    }
  }

  flushCurrent();
  return entries;
}

function extractEntriesByParser(parserType, fileText, relativePath) {
  switch (parserType) {
    case "commentBlocks":
      return extractEntriesFromCommentLogText(fileText, relativePath);
    case "tokenList":
      return extractEntriesFromTokenListText(fileText, relativePath);
    case "delimited":
      return extractEntriesFromDelimitedText(fileText, relativePath);
    case "cmdPerms":
      return extractEntriesFromCmdPermsText(fileText, relativePath);
    case "permissionMixed":
      return path.posix.basename(toPosixPath(relativePath)) === "cmdperms.log"
        ? extractEntriesFromCmdPermsText(fileText, relativePath)
        : extractEntriesFromDelimitedText(fileText, relativePath);
    default:
      return extractEntriesFromCommentLogText(fileText, relativePath);
  }
}

export async function loadEntriesFromLogProfile(profile, workspaceRoot) {
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
    entries.push(...extractEntriesByParser(profile.parserType ?? "commentBlocks", fileText, relativePath));
  }

  return entries;
}
