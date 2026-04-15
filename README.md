# CMIBot

CMIBot is a Discord slash-command bot for searching CMI and CMILib config/locale data by keyword while preserving the comment context that explains each setting.

It is designed for support workflows like:

```text
/cmibot help
/cmibot config dynmap
/cmibot config chat file:Chat.yml
/cmibot config cuff
/cmibot config bluemap related:true
/cmibot config dynmap summary:true
/cmibot config "mini message" mode:broad
/cmibot config "mini message" mode:whole
/cmibot language home
/cmibot lang "was fireballed by"
/cmibot placeholder balance
/cmibot placeholder %cmi_user_balance% mode:whole
/cmibot material shulker
/cmibot cmd balance
/cmibot perm cmi.command.balance
/cmibot faq refund
/cmibot tabcomplete [playername] mode:whole
/cmibot langstats
/cmibot debug
/cmibot reload
```

The bot builds an in-memory cache from the indexed YAML and log files in this folder. When you add, replace, rename, or remove indexed files later, refresh the cache with `/cmibot reload` or by restarting the bot.

Git note: the live SQLite database at `CMI/cmi.sqlite.db` is runtime data and is intentionally kept out of Git.

## What It Does

- Registers a `/cmibot` slash command with `config`, `language`, `lang`, `placeholder`, `material`, `command`, `cmd`, `permission`, `perm`, `faq`, `tabcomplete`, `langstats`, `stats`, and `debug` subcommands
- Registers a `/cmibot help` command for channel-local usage guidance
- Registers an admin-only `/cmibot reload` command for rebuilding the in-memory search cache
- Restricts usage to your configured guild, channel, and allowed roles
- Pairs YAML comment blocks with the setting line directly below them
- Supports comment-backed and exported log lookups such as `data/placeholders.log`, `data/materials.log`, `data/commands.log`, `data/permissions.log`, `data/cmdperms.log`, `data/faq.log`, and `data/tabcompletes.log`
- Uses lexical search first and optionally uses OpenAI to rerank the best candidates
- Groups visible results by file and shows them top-to-bottom inside each file
- Supports `mode: exact|whole|broad` for tighter or looser matching
- Supports `file: ...` on `config` to narrow searches to a specific indexed config file
- Supports `related: true|false` for nearby YAML context entries
- Supports `summary: true|false` for an optional AI-generated explanation, restricted to configured AI role IDs
- Applies per-user cooldowns, query validation, no-mention replies, and audit logging for safer operation
- Separates config, translation, and placeholder search through include/exclude globs

## Quick Start

1. Create the Discord bot application and copy its token and application ID.
2. Create an OpenAI API key.
3. Copy `.env.example` to `.env` and fill in the values.
4. Install dependencies:

```bash
npm install
```

5. Start the bot:

```bash
npm start
```

## Environment

The bot reads its settings from `.env`.

- `DISCORD_TOKEN`: Bot token from the Discord Developer Portal
- `DISCORD_APPLICATION_ID`: Discord application ID
- `DISCORD_GUILD_ID`: Guild/server ID
- `DISCORD_ALLOWED_CHANNEL_IDS`: Comma-separated channel IDs allowed to use the bot
- `DISCORD_CMI_CHANNEL_IDS`: Channel IDs that should route as CMI support channels
- `DISCORD_CMI_TEST_CHANNEL_IDS`: Channel IDs that should route as CMI test channels
- `DISCORD_JOBS_CHANNEL_IDS`: Channel IDs that should route as Jobs support channels for future multi-plugin routing
- `ALLOWED_ROLE_IDS`: Comma-separated role IDs allowed to use CMIBot search and stats commands
- `ADMIN_ROLE_IDS`: Comma-separated role IDs allowed to use `/cmibot reload`
- `AI_ROLE_IDS`: Comma-separated role IDs allowed to use AI-backed features like reranking and `summary:true`
- `OPENAI_ENABLED`: Hard switch for all OpenAI-backed features
- `OPENAI_API_KEY`: Optional but recommended for AI-assisted reranking
- `OPENAI_MODEL`: Model used for reranking, default `gpt-5-mini`
- `DISPLAY_PATH_PREFIX`: Path prefix shown in results, default `~/plugins`
- `LOOKUP_COOLDOWN_SECONDS`: Per-user cooldown for search commands
- `SUMMARY_COOLDOWN_SECONDS`: Per-user cooldown for AI summary requests
- `QUERY_MIN_LENGTH`: Minimum alphanumeric query length unless allowlisted
- `QUERY_MAX_LENGTH`: Maximum query length
- `QUERY_BLOCKLIST`: Exact-match filler words to reject as too broad
- `QUERY_ALLOWLIST`: Exact-match short queries that should still be allowed
- `QUERY_DEBUG_ERRORS`: When `true`, validation replies include more specific rejection reasons
- `AUDIT_LOG_PATH`: Relative path for JSONL audit logs
- `LOOKUP_INCLUDE_GLOBS`: Regular config lookup scope
- `LOOKUP_EXCLUDE_GLOBS`: Files and folders excluded from regular lookup
- `LANGLOOKUP_INCLUDE_GLOBS`: Locale lookup scope
- `LANGLOOKUP_EXCLUDE_GLOBS`: Files and folders excluded from locale lookup
- `PLACEHOLDER_INCLUDE_GLOBS`: Placeholder log lookup scope
- `PLACEHOLDER_EXCLUDE_GLOBS`: Files and folders excluded from placeholder lookup
- `MATERIAL_INCLUDE_GLOBS`: Material log lookup scope
- `MATERIAL_EXCLUDE_GLOBS`: Files and folders excluded from material lookup
- `COMMAND_INCLUDE_GLOBS`: Command log lookup scope
- `COMMAND_EXCLUDE_GLOBS`: Files and folders excluded from command lookup
- `PERMISSION_INCLUDE_GLOBS`: Permission lookup scope
- `PERMISSION_EXCLUDE_GLOBS`: Files and folders excluded from permission lookup
- `FAQ_INCLUDE_GLOBS`: FAQ lookup scope
- `FAQ_EXCLUDE_GLOBS`: Files and folders excluded from FAQ lookup
- `TABCOMPLETE_INCLUDE_GLOBS`: Tab-complete lookup scope
- `TABCOMPLETE_EXCLUDE_GLOBS`: Files and folders excluded from tab-complete lookup

## Discord Setup

1. Go to the Discord Developer Portal and create a new application.
2. Add a bot user under the `Bot` section.
3. Enable the permissions you want the bot to have. For this bot, `View Channels`, `Send Messages`, and `Use Application Commands` are enough to start.
4. Copy the bot token into `.env` as `DISCORD_TOKEN`.
5. Copy the application ID into `.env` as `DISCORD_APPLICATION_ID`.
6. Invite the bot to your server.
7. Give the bot the `@CMI` role in your Discord server.

This project already defaults to:

- Guild ID: `452792793631555594`
- Allowed channels: `526402563847880725` (`#cmi`), `1493976695152054353` (`#bot-test`)
- CMI context channels: `526402563847880725` (`#cmi`)
- CMI test channels: `1493976695152054353` (`#bot-test`)
- Jobs context channels: `526402919826849804`
- Allowed role IDs: `526407132224946186`, `452793620471218186`, `526451949051314188`, `526452401239228416`, `893444734138322984`, `1037695349667659848`
- Reload admin role ID: `526407132224946186`

## OpenAI Setup

1. Go to the OpenAI platform dashboard.
2. Create a new API key.
3. Put the key in `.env` as `OPENAI_API_KEY`.
4. Leave `OPENAI_MODEL` as `gpt-5-mini` unless you want to change it.

If `OPENAI_ENABLED=false`, the bot uses lexical search only and skips all AI-backed features entirely.
If `OPENAI_ENABLED=true`, AI summaries and reranking also require a working OpenAI API key plus API billing/quota.

With the current recommended setup, keep `OPENAI_ENABLED=false` until API billing/quota is ready.

## Search Profiles

Regular config lookup, language lookup, and exported-data lookups are kept separate on purpose.

- `/cmibot config <keyword>` searches regular config files
- `/cmibot language|lang <keyword>` searches English locale/translation files
- `/cmibot placeholder <keyword>` searches exported placeholder entries
- `/cmibot material <keyword>` searches exported material names
- `/cmibot command|cmd <keyword>` searches exported command usage entries
- `/cmibot permission|perm <keyword>` searches exported permission entries from both `permissions.log` and `cmdperms.log`
- `/cmibot faq <keyword>` searches curated FAQ titles, links, and short notes
- `/cmibot tabcomplete <keyword>` searches exported tab-complete entries
- `/cmibot langstats` shows locale categories and available languages without requiring a keyword
- `/cmibot stats` shows cache totals and per-profile counts
- `/cmibot debug` shows which configured plugin/channel context the current channel maps to
- `/cmibot help` shows command usage in the configured channel

You can adjust the file scopes in `.env` without changing code.

## Commands

### `/cmibot help`

Shows the bot's current capabilities in the configured support channels.

- Available to anyone in the configured channel
- If the user is not in an allowed support/admin role, the help output includes a notice that command access is limited
- Kept intentionally concise so it stays within Discord's message length limits
- Intended to stay in sync with the current command set as the bot grows

### `/cmibot debug`

Shows the detected channel/plugin context for the current channel.

- Available in configured support and test channels
- Intended as a temporary verification command while channel-based routing is being explored
- Distinguishes between CMI support, CMI test, and Jobs channel mappings when those IDs are configured

### `/cmibot config`

Searches regular config files such as `CMI/config.yml`, `CMI/Settings/**/*.yml`, and `CMILib/config.yml`.

Options:

- `keyword`: required search phrase
- `file`: optional indexed config filename or relative path, such as `Chat.yml`, `config.yml`, or `CMI/Settings/Chat.yml`
- `mode`: optional, `exact`, `whole`, or `broad`
- `limit`: optional number of visible results, up to `15`
- `related`: optional, `true` or `false`
- `summary`: optional, `true` or `false`, limited to configured AI role IDs when OpenAI features are enabled

Examples:

```text
/cmibot help
/cmibot config dynmap
/cmibot config chat file:Chat.yml
/cmibot config tho mode:whole
/cmibot config bluemap limit:5
/cmibot config "mini message" mode:exact
/cmibot config "mini message" mode:whole
/cmibot config "mini message" mode:broad
/cmibot config bluemap related:true
/cmibot config dynmap summary:true
```

### `/cmibot language`

Searches English translation and locale YAML files.

Options:

- `keyword`: required search phrase
- `mode`: optional, `exact`, `whole`, or `broad`
- `limit`: optional number of visible results, up to `15`
- `related`: optional, `true` or `false`
- `summary`: optional, `true` or `false`, limited to configured AI role IDs when OpenAI features are enabled

By default this is scoped to the English locale files, such as `Locale_EN.yml`, English death-message locale files, and English CMILib translation files like `items_EN.yml`.

`/cmibot lang` is a short alias for the same search.

### `/cmibot placeholder`

Searches exported placeholder entries from `data/placeholders.log`.

Options:

- `keyword`: required search phrase, token fragment, or full placeholder token
- `mode`: optional, `exact`, `whole`, or `broad`
- `limit`: optional number of visible results, up to `15`
- `summary`: optional, `true` or `false`, limited to configured AI role IDs when OpenAI features are enabled

This placeholder log is currently enriched with comment descriptions based on the [Zrips CMI placeholders reference](https://www.zrips.net/cmi/placeholders/), so searches can match both the token and its explanation.

Discord output for `placeholder` uses placeholder-focused wording and keeps the code fence highlighted as `yml`.

Examples:

```text
/cmibot placeholder balance
/cmibot placeholder %cmi_user_balance% mode:whole
/cmibot placeholder rank mode:broad
```

### `/cmibot material`

Searches exported material names from `data/materials.log`.

Options:

- `keyword`: required search phrase or material token
- `mode`: optional, `exact`, `whole`, or `broad`
- `limit`: optional number of visible results, up to `25`
- `summary`: optional, `true` or `false`, limited to configured AI role IDs when OpenAI features are enabled

Material lookups use a bigger default window so common grouped searches like `shulker` or `wool` can be shown in one response.

Discord output for `material` is intentionally simplified to read like a single NMS material list instead of an internal file dump.

Examples:

```text
/cmibot material shulker
/cmibot material BLUE_SHULKER_BOX mode:whole
```

### `/cmibot command`

Searches exported CMI command usage entries from `data/commands.log`.

`/cmibot cmd` is a short alias for the same search.

Discord output for `command` uses command-focused wording and omits the redundant pre-code-block lead line.

Options:

- `keyword`: required search phrase, command name, or usage fragment
- `mode`: optional, `exact`, `whole`, or `broad`
- `limit`: optional number of visible results, up to `15`
- `summary`: optional, `true` or `false`, limited to configured AI role IDs when OpenAI features are enabled

Examples:

```text
/cmibot command balance
/cmibot cmd "/cmi baltop" mode:whole
```

### `/cmibot permission`

Searches exported permission data from `data/permissions.log` and `data/cmdperms.log`.

`/cmibot perm` is a short alias for the same search.

Discord output for `permission` uses permission-focused wording instead of exposing the internal log filename.

Options:

- `keyword`: required permission node, command-permission node, or descriptive phrase
- `mode`: optional, `exact`, `whole`, or `broad`
- `limit`: optional number of visible results, up to `15`
- `summary`: optional, `true` or `false`, limited to configured AI role IDs when OpenAI features are enabled

Examples:

```text
/cmibot perm cmi.command.balance
/cmibot permission randomteleport
```

### `/cmibot faq`

Searches curated FAQ entries from `data/faq.log`.

This dataset currently combines:

- The FAQ links you pinned in Discord for CMI support topics
- Short pre-sales Q&A entries based on the [Zrips FAQ](https://www.zrips.net/faq/)

FAQ results use the FAQ title itself as the clickable link, with the supporting notes shown underneath in a code fence and without exposing the internal `data/faq.log` file heading, raw URL line, or keyword metadata in Discord output.

Options:

- `keyword`: required search phrase, FAQ title fragment, or policy term
- `mode`: optional, `exact`, `whole`, or `broad`
- `limit`: optional number of visible results, up to `15`
- `summary`: optional, `true` or `false`, limited to configured AI role IDs when OpenAI features are enabled

Examples:

```text
/cmibot faq refund
/cmibot faq bungeecord
/cmibot faq luckperms prefix
/cmibot faq sqlite mysql
```

### `/cmibot tabcomplete`

Searches exported tab-complete token entries from `data/tabcompletes.log`.

Discord output for `tabcomplete` uses tabcomplete-focused wording instead of exposing the internal log filename.

Options:

- `keyword`: required token or descriptive phrase
- `mode`: optional, `exact`, `whole`, or `broad`
- `limit`: optional number of visible results, up to `15`
- `summary`: optional, `true` or `false`, limited to configured AI role IDs when OpenAI features are enabled

Examples:

```text
/cmibot tabcomplete [playername] mode:whole
/cmibot tabcomplete biome
```

### `/cmibot langstats`

Shows the language-category overview without requiring a lookup keyword.

Use this when you just want to see:

- which English locale files CMIBot is indexing
- which locale categories exist
- how many language variants each category has
- which language codes are available for each category

The output is grouped one category at a time so the file path stays on its own line and the language-code list is easier to scan.

### `/cmibot stats`

Shows the current in-memory cache totals and the per-profile entry/file counts, similar to the startup console summary.

This uses the same descriptive per-profile file labels as startup and `/cmibot reload`, such as `YAML configuration files` and `YAML locale files`.

Use this when you want a quick bot-health snapshot such as:

- total indexed entries
- total indexed files
- per-profile entry counts
- per-profile file counts

### `/cmibot reload`

Rebuilds the in-memory search cache from disk.

- Restricted to the configured admin role ID(s)
- Useful after adding, deleting, renaming, or replacing indexed files
- Also useful after changing comments, keys, values, or placeholder descriptions inside existing files

Example:

```text
/cmibot reload
```

## Cache Behavior

CMIBot does not keep a cache directory on disk. The cache lives in RAM only.

That means:

- Starting the bot creates a fresh cache from the current indexed files on disk
- `/cmibot reload` rebuilds the cache from the current indexed files on disk
- If you add a new indexed file inside an included folder, reload picks it up
- If you delete an indexed file, reload removes it from the cache
- If you replace or edit an existing indexed file, reload picks up the new contents
- Restarting the bot has the same effect as a fresh reload

The source of truth is always the real indexed files in this workspace.

## Security Notes

- Replies suppress Discord mentions so searches cannot ping users or roles
- Query input is normalized and validated before use
- Very broad exact filler words such as `the` can be rejected
- Short exact queries can still be allowlisted, which is useful for things like `rtp`
- AI-backed features are restricted by `AI_ROLE_IDS`
- AI-backed features can be hard-disabled entirely with `OPENAI_ENABLED=false`
- Lookups and AI summaries use per-user cooldowns
- Command activity is written to the audit log path as JSON lines
- User input is never treated as a filesystem path, shell command, or SQL query

## Local Testing

Run a search without Discord:

```bash
npm run lookup -- config dynmap
npm run lookup -- config --file Chat.yml chat
npm run lookup -- config --mode broad "mini message"
npm run lookup -- config --mode whole "mini message"
npm run lookup -- config --mode whole tho
npm run lookup -- config --related bluemap
npm run lookup -- config --summary dynmap
npm run lookup -- language home
npm run lookup -- lang "was fireballed by"
npm run lookup -- placeholder balance
npm run lookup -- placeholder --mode whole %cmi_user_balance%
npm run lookup -- material shulker
npm run lookup -- cmd balance
npm run lookup -- perm cmi.command.balance
npm run lookup -- faq refund
npm run lookup -- tabcomplete "[playername]"
npm run lookup -- langstats
npm run lookup -- stats
```

## Notes

- The bot builds an in-memory search cache at startup.
- When you update, add, or remove indexed YAML or log files, use `/cmibot reload` or restart the bot.
- `/cmibot help` should be kept in sync with new features as the bot evolves.
- Search results can use the default exact search, a stricter whole-word or whole-phrase search, or a broader search, depending on `mode`.
- `config` searches can optionally be narrowed to a specific indexed file with `file:`.
- Search results can include nearby related YAML entries when `related:true` is used.
- `langstats` shows the language-category overview without needing a search keyword.
- `stats` shows the live cache totals and per-profile counts.
- `placeholder` searches the exported placeholder dataset and its description comments.
- `material` searches the exported material list.
- `command` and `cmd` search the exported command usage list.
- `permission` and `perm` search both the standalone permission list and the YAML-like command permission export.
- `faq` searches curated FAQ titles, links, and short policy notes.
- `tabcomplete` searches exported tab-complete tokens and their explanations.
- Search results can include an AI-generated explanation when `summary:true` is used.
- AI-backed features are currently restricted by `AI_ROLE_IDS`.
- If `OPENAI_ENABLED=false`, `summary:true` stays visible as an option but no AI output is generated.
- Security controls such as cooldowns, query validation, and audit logging are configurable through `.env`.
- Search results show the comment block and the matching entry line.
- AI is used only after deterministic candidate retrieval so the bot stays grounded in the actual indexed files.

## Output Example

Example config response:

```text
Found [3] mentions in [1] file for bluemap (config.yml)

In ~/plugins/CMI/config.yml:

Look around line 2036 -> BlueMap
BlueMap:

Look around line 2037 -> BlueMap.Warps
  Warps:

Look around line 2040 -> BlueMap.Warps.Enabled
  # Do you want to show warps in BlueMap?
  # For most settings to take effect you need to restart the server
  Enabled: true

AI summary (generated): These results point to the BlueMap warp section in `CMI/config.yml`, including the parent section and the setting that controls whether warps are shown on BlueMap.

Showing 3 results.
```

Example multi-file header:

```text
Found [25] mentions in [2] files for Icon (Chat.yml / config.yml)
```

Example placeholder response:

````text
Found [2] placeholder mentions for `balance`

Look around line 167 -> %cmi_user_balance_formatted%
```yml
# Formatted users balance
%cmi_user_balance_formatted%
```

Look around line 170 -> %cmi_user_balance%
```yml
# Clean users balance
%cmi_user_balance%
```

Showing 2 results.
````

Example material response:

````text
Found [19] mentions in the NMS material list for `shulker`
```text
BLACK_SHULKER_BOX
BLUE_SHULKER_BOX
BROWN_SHULKER_BOX
CYAN_SHULKER_BOX
GRAY_SHULKER_BOX
GREEN_SHULKER_BOX
LIGHT_BLUE_SHULKER_BOX
LIGHT_GRAY_SHULKER_BOX
LIME_SHULKER_BOX
MAGENTA_SHULKER_BOX
ORANGE_SHULKER_BOX
PINK_SHULKER_BOX
PURPLE_SHULKER_BOX
RED_SHULKER_BOX
SHULKER_BOX
SHULKER_SHELL
SHULKER_SPAWN_EGG
WHITE_SHULKER_BOX
YELLOW_SHULKER_BOX
```

Showing 19 results.
````

Example command response:

````text
Found [2] command mentions for `balance`

```yml
# Check money balance
/cmi balance (playerName)
```

```yml
# Check top money list
/cmi baltop (playerName)
```

Showing 2 results.
````
