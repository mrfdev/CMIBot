import path from "node:path";
import fg from "fast-glob";

const KNOWN_CATEGORY_LABELS = new Map([
  ["CMIPlugin/CMI/Translations/Locale_EN.yml", "CMI (plugin locale)"],
  ["CMIPlugin/CMI/Translations/DeathMessages/Locale_EN.yml", "CMI (death messages locale)"],
  ["CMILibPlugin/CMILib/Translations/Locale_EN.yml", "CMILib (global locale)"],
  ["CMILibPlugin/CMILib/Translations/Items/items_EN.yml", "CMILib (items locale)"],
]);

const KNOWN_CATEGORY_ORDER = [...KNOWN_CATEGORY_LABELS.keys()];

function toPosixPath(value) {
  return value.split(path.sep).join("/");
}

function humanizeToken(value) {
  return value
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .toLowerCase();
}

function extractLanguageCode(relativePath) {
  const baseName = path.posix.basename(relativePath, ".yml");
  const localeMatch = baseName.match(/^Locale_([A-Za-z0-9]+)$/i);
  if (localeMatch) {
    return localeMatch[1].toUpperCase();
  }

  const suffixMatch = baseName.match(/_([A-Za-z0-9]+)$/);
  if (suffixMatch) {
    return suffixMatch[1].toUpperCase();
  }

  return null;
}

function buildSiblingPattern(englishRelativePath) {
  const directory = path.posix.dirname(englishRelativePath);
  const baseName = path.posix.basename(englishRelativePath);

  if (/^Locale_EN\.yml$/i.test(baseName)) {
    return `${directory}/Locale_*.yml`;
  }

  return `${directory}/${baseName.replace(/_EN\.yml$/i, "_*.yml")}`;
}

function buildFallbackLabel(englishRelativePath) {
  const normalizedPath = toPosixPath(englishRelativePath);
  const segments = normalizedPath.split("/");
  const root = segments[0] ?? "Locale";
  const baseName = path.posix.basename(normalizedPath, ".yml");

  if (baseName === "Locale_EN") {
    const categorySegment = segments.at(-2);
    if (categorySegment === "Translations") {
      return `${root} (global locale)`;
    }

    return `${root} (${humanizeToken(categorySegment ?? "locale")} locale)`;
  }

  const shortName = baseName.replace(/_EN$/i, "");
  return `${root} (${humanizeToken(shortName)} locale)`;
}

export async function buildLanguageCategoryStats(workspaceRoot, includeGlobs) {
  const englishRelativePaths = await fg(includeGlobs, {
    cwd: workspaceRoot,
    onlyFiles: true,
    unique: true,
    dot: false,
  });

  const categories = [];

  const orderedEnglishPaths = englishRelativePaths.sort((left, right) => {
    const normalizedLeft = toPosixPath(left);
    const normalizedRight = toPosixPath(right);
    const leftIndex = KNOWN_CATEGORY_ORDER.indexOf(normalizedLeft);
    const rightIndex = KNOWN_CATEGORY_ORDER.indexOf(normalizedRight);

    if (leftIndex !== -1 || rightIndex !== -1) {
      if (leftIndex === -1) {
        return 1;
      }
      if (rightIndex === -1) {
        return -1;
      }

      return leftIndex - rightIndex;
    }

    return normalizedLeft.localeCompare(normalizedRight);
  });

  for (const englishRelativePath of orderedEnglishPaths) {
    const normalizedEnglishPath = toPosixPath(englishRelativePath);
    const siblingPattern = buildSiblingPattern(normalizedEnglishPath);
    const siblingPaths = await fg([siblingPattern], {
      cwd: workspaceRoot,
      onlyFiles: true,
      unique: true,
      dot: false,
    });

    const languageCodes = siblingPaths
      .map((relativePath) => extractLanguageCode(toPosixPath(relativePath)))
      .filter(Boolean)
      .sort((left, right) => left.localeCompare(right));

    categories.push({
      key: normalizedEnglishPath,
      label: KNOWN_CATEGORY_LABELS.get(normalizedEnglishPath) ?? buildFallbackLabel(normalizedEnglishPath),
      englishRelativePath: normalizedEnglishPath,
      languageCodes,
      languageCount: languageCodes.length,
    });
  }

  return categories;
}

export function formatLanguageCategoryStats(categories, formatDisplayPath, pluginId = "cmi") {
  if (!categories?.length) {
    return "";
  }

  const lines = ["Language categories:"];

  for (const category of categories) {
    const displayPath = formatDisplayPath(pluginId, category.englishRelativePath);
    const languageLabel = category.languageCount === 1 ? "language" : "languages";
    const codes = category.languageCodes.join(", ");
    lines.push(`- ${category.label} -> ${displayPath} (${category.languageCount} ${languageLabel}: ${codes})`);
  }

  return lines.join("\n");
}
