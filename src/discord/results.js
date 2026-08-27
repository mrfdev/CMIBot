import path from "node:path";
import { formatCacheSummary } from "../cache.js";
import { sanitizeForDisplay } from "../security.js";

const DISCORD_MESSAGE_LIMIT = 2000;
const TRIM_NOTICE = "_(Trimmed to fit Discord message limits.)_";

function pluralize(count, singular, plural = `${singular}s`) {
  return count === 1 ? singular : plural;
}

export function formatReloadMessage(summary) {
  return formatCacheSummary(summary, { verb: "Reloaded" }).replace(/- (\w+):/g, "- `$1`:");
}

export function formatStatsMessage(plugin, summary) {
  return [`### Lookup Stats`, `Current context: \`${plugin.label}\``, formatCacheSummary(summary)].join("\n");
}

function formatCompactFileLabel(filePath, { preferShortPath = false } = {}) {
  const baseName = path.posix.basename(filePath);
  if (!preferShortPath) {
    return baseName;
  }

  const segments = filePath.split("/");
  const root = segments[0] ?? baseName;
  const informativeParents = segments.slice(1, -1).filter((segment) => !["Translations", "Settings"].includes(segment));

  if (informativeParents.length) {
    return `${root}/${informativeParents.join("/")}/${baseName}`;
  }

  return `${root}/${baseName}`;
}

function formatFileList(filePaths, { preferShortPath = false } = {}) {
  if (!filePaths.length) {
    return "";
  }

  const baseNameCounts = new Map();
  for (const filePath of filePaths) {
    const baseName = path.posix.basename(filePath);
    baseNameCounts.set(baseName, (baseNameCounts.get(baseName) ?? 0) + 1);
  }

  const fileLabels = filePaths.map((filePath) => {
    const baseName = path.posix.basename(filePath);
    if (preferShortPath) {
      return formatCompactFileLabel(filePath, { preferShortPath: true });
    }

    if ((baseNameCounts.get(baseName) ?? 0) <= 1) {
      return formatCompactFileLabel(filePath);
    }

    return formatCompactFileLabel(filePath, { preferShortPath: true });
  });

  if (fileLabels.length <= 3) {
    return ` (${fileLabels.join(" / ")})`;
  }

  const visible = fileLabels.slice(0, 3).join(" / ");
  return ` (${visible} +${fileLabels.length - 3} more)`;
}

function formatLanguageStatsMessage(languageCategories, pluginId, formatDisplayPath) {
  if (!languageCategories?.length) {
    return "";
  }

  const groupDefinitions =
    pluginId === "jobs"
      ? [
          {
            title: "Jobs language data:",
            matcher: (category) =>
              category.englishRelativePath.startsWith("JobsPlugin/locale/") ||
              category.englishRelativePath.startsWith("JobsPlugin/TranslatableWords/"),
          },
          {
            title: "Shared CMILib language data:",
            matcher: (category) => category.englishRelativePath.startsWith("CMILibPlugin/CMILib/"),
          },
        ]
      : pluginId === "svis"
        ? [
            {
              title: "SVIS language data:",
              matcher: (category) => category.englishRelativePath.startsWith("SVISPlugin/"),
            },
            {
              title: "Shared CMILib language data:",
              matcher: (category) => category.englishRelativePath.startsWith("CMILibPlugin/CMILib/"),
            },
          ]
        : pluginId === "mfm"
          ? [
              {
                title: "MFM language data:",
                matcher: (category) => category.englishRelativePath.startsWith("MFMPlugin/"),
              },
              {
                title: "Shared CMILib language data:",
                matcher: (category) => category.englishRelativePath.startsWith("CMILibPlugin/CMILib/"),
              },
            ]
          : pluginId === "tryme"
            ? [
                {
                  title: "TryMe language data:",
                  matcher: (category) => category.englishRelativePath.startsWith("TryMePlugin/"),
                },
                {
                  title: "Shared CMILib language data:",
                  matcher: (category) => category.englishRelativePath.startsWith("CMILibPlugin/CMILib/"),
                },
              ]
            : pluginId === "trademe"
              ? [
                  {
                    title: "TradeMe language data:",
                    matcher: (category) => category.englishRelativePath.startsWith("TradeMePlugin/"),
                  },
                  {
                    title: "Shared CMILib language data:",
                    matcher: (category) => category.englishRelativePath.startsWith("CMILibPlugin/CMILib/"),
                  },
                ]
              : pluginId === "residence"
                ? [
                    {
                      title: "Residence language data:",
                      matcher: (category) => category.englishRelativePath.startsWith("ResidencePlugin/"),
                    },
                    {
                      title: "Shared CMILib language data:",
                      matcher: (category) => category.englishRelativePath.startsWith("CMILibPlugin/CMILib/"),
                    },
                  ]
                : [
                    {
                      title: "CMI language data:",
                      matcher: (category) => category.englishRelativePath.startsWith("CMIPlugin/CMI/"),
                    },
                    {
                      title: "Shared CMILib language data:",
                      matcher: (category) => category.englishRelativePath.startsWith("CMILibPlugin/CMILib/"),
                    },
                  ];

  const blocks = [];

  for (const groupDefinition of groupDefinitions) {
    const categories = languageCategories.filter(groupDefinition.matcher);
    if (!categories.length) {
      continue;
    }

    const lines = [groupDefinition.title];
    for (const category of categories) {
      const displayPath = formatDisplayPath(pluginId, category.englishRelativePath);
      const languageLabel = pluralize(category.languageCount, "language");
      const codes = category.languageCodes.map((code) => `\`${code}\``).join(", ");
      lines.push(`- \`${category.label}\` -> \`${displayPath}\`\n(${category.languageCount} ${languageLabel}: ${codes})`);
    }
    blocks.push(lines.join("\n\n"));
  }

  const groupedKeys = new Set(
    groupDefinitions.flatMap((groupDefinition) =>
      languageCategories.filter(groupDefinition.matcher).map((category) => category.key),
    ),
  );
  const ungroupedCategories = languageCategories.filter((category) => !groupedKeys.has(category.key));
  if (ungroupedCategories.length) {
    const lines = ["Other language data:"];
    for (const category of ungroupedCategories) {
      const displayPath = formatDisplayPath(pluginId, category.englishRelativePath);
      const languageLabel = pluralize(category.languageCount, "language");
      const codes = category.languageCodes.map((code) => `\`${code}\``).join(", ");
      lines.push(`- \`${category.label}\` -> \`${displayPath}\`\n(${category.languageCount} ${languageLabel}: ${codes})`);
    }
    blocks.push(lines.join("\n\n"));
  }

  return blocks.join("\n\n");
}

export function formatLangStatsOnlyMessage(plugin, languageCategories, formatDisplayPath) {
  const statsBody = formatLanguageStatsMessage(languageCategories, plugin.id, formatDisplayPath);
  if (!statsBody) {
    return `Language stats are still being worked on for the ${plugin.label} context.`;
  }

  const count = languageCategories.length;
  return [
    "### Language Stats",
    `Current context: \`${plugin.label}\``,
    `Found [${count}] ${pluralize(count, "category")} for English locale coverage.`,
    "",
    statsBody,
  ]
    .filter(Boolean)
    .join("\n");
}

function extractUrlFromComments(comments = []) {
  for (const line of comments) {
    const match = line.match(/^\s*#\s*URL:\s*(https?:\/\/\S+)\s*$/i);
    if (match) {
      return match[1];
    }
  }

  return "";
}

function stripFaqSnippet(snippet, yamlPath) {
  const lines = snippet.split("\n");
  const filtered = lines.filter(
    (line) => !/^\s*#\s*URL:\s*/i.test(line) && !/^\s*#\s*Keywords:\s*/i.test(line),
  );

  if (filtered[filtered.length - 1]?.trim() === yamlPath.trim()) {
    filtered.pop();
  }

  return filtered.join("\n").trimEnd();
}

function linkedReferenceLabel(label, url) {
  return `[${label}](<${url}>)`;
}

function getReferenceLabel(profile) {
  if (!profile?.referenceLabel) {
    return "";
  }

  if (profile.referenceUrl) {
    return linkedReferenceLabel(profile.referenceLabel, profile.referenceUrl);
  }

  return `\`${profile.referenceLabel}\``;
}

function formatResultLead(result, options) {
  const sourceLink = result.sourceUrl
    ? `[source line ${result.lineNumber}](<${result.sourceUrl}>)`
    : "";
  if (options.layout === "faq") {
    const url = extractUrlFromComments(result.comments);
    const faqLink = url ? `[${sanitizeForDisplay(result.yamlPath)}](<${url}>)` : `\`${result.yamlPath}\``;
    return sourceLink ? `${faqLink} · ${sourceLink}` : faqLink;
  }

  if (["permission", "command"].includes(options.layout)) {
    return sourceLink;
  }

  return `Look around ${sourceLink || `line ${result.lineNumber}`} -> \`${result.yamlPath}\``;
}

function formatResultSnippet(result, options) {
  if (options.layout === "faq") {
    return stripFaqSnippet(result.snippet, result.yamlPath);
  }

  return result.snippet;
}

function formatRelatedProfileName(profileName) {
  const labels = {
    command: "command",
    config: "config",
    faq: "FAQ",
    language: "language",
    material: "material",
    permission: "permission",
    placeholder: "placeholder",
    tabcomplete: "tab complete",
  };
  return labels[profileName] ?? sanitizeForDisplay(String(profileName ?? "related"));
}

function formatRelatedReference(entry) {
  const identity = `\`${sanitizeForDisplay(String(entry.yamlPath ?? "related entry"))}\``;
  const profilePrefix = entry.profileName
    ? `**${formatRelatedProfileName(entry.profileName)}:** `
    : "";
  const externalUrl = entry.profileName === "faq" ? extractUrlFromComments(entry.comments) : "";
  const sourceLabel = entry.profileName
    ? "source"
    : Number.isSafeInteger(entry.lineNumber)
      ? `line ${entry.lineNumber}`
      : "source";
  const links = [
    externalUrl ? `[open](<${externalUrl}>)` : "",
    entry.sourceUrl ? `[${sourceLabel}](<${entry.sourceUrl}>)` : "",
  ].filter(Boolean);
  const location = links.length
    ? ` (${links.join(" · ")})`
    : Number.isSafeInteger(entry.lineNumber)
      ? ` (line ${entry.lineNumber})`
      : "";
  return `${profilePrefix}${identity}${location}`;
}

function formatRelatedReferenceList(entries, indentation = "") {
  return entries.map((entry) => `${indentation}- ${formatRelatedReference(entry)}`).join("\n");
}

function formatPaginationFooter(pagination, totalMentions) {
  if (!pagination) {
    return "";
  }
  const retainedNote =
    totalMentions > pagination.availableResultCount
      ? `; top ${pagination.availableResultCount} of ${totalMentions} matches retained`
      : "";
  return `_Page ${pagination.pageNumber}/${pagination.totalPages}, showing results ${pagination.startResult}-${pagination.endResult} of ${pagination.availableResultCount}${retainedNote}._`;
}

function formatMaterialResultsMessage(keyword, results, totalMentions, options) {
  const mentionLabel = pluralize(totalMentions, "mention");
  const safeKeyword = sanitizeForDisplay(keyword);
  const header = `### Found [${totalMentions}] ${mentionLabel} in the NMS material list for \`${safeKeyword}\``;
  const values = results
    .map((result) => {
      const value = result.sourceUrl
        ? `- \`${sanitizeForDisplay(result.yamlPath)}\` ([source](<${result.sourceUrl}>))`
        : `- \`${sanitizeForDisplay(result.yamlPath)}\``;
      const relatedLine = result.related?.length
        ? `\n  - Related:\n${formatRelatedReferenceList(result.related, "    ")}`
        : "";
      return `${value}${relatedLine}`;
    })
    .join("\n");
  const footer =
    formatPaginationFooter(options.pagination, totalMentions) ||
    `_Showing ${results.length} ${pluralize(results.length, "result")}${totalMentions > results.length ? ", but there are more." : "."}_`;
  return [header, values, footer].filter(Boolean).join("\n");
}

export function formatResultsMessage(
  keyword,
  results,
  totalMentions,
  fileCount,
  aiSummary,
  allMatchedFiles,
  options = {},
) {
  if (options.layout === "materialList") {
    return formatMaterialResultsMessage(keyword, results, totalMentions, options);
  }

  const mentionLabel = pluralize(totalMentions, "mention");
  const fileLabel = pluralize(fileCount, "file");
  const shownCount = results.length;
  const groupedResults = new Map();

  for (const result of results) {
    if (!groupedResults.has(result.displayPath)) {
      groupedResults.set(result.displayPath, []);
    }

    groupedResults.get(result.displayPath).push(result);
  }

  const blocks = [];
  const hideInternalHeading = ["faq", "placeholder", "tabcomplete", "command", "permission"].includes(options.layout);

  for (const [displayPath, fileResults] of groupedResults.entries()) {
    const heading = hideInternalHeading
      ? ""
      : fileResults[0]?.sourceType === "log"
        ? `From bot's: \`${displayPath}\``
        : `In \`${displayPath}\`:`;

    if (heading) {
      blocks.push(heading);
    }

    for (const result of fileResults) {
      const leadLine = formatResultLead(result, options);
      const snippet = formatResultSnippet(result, options);
      const relatedLine = result.related?.length
        ? `Related:\n${formatRelatedReferenceList(result.related)}\n`
        : "";
      blocks.push([leadLine, `${relatedLine}\`\`\`${result.codeLanguage}\n${snippet}\n\`\`\``].filter(Boolean).join("\n"));
    }
  }

  const safeKeyword = sanitizeForDisplay(keyword);
  const fileHint = options.showFileHints === false ? "" : formatFileList(allMatchedFiles, options);
  const profileReference = getReferenceLabel(options.profile);
  const header =
    options.layout === "faq" && profileReference
      ? `### Found [${totalMentions}] ${mentionLabel} in ${profileReference} for \`${safeKeyword}\``
      : options.layout === "faq"
        ? `### Found [${totalMentions}] ${mentionLabel} for \`${safeKeyword}\``
        : options.layout === "placeholder"
          ? `### Found [${totalMentions}] ${mentionLabel} for ${profileReference || "`placeholders`"} matching \`${safeKeyword}\``
          : options.layout === "tabcomplete"
            ? `### Found [${totalMentions}] ${mentionLabel} for tabcompletes matching \`${safeKeyword}\``
            : options.layout === "command"
              ? `### Found [${totalMentions}] ${mentionLabel} for ${profileReference || "`commands`"} matching \`${safeKeyword}\``
              : options.layout === "permission"
                ? `### Found [${totalMentions}] ${mentionLabel} for ${profileReference || "`permissions`"} matching \`${safeKeyword}\``
                : `### Found [${totalMentions}] ${mentionLabel} in [${fileCount}] ${fileLabel} for \`${safeKeyword}\`${fileHint}`;

  let footer = formatPaginationFooter(options.pagination, totalMentions);
  if (!footer && shownCount === totalMentions) {
    footer = `_Showing ${shownCount} ${pluralize(shownCount, "result")}._`;
  } else if (!footer && totalMentions > shownCount) {
    footer = `_Showing top ${shownCount} results, but there are more._`;
  }

  const summaryBlock = aiSummary ? `Local grounded summary: ${aiSummary}` : "";
  return [header, ...blocks, summaryBlock, footer].filter(Boolean).join("\n");
}

export function truncateDiscordMessage(message) {
  if (message.length <= DISCORD_MESSAGE_LIMIT) {
    return message;
  }

  let body = "";
  let codeFenceOpen = false;
  for (const line of message.split("\n")) {
    const nextBody = body ? `${body}\n${line}` : line;
    const fenceCount = line.match(/```/g)?.length ?? 0;
    const nextFenceOpen = fenceCount % 2 === 1 ? !codeFenceOpen : codeFenceOpen;
    const closedBody = `${nextBody.trimEnd()}${nextFenceOpen ? "\n```" : ""}`;
    const candidate = `${closedBody}\n\n${TRIM_NOTICE}`;
    if (candidate.length > DISCORD_MESSAGE_LIMIT) {
      break;
    }
    body = nextBody;
    codeFenceOpen = nextFenceOpen;
  }

  const retained = body.trimEnd();
  if (!retained) {
    return TRIM_NOTICE;
  }
  const closed = `${retained}${codeFenceOpen ? "\n```" : ""}`;
  return `${closed}\n\n${TRIM_NOTICE}`;
}

export function splitDiscordMessages(message, maxLength = 1900) {
  const blocks = [];
  let blockLines = [];
  for (const line of message.split("\n")) {
    const trimmed = line.trim();
    const startsSection =
      blockLines.length &&
      (trimmed.startsWith("### ") || /^\*\*.+:\*\*$/.test(trimmed) || (!trimmed.startsWith("-") && trimmed.endsWith(":")));
    if (startsSection) {
      blocks.push(blockLines.join("\n"));
      blockLines = [];
    }
    blockLines.push(line);
  }
  if (blockLines.length) {
    blocks.push(blockLines.join("\n"));
  }

  const chunks = [];
  let current = "";
  for (const block of blocks) {
    const candidate = current ? `${current}\n${block}` : block;
    if (candidate.length <= maxLength) {
      current = candidate;
      continue;
    }
    if (current) {
      chunks.push(current);
    }
    current = block;
  }

  if (current || !chunks.length) {
    chunks.push(current);
  }

  return chunks.flatMap((chunk) => {
    if (chunk.length <= maxLength) {
      return [chunk];
    }
    const parts = [];
    let part = "";
    for (const line of chunk.split("\n")) {
      if (line.length > maxLength) {
        if (part) {
          parts.push(part);
          part = "";
        }
        for (let index = 0; index < line.length; index += maxLength) {
          const slice = line.slice(index, index + maxLength);
          if (slice.length === maxLength) {
            parts.push(slice);
          } else {
            part = slice;
          }
        }
        continue;
      }
      const candidate = part ? `${part}\n${line}` : line;
      if (candidate.length <= maxLength) {
        part = candidate;
        continue;
      }
      if (part) {
        parts.push(part);
      }
      part = line;
    }
    if (part) {
      parts.push(part);
    }
    return parts;
  });
}
