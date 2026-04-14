# CMIBot

CMIBot is a Discord slash-command bot for searching CMI and CMILib YAML files by keyword while preserving the comment context that explains each setting.

It is designed for support workflows like:

```text
/cmibot help
/cmibot lookup dynmap
/cmibot lookup cuff
/cmibot lookup bluemap related:true
/cmibot lookup dynmap summary:true
/cmibot lookup "mini message" mode:broad
/cmibot langlookup home
/cmibot reload
```

The bot builds an in-memory cache from the YAML files in this folder. When you add, replace, rename, or remove YAML files later, refresh the cache with `/cmibot reload` or by restarting the bot.

Git note: the live SQLite database at `CMI/cmi.sqlite.db` is runtime data and is intentionally kept out of Git.

## What It Does

- Registers a `/cmibot` slash command with `lookup` and `langlookup` subcommands
- Registers a `/cmibot help` command for channel-local usage guidance
- Registers an admin-only `/cmibot reload` command for rebuilding the in-memory search cache
- Restricts usage to your configured guild, channel, and allowed roles
- Pairs YAML comment blocks with the setting line directly below them
- Uses lexical search first and optionally uses OpenAI to rerank the best candidates
- Groups visible results by file and shows them top-to-bottom inside each file
- Supports `mode: exact|broad` for tighter or looser matching
- Supports `related: true|false` for nearby context entries
- Supports `summary: true|false` for an optional AI-generated explanation, restricted to configured AI role IDs
- Applies per-user cooldowns, query validation, no-mention replies, and audit logging for safer operation
- Adds matched filename hints to the header when results span multiple files
- Separates regular config search from translation search through include/exclude globs

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
- `ALLOWED_ROLE_NAMES`: Optional fallback role names allowed to use lookup commands
- `ALLOWED_ROLE_IDS`: Comma-separated role IDs allowed to use lookup commands
- `ADMIN_ROLE_IDS`: Comma-separated role IDs allowed to use `/cmibot reload`
- `AI_ROLE_IDS`: Comma-separated role IDs allowed to use AI-backed features like reranking and `summary:true`
- `OPENAI_ENABLED`: Hard switch for all OpenAI-backed features
- `OPENAI_API_KEY`: Optional but recommended for AI-assisted reranking
- `OPENAI_MODEL`: Model used for reranking, default `gpt-5-mini`
- `DISPLAY_PATH_PREFIX`: Path prefix shown in results, default `~/plugins`
- `LOOKUP_COOLDOWN_SECONDS`: Per-user cooldown for lookup commands
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
- Allowed channel: `526402563847880725` (`#cmi`)
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

Regular lookup and language lookup are kept separate on purpose.

- `/cmibot lookup <keyword>` searches regular config files
- `/cmibot langlookup <keyword>` searches locale/translation files
- `/cmibot help` shows command usage in the configured channel

You can adjust the file scopes in `.env` without changing code.

## Commands

### `/cmibot help`

Shows the bot's current capabilities in `#cmi`.

- Available to anyone in the configured channel
- If the user is not in an allowed support/admin role, the help output includes a notice that command access is limited
- Intended to stay in sync with the current command set as the bot grows

### `/cmibot lookup`

Searches regular config files such as `CMI/config.yml`, `CMI/Settings/**/*.yml`, and `CMILib/config.yml`.

Options:

- `keyword`: required search phrase
- `mode`: optional, `exact` or `broad`
- `limit`: optional number of visible results
- `related`: optional, `true` or `false`
- `summary`: optional, `true` or `false`, limited to configured AI role IDs when OpenAI features are enabled

Examples:

```text
/cmibot help
/cmibot lookup dynmap
/cmibot lookup bluemap limit:5
/cmibot lookup "mini message" mode:exact
/cmibot lookup "mini message" mode:broad
/cmibot lookup bluemap related:true
/cmibot lookup dynmap summary:true
```

### `/cmibot langlookup`

Searches translation and locale YAML files.

Options:

- `keyword`: required search phrase
- `mode`: optional, `exact` or `broad`
- `limit`: optional number of visible results
- `related`: optional, `true` or `false`
- `summary`: optional, `true` or `false`, limited to configured AI role IDs when OpenAI features are enabled

### `/cmibot reload`

Rebuilds the in-memory YAML cache from disk.

- Restricted to the configured admin role ID(s)
- Useful after adding, deleting, renaming, or replacing YAML files
- Also useful after changing comments, keys, or values inside existing files

Example:

```text
/cmibot reload
```

## Cache Behavior

CMIBot does not keep a cache directory on disk. The cache lives in RAM only.

That means:

- Starting the bot creates a fresh cache from the current files on disk
- `/cmibot reload` rebuilds the cache from the current files on disk
- If you add a new YAML file inside an included folder, reload picks it up
- If you delete a YAML file, reload removes it from the cache
- If you replace or edit an existing YAML file, reload picks up the new contents
- Restarting the bot has the same effect as a fresh reload

The source of truth is always the real YAML files in this workspace.

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
npm run lookup -- lookup dynmap
npm run lookup -- lookup --mode broad "mini message"
npm run lookup -- lookup --related bluemap
npm run lookup -- lookup --summary dynmap
npm run lookup -- langlookup home
```

## Notes

- The bot builds an in-memory search cache at startup.
- When you update, add, or remove YAML files, use `/cmibot reload` or restart the bot.
- `/cmibot help` should be kept in sync with new features as the bot evolves.
- Search results can show a strict default search or a broader search, depending on `mode`.
- Search results can include nearby related entries when `related:true` is used.
- Search results can include an AI-generated explanation when `summary:true` is used.
- AI-backed features are currently restricted by `AI_ROLE_IDS`.
- If `OPENAI_ENABLED=false`, `summary:true` stays visible as an option but no AI output is generated.
- Security controls such as cooldowns, query validation, and audit logging are configurable through `.env`.
- Search results show the comment block and the matching setting line.
- AI is used only after deterministic candidate retrieval so the bot stays grounded in the actual YAML files.

## Output Example

Example lookup response:

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
