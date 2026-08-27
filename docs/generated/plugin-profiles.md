# Plugin profile reference

Generated from `src/configMetadata.js`. All paths are repository-relative globs; runtime validation rejects absolute paths and parent-directory traversal.

## Shared CMILib (shared)

| Profile | Source | Include variable | Default includes | Exclude variable | Default excludes |
| --- | --- | --- | --- | --- | --- |
| `config` | yaml | `CMILIB_LOOKUP_INCLUDE_GLOBS` | `CMILibPlugin/CMILib/config.yml` | `CMILIB_LOOKUP_EXCLUDE_GLOBS` | (none) |
| `language` | yaml | `CMILIB_LANGUAGE_INCLUDE_GLOBS` | `CMILibPlugin/CMILib/Translations/**/*_EN.yml` | `CMILIB_LANGUAGE_EXCLUDE_GLOBS` | (none) |
| `placeholder` | log | `CMILIB_PLACEHOLDER_INCLUDE_GLOBS` | `CMILibPlugin/data/generated-placeholders.log` | `CMILIB_PLACEHOLDER_EXCLUDE_GLOBS` | (none) |

## CMI

| Profile | Source | Include variable | Default includes | Exclude variable | Default excludes |
| --- | --- | --- | --- | --- | --- |
| `config` | yaml | `LOOKUP_INCLUDE_GLOBS` | `CMIPlugin/CMI/config.yml,CMIPlugin/CMI/Settings/**/*.yml` | `LOOKUP_EXCLUDE_GLOBS` | `**/Translations/**,**/DatabaseBackups/**,**/FileBackups/**,**/Logs/**,**/moneyLog/**,**/sellLogs/**` |
| `language` | yaml | `LANGLOOKUP_INCLUDE_GLOBS` | `CMIPlugin/CMI/Translations/**/Locale_EN.yml` | `LANGLOOKUP_EXCLUDE_GLOBS` | (none) |
| `placeholder` | log | `PLACEHOLDER_INCLUDE_GLOBS` | `CMIPlugin/data/placeholders.log,CMIPlugin/data/generated-placeholders.log` | `PLACEHOLDER_EXCLUDE_GLOBS` | (none) |
| `material` | log | `MATERIAL_INCLUDE_GLOBS` | `CMIPlugin/data/materials.log` | `MATERIAL_EXCLUDE_GLOBS` | (none) |
| `command` | log | `COMMAND_INCLUDE_GLOBS` | `CMIPlugin/data/commands.log,CMIPlugin/data/generated-commands.log` | `COMMAND_EXCLUDE_GLOBS` | (none) |
| `permission` | log | `PERMISSION_INCLUDE_GLOBS` | `CMIPlugin/data/permissions.log,CMIPlugin/data/cmdperms.log,CMIPlugin/data/generated-permissions.log` | `PERMISSION_EXCLUDE_GLOBS` | (none) |
| `faq` | log | `FAQ_INCLUDE_GLOBS` | `CMIPlugin/data/faq.log` | `FAQ_EXCLUDE_GLOBS` | (none) |
| `tabcomplete` | log | `TABCOMPLETE_INCLUDE_GLOBS` | `CMIPlugin/data/tabcompletes.log` | `TABCOMPLETE_EXCLUDE_GLOBS` | (none) |

## Jobs

| Profile | Source | Include variable | Default includes | Exclude variable | Default excludes |
| --- | --- | --- | --- | --- | --- |
| `config` | yaml | `JOBS_LOOKUP_INCLUDE_GLOBS` | `JobsPlugin/*.yml,JobsPlugin/jobs/**/*.yml` | `JOBS_LOOKUP_EXCLUDE_GLOBS` | `JobsPlugin/locale/**,JobsPlugin/TranslatableWords/**,JobsPlugin/data/**,JobsPlugin/Signs.yml,JobsPlugin/activeBoosts.yml,JobsPlugin/blockOwnerShips.yml` |
| `language` | yaml | `JOBS_LANGUAGE_INCLUDE_GLOBS` | `JobsPlugin/locale/messages_en.yml,JobsPlugin/TranslatableWords/Words_en.yml` | `JOBS_LANGUAGE_EXCLUDE_GLOBS` | (none) |
| `placeholder` | log | `JOBS_PLACEHOLDER_INCLUDE_GLOBS` | `JobsPlugin/data/placeholders.log,JobsPlugin/data/generated-placeholders.log` | `JOBS_PLACEHOLDER_EXCLUDE_GLOBS` | (none) |
| `command` | log | `JOBS_COMMAND_INCLUDE_GLOBS` | `JobsPlugin/data/commands.log,JobsPlugin/data/generated-commands.log` | `JOBS_COMMAND_EXCLUDE_GLOBS` | (none) |
| `permission` | log | `JOBS_PERMISSION_INCLUDE_GLOBS` | `JobsPlugin/data/permissions.log,JobsPlugin/data/generated-permissions.log` | `JOBS_PERMISSION_EXCLUDE_GLOBS` | (none) |
| `faq` | log | `JOBS_FAQ_INCLUDE_GLOBS` | `JobsPlugin/data/faq.log,JobsPlugin/data/faq/*.md` | `JOBS_FAQ_EXCLUDE_GLOBS` | (none) |

## SVIS

| Profile | Source | Include variable | Default includes | Exclude variable | Default excludes |
| --- | --- | --- | --- | --- | --- |
| `config` | yaml | `SVIS_LOOKUP_INCLUDE_GLOBS` | `SVISPlugin/config.yml` | `SVIS_LOOKUP_EXCLUDE_GLOBS` | (none) |
| `language` | yaml | `SVIS_LANGUAGE_INCLUDE_GLOBS` | `SVISPlugin/Locale_EN.yml` | `SVIS_LANGUAGE_EXCLUDE_GLOBS` | (none) |
| `command` | log | `SVIS_COMMAND_INCLUDE_GLOBS` | `SVISPlugin/data/commands.log,SVISPlugin/data/generated-commands.log` | `SVIS_COMMAND_EXCLUDE_GLOBS` | (none) |
| `permission` | log | `SVIS_PERMISSION_INCLUDE_GLOBS` | `SVISPlugin/data/permissions.log,SVISPlugin/data/generated-permissions.log` | `SVIS_PERMISSION_EXCLUDE_GLOBS` | (none) |

## Residence

| Profile | Source | Include variable | Default includes | Exclude variable | Default excludes |
| --- | --- | --- | --- | --- | --- |
| `config` | yaml | `RESIDENCE_LOOKUP_INCLUDE_GLOBS` | `ResidencePlugin/config.yml,ResidencePlugin/groups.yml,ResidencePlugin/flags.yml,ResidencePlugin/ShopVotes.yml` | `RESIDENCE_LOOKUP_EXCLUDE_GLOBS` | (none) |
| `language` | yaml | `RESIDENCE_LANGUAGE_INCLUDE_GLOBS` | `ResidencePlugin/Language/English.yml` | `RESIDENCE_LANGUAGE_EXCLUDE_GLOBS` | (none) |
| `placeholder` | log | `RESIDENCE_PLACEHOLDER_INCLUDE_GLOBS` | `ResidencePlugin/data/placeholders.log,ResidencePlugin/data/generated-placeholders.log` | `RESIDENCE_PLACEHOLDER_EXCLUDE_GLOBS` | (none) |
| `command` | log | `RESIDENCE_COMMAND_INCLUDE_GLOBS` | `ResidencePlugin/data/commands.log,ResidencePlugin/data/generated-commands.log` | `RESIDENCE_COMMAND_EXCLUDE_GLOBS` | (none) |
| `permission` | log | `RESIDENCE_PERMISSION_INCLUDE_GLOBS` | `ResidencePlugin/data/permissions.log,ResidencePlugin/data/generated-permissions.log` | `RESIDENCE_PERMISSION_EXCLUDE_GLOBS` | (none) |

## MFM

| Profile | Source | Include variable | Default includes | Exclude variable | Default excludes |
| --- | --- | --- | --- | --- | --- |
| `config` | yaml | `MFM_LOOKUP_INCLUDE_GLOBS` | `MFMPlugin/config.yml` | `MFM_LOOKUP_EXCLUDE_GLOBS` | (none) |
| `language` | yaml | `MFM_LANGUAGE_INCLUDE_GLOBS` | `MFMPlugin/Locale/Locale_EN.yml` | `MFM_LANGUAGE_EXCLUDE_GLOBS` | (none) |
| `command` | log | `MFM_COMMAND_INCLUDE_GLOBS` | `MFMPlugin/data/generated-commands.log` | `MFM_COMMAND_EXCLUDE_GLOBS` | (none) |
| `permission` | log | `MFM_PERMISSION_INCLUDE_GLOBS` | `MFMPlugin/data/generated-permissions.log` | `MFM_PERMISSION_EXCLUDE_GLOBS` | (none) |

## TryMe

| Profile | Source | Include variable | Default includes | Exclude variable | Default excludes |
| --- | --- | --- | --- | --- | --- |
| `config` | yaml | `TRYME_LOOKUP_INCLUDE_GLOBS` | `TryMePlugin/*.yml` | `TRYME_LOOKUP_EXCLUDE_GLOBS` | `TryMePlugin/Locale_EN.yml,TryMePlugin/Signs.yml` |
| `language` | yaml | `TRYME_LANGUAGE_INCLUDE_GLOBS` | `TryMePlugin/Locale_EN.yml` | `TRYME_LANGUAGE_EXCLUDE_GLOBS` | (none) |
| `placeholder` | log | `TRYME_PLACEHOLDER_INCLUDE_GLOBS` | `TryMePlugin/data/generated-placeholders.log` | `TRYME_PLACEHOLDER_EXCLUDE_GLOBS` | (none) |
| `command` | log | `TRYME_COMMAND_INCLUDE_GLOBS` | `TryMePlugin/data/generated-commands.log` | `TRYME_COMMAND_EXCLUDE_GLOBS` | (none) |
| `permission` | log | `TRYME_PERMISSION_INCLUDE_GLOBS` | `TryMePlugin/data/generated-permissions.log` | `TRYME_PERMISSION_EXCLUDE_GLOBS` | (none) |

## TradeMe

| Profile | Source | Include variable | Default includes | Exclude variable | Default excludes |
| --- | --- | --- | --- | --- | --- |
| `config` | yaml | `TRADEME_LOOKUP_INCLUDE_GLOBS` | `TradeMePlugin/config.yml` | `TRADEME_LOOKUP_EXCLUDE_GLOBS` | (none) |
| `language` | yaml | `TRADEME_LANGUAGE_INCLUDE_GLOBS` | `TradeMePlugin/Locale_EN.yml` | `TRADEME_LANGUAGE_EXCLUDE_GLOBS` | (none) |
| `placeholder` | log | `TRADEME_PLACEHOLDER_INCLUDE_GLOBS` | `TradeMePlugin/data/generated-placeholders.log` | `TRADEME_PLACEHOLDER_EXCLUDE_GLOBS` | (none) |
| `command` | log | `TRADEME_COMMAND_INCLUDE_GLOBS` | `TradeMePlugin/data/generated-commands.log` | `TRADEME_COMMAND_EXCLUDE_GLOBS` | (none) |
| `permission` | log | `TRADEME_PERMISSION_INCLUDE_GLOBS` | `TradeMePlugin/data/generated-permissions.log` | `TRADEME_PERMISSION_EXCLUDE_GLOBS` | (none) |

## BottledExp

| Profile | Source | Include variable | Default includes | Exclude variable | Default excludes |
| --- | --- | --- | --- | --- | --- |
| `config` | yaml | `BOTTLEDEXP_LOOKUP_INCLUDE_GLOBS` | `BottledExpPlugin/config.yml,BottledExpPlugin/recipes.yml` | `BOTTLEDEXP_LOOKUP_EXCLUDE_GLOBS` | (none) |
| `language` | yaml | `BOTTLEDEXP_LANGUAGE_INCLUDE_GLOBS` | `BottledExpPlugin/Locale_EN.yml` | `BOTTLEDEXP_LANGUAGE_EXCLUDE_GLOBS` | (none) |
| `command` | log | `BOTTLEDEXP_COMMAND_INCLUDE_GLOBS` | `BottledExpPlugin/data/generated-commands.log` | `BOTTLEDEXP_COMMAND_EXCLUDE_GLOBS` | (none) |
| `permission` | log | `BOTTLEDEXP_PERMISSION_INCLUDE_GLOBS` | `BottledExpPlugin/data/generated-permissions.log` | `BOTTLEDEXP_PERMISSION_EXCLUDE_GLOBS` | (none) |
