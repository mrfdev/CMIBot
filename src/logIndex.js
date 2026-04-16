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
  const delimiters = [" - ", " – ", " — "];
  const matchedDelimiter = delimiters.find((delimiter) => line.includes(delimiter));

  if (!matchedDelimiter) {
    return {
      key: line.trim(),
      description: "",
    };
  }

  const index = line.indexOf(matchedDelimiter);

  return {
    key: line.slice(0, index).trim(),
    description: line.slice(index + matchedDelimiter.length).trim(),
  };
}

function looksLikePermissionNode(line) {
  return /^[a-z0-9_.:[\]-]+$/i.test(line.trim());
}

function stripHtml(line) {
  return line
    .replace(/<g-emoji[^>]*>(.*?)<\/g-emoji>/gi, "$1")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeMarkdownLinks(text) {
  return text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1");
}

function slugToKeywords(fileName) {
  return fileName
    .replace(/^jobs-/, "")
    .replace(/\.md$/i, "")
    .split(/-/)
    .filter(Boolean)
    .join(", ");
}

function cleanFaqTitle(rawTitle, relativePath) {
  let title = rawTitle.trim().replace(/^#+\s*/, "");
  title = title.replace(/^FAQ\s*-\s*/i, "").trim();

  if (!title) {
    const fileName = path.posix.basename(toPosixPath(relativePath));
    title = fileName
      .replace(/^jobs-/, "")
      .replace(/\.md$/i, "")
      .split("-")
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ");
  }

  return title;
}

function isUsefulMarkdownLine(line) {
  if (!line) {
    return false;
  }

  if (line === "---") {
    return false;
  }

  if (/^https?:\/\//i.test(line)) {
    return false;
  }

  if (/^Zrips Discord @/i.test(line)) {
    return false;
  }

  if (/^(FAQ Menu|Official Zrips Links|Prerequisites|More information|Backup|Test setup|Note ahead\.)$/i.test(line)) {
    return false;
  }

  if (/^(Download Jobs-Reborn|Also Download CMILib)/i.test(line)) {
    return false;
  }

  if (/^[•*-]\s+(api|bug-reports|can-i-do-thing-x-per-job|change-bossbar-color|commands|permissions|quests|translations)/i.test(line)) {
    return false;
  }

  return true;
}

function extractMarkdownFaqSummary(fileText) {
  const lines = fileText.split(/\r?\n/);
  const separatorIndex = lines.findIndex((line) => line.trim() === "---");
  const bodyLines = separatorIndex >= 0 ? lines.slice(separatorIndex + 1) : lines;

  const paragraphs = [];
  const bulletSections = [];
  let current = [];
  let currentBulletSection = [];
  let inCode = false;
  let collectingBullets = false;

  function flushParagraph() {
    if (!current.length) {
      return;
    }

    const paragraph = current.join(" ").replace(/\s+/g, " ").trim();
    if (paragraph) {
      paragraphs.push(paragraph);
    }
    current = [];
  }

  function flushBulletSection() {
    if (!currentBulletSection.length) {
      return;
    }

    bulletSections.push([...currentBulletSection]);
    currentBulletSection = [];
  }

  for (const rawLine of bodyLines) {
    const trimmed = rawLine.trim();

    if (/^```/.test(trimmed)) {
      inCode = !inCode;
      flushParagraph();
      flushBulletSection();
      continue;
    }

    if (inCode) {
      continue;
    }

    if (!trimmed) {
      flushParagraph();
      flushBulletSection();
      collectingBullets = false;
      continue;
    }

    if (/^#+\s+/.test(trimmed)) {
      flushParagraph();
      flushBulletSection();
      collectingBullets = false;
      continue;
    }

    let line = normalizeMarkdownLinks(stripHtml(trimmed));
    if (!line) {
      flushParagraph();
      flushBulletSection();
      collectingBullets = false;
      continue;
    }

    const bulletMatch = line.match(/^[-*]\s+(.+)$/);
    if (bulletMatch) {
      const bulletLine = bulletMatch[1].trim();
      if (isUsefulMarkdownLine(bulletLine)) {
        flushParagraph();
        currentBulletSection.push(bulletLine);
        collectingBullets = true;
      }
      continue;
    }

    if (collectingBullets) {
      flushBulletSection();
      collectingBullets = false;
    }

    if (!isUsefulMarkdownLine(line)) {
      flushParagraph();
      flushBulletSection();
      continue;
    }

    current.push(line.trim());
  }

  flushParagraph();
  flushBulletSection();

  const usableParagraphs = paragraphs.filter((paragraph) => {
    if (/^(This page should help explain|If some piece of text is wrong)/i.test(paragraph)) {
      return false;
    }

    if (
      /^(All my FAQ pages have been written|The mrfdev github page is not an official resource|I am an admin on the Zrips Discord)/i.test(
        paragraph,
      )
    ) {
      return false;
    }

    return true;
  });
  const primaryParagraph = usableParagraphs[0] ?? "";
  const secondaryParagraph = usableParagraphs[1] ?? "";
  const primaryBullets = bulletSections.find((section) => section.length) ?? [];

  let summary = primaryParagraph;

  if (primaryParagraph && /such as[:.]?$/i.test(primaryParagraph) && primaryBullets.length) {
    summary = `${primaryParagraph} ${primaryBullets.slice(0, 4).join("; ")}.`;
  } else if (!primaryParagraph && primaryBullets.length) {
    summary = primaryBullets.slice(0, 4).join("; ");
  } else if (primaryParagraph && primaryParagraph.length < 120 && secondaryParagraph) {
    summary = `${primaryParagraph} ${secondaryParagraph}`;
  }

  return summary
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .slice(0, 420)
    .trim();
}

function buildMarkdownFaqUrl(relativePath) {
  const fileName = path.posix.basename(toPosixPath(relativePath));
  return `https://github.com/mrfdev/Jobs/blob/main/Resources/FAQ/${fileName}`;
}

export function extractEntriesFromMarkdownFaqText(fileText, relativePath) {
  const lines = fileText.split(/\r?\n/);
  const firstHeadingIndex = lines.findIndex((line) => /^#\s+/.test(line));
  const title = cleanFaqTitle(firstHeadingIndex >= 0 ? lines[firstHeadingIndex] : "", relativePath);
  const summary =
    extractMarkdownFaqSummary(fileText) || "See the linked FAQ entry for the full explanation and step-by-step guidance.";
  const fileName = path.posix.basename(toPosixPath(relativePath));
  const comments = [
    "# Category: Jobs GitHub FAQ",
    `# URL: ${buildMarkdownFaqUrl(relativePath)}`,
    `# Answer: ${summary}`,
    `# Keywords: ${slugToKeywords(fileName)}`,
  ];
  const lineNumber = firstHeadingIndex >= 0 ? firstHeadingIndex + 1 : 1;

  return [
    buildEntry({
      relativePath,
      lineNumber,
      startLine: lineNumber,
      key: title,
      value: summary,
      yamlPath: title,
      comments,
      snippet: [...comments, title].join("\n").trimEnd(),
      codeLanguage: "text",
    }),
  ];
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

export function extractEntriesFromPermissionListText(fileText, relativePath) {
  const lines = fileText.split(/\r?\n/);
  const entries = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    const { key, description } = splitDelimitedLine(trimmed);
    const lineNumber = index + 1;

    if (!description && !looksLikePermissionNode(key)) {
      continue;
    }

    const comments = makeSyntheticComment(description);

    entries.push(
      buildEntry({
        relativePath,
        lineNumber,
        key,
        value: description,
        yamlPath: key,
        comments,
        snippet: [...comments, key].join("\n").trimEnd(),
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
    case "permissionList":
      return extractEntriesFromPermissionListText(fileText, relativePath);
    case "faqMixed":
      return path.posix.extname(toPosixPath(relativePath)).toLowerCase() === ".md"
        ? extractEntriesFromMarkdownFaqText(fileText, relativePath)
        : extractEntriesFromCommentLogText(fileText, relativePath);
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
    const parsedEntries = extractEntriesByParser(profile.parserType ?? "commentBlocks", fileText, relativePath);
    if (profile.codeLanguage) {
      entries.push(...parsedEntries.map((entry) => ({ ...entry, codeLanguage: profile.codeLanguage })));
    } else {
      entries.push(...parsedEntries);
    }
  }

  return entries;
}
