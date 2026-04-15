# CMIBot

CMIBot is a Discord support bot built around a channel-aware `/lookup` workflow.

Today it fully supports the CMI context and already includes the first working Jobs context, with the active plugin decided by the Discord channel ID.

## Current Direction

- `/lookup` is now the primary slash command
- Channel ID decides which plugin context is active
- `#test` can be switched live between plugin contexts through the debug command
- `/lookup reload` is global and rebuilds caches for every plugin context
- `/lookup stats` and `/lookup langstats` are context-aware and only show data for the active plugin
- `/lookup debug` shows channel routing plus project size and live memory usage

## Current Contexts

### CMI

The CMI context is fully wired and currently supports:

- `config`
- `language|lang`
- `placeholder`
- `material`
- `command|cmd`
- `permission|perm`
- `faq`
- `tabcomplete`
- `langstats`
- `stats`
- `debug`
- `reload`
- `help`

### Jobs

The Jobs context is now wired for Jobs locale files, Jobs translatable-word files, shared CMILib YAML search, and Jobs log-based support data.

Right now Jobs supports:

- `config`
- `language|lang`
- `placeholder`
- `command|cmd`
- `permission|perm`
- `faq`
- `help`
- `stats`
- `langstats`
- `debug`
- `reload`

These are currently not part of the Jobs scope:

- `material`
- `tabcomplete`

## Example Commands

### CMI examples

```text
/lookup help
/lookup config dynmap
/lookup config chat file:Chat.yml
/lookup config "mini message" mode:whole
/lookup config bluemap related:true
/lookup language home
/lookup lang "was fireballed by"
/lookup placeholder balance
/lookup material shulker
/lookup cmd balance
/lookup perm cmi.command.balance
/lookup faq refund
/lookup tabcomplete [playername] mode:whole
/lookup stats
/lookup langstats
/lookup debug
/lookup reload
```

### Jobs examples

```text
/lookup help
/lookup language points
/lookup placeholder jobsr_user_points
/lookup cmd join
/lookup perm jobs.use
/lookup faq vault
/lookup stats
/lookup langstats
```

### Test-channel context switching

When used in a configured test channel by an admin:

```text
/lookup debug context:cmi
/lookup debug context:jobs
/lookup debug context:auto
```

`auto` clears the manual override and returns the test channel to its default configured context.

## Channel Routing

The bot uses explicit channel IDs from `.env`:

- `DISCORD_ALLOWED_CHANNEL_IDS`: every channel where the bot is allowed to run
- `DISCORD_CMI_CHANNEL_IDS`: channels that should route to the CMI context
- `DISCORD_JOBS_CHANNEL_IDS`: channels that should route to the Jobs context
- `DISCORD_TEST_CHANNEL_IDS`: channels that are allowed to override context live
- `DISCORD_TEST_DEFAULT_CONTEXT`: default context for test channels, currently `cmi`

Current defaults:

- `#cmi`: `526402563847880725`
- `#jobs-reborn`: `526402919826849804`
- `#test`: `1493976695152054353`

If a channel is not in `DISCORD_ALLOWED_CHANNEL_IDS`, the bot refuses to run there.

## What Loads On Startup

On `npm start`, the bot now warms a global cache and prints totals grouped by plugin context, for example:

```text
Loaded 19563 entries from 74 files into the search cache.
CMI:
- config: 4499 entries from 21 YAML configuration files
- language: 4145 entries from 2 YAML locale files
- placeholder: 224 entries from 1 placeholder data file
- material: 1697 entries from 1 material data file
- command: 306 entries from 1 command data file
- permission: 778 entries from 2 permission data files
- faq: 54 entries from 1 FAQ data file
- tabcomplete: 77 entries from 1 tab-complete data file
Jobs:
- config: 347 entries from 1 YAML configuration file
- language: 2655 entries from 2 YAML locale files
- placeholder: 72 entries from 1 placeholder data file
- command: 57 entries from 1 command data file
- permission: 65 entries from 1 permission data file
- faq: 35 entries from 32 FAQ data files
Shared CMILib data:
- config: 36 entries from 1 YAML configuration file
- language: 2240 entries from 2 YAML locale files
```

`/lookup reload` rebuilds this cache globally for every configured plugin context.

For startup and reload summaries, shared `CMILib` config and language data is shown in its own `Shared CMILib data:` section at the bottom so it does not visually look like plugin-owned data inside the CMI or Jobs blocks.

## Search Behavior

### Shared options

- `mode: exact|whole|broad`
- `limit: 1-15` for most commands
- `summary: true|false`

### CMI-specific extras

- `config` supports `file: <name>`
- `config`, `language`, and `lang` support `related: true|false`
- `material` uses `limit: 1-25` and defaults to `25`

### AI summary

AI support is behind two gates:

- `OPENAI_ENABLED=true`
- the user must have one of the configured `AI_ROLE_IDS`

If AI is disabled, `summary:true` is rejected cleanly.

## Security and Abuse Controls

The bot already includes:

- per-user cooldowns
- query length checks
- blocklisted filler-word rejection
- allowlisted short-token exceptions
- disallowed `@` and backtick input rejection
- no-mention Discord replies
- audit logging to `logs/cmibot-usage.jsonl`
- safe `file:` filtering against indexed files only

Because file filtering uses the active plugin context, a Jobs channel cannot search CMI config files and vice versa.

At the moment, Jobs `config` includes:

- `JobsPlugin/generalConfig.yml`
- shared `CMILibPlugin/CMILib/config.yml`

Jobs `language` now includes:

- `JobsPlugin/locale/messages_en.yml`
- `JobsPlugin/TranslatableWords/Words_en.yml`
- shared `CMILibPlugin/CMILib/Translations/**/*_EN.yml`

Jobs `faq` can now load from both:

- `JobsPlugin/data/faq.log`
- `JobsPlugin/data/faq/*.md`

That means new markdown FAQ files dropped into the Jobs FAQ folder are picked up on `/lookup reload` without needing a separate conversion step.

## Environment

Copy `.env.example` to `.env` and fill in the values.

### Discord

- `DISCORD_TOKEN`
- `DISCORD_APPLICATION_ID`
- `DISCORD_GUILD_ID`
- `DISCORD_ALLOWED_CHANNEL_IDS`
- `DISCORD_CMI_CHANNEL_IDS`
- `DISCORD_JOBS_CHANNEL_IDS`
- `DISCORD_TEST_CHANNEL_IDS`
- `DISCORD_TEST_DEFAULT_CONTEXT`
- `ALLOWED_ROLE_IDS`
- `ADMIN_ROLE_IDS`
- `AI_ROLE_IDS`

### OpenAI

- `OPENAI_ENABLED`
- `OPENAI_API_KEY`
- `OPENAI_MODEL`

### Shared bot behavior

- `DISPLAY_PATH_PREFIX`
- `DEFAULT_RESULT_LIMIT`
- `LOOKUP_COOLDOWN_SECONDS`
- `SUMMARY_COOLDOWN_SECONDS`
- `QUERY_MIN_LENGTH`
- `QUERY_MAX_LENGTH`
- `QUERY_BLOCKLIST`
- `QUERY_ALLOWLIST`
- `QUERY_DEBUG_ERRORS`
- `AUDIT_LOG_PATH`

### CMI data scopes

- `LOOKUP_INCLUDE_GLOBS`
- `LOOKUP_EXCLUDE_GLOBS`
- `LANGLOOKUP_INCLUDE_GLOBS`
- `LANGLOOKUP_EXCLUDE_GLOBS`
- `PLACEHOLDER_INCLUDE_GLOBS`
- `PLACEHOLDER_EXCLUDE_GLOBS`
- `MATERIAL_INCLUDE_GLOBS`
- `MATERIAL_EXCLUDE_GLOBS`
- `COMMAND_INCLUDE_GLOBS`
- `COMMAND_EXCLUDE_GLOBS`
- `PERMISSION_INCLUDE_GLOBS`
- `PERMISSION_EXCLUDE_GLOBS`
- `FAQ_INCLUDE_GLOBS`
- `FAQ_EXCLUDE_GLOBS`
- `TABCOMPLETE_INCLUDE_GLOBS`
- `TABCOMPLETE_EXCLUDE_GLOBS`

### Jobs data scopes

These are the current Jobs search scopes:

- `JOBS_LOOKUP_INCLUDE_GLOBS`
- `JOBS_LOOKUP_EXCLUDE_GLOBS`
- `JOBS_LANGUAGE_INCLUDE_GLOBS`
- `JOBS_LANGUAGE_EXCLUDE_GLOBS`
- `JOBS_PLACEHOLDER_INCLUDE_GLOBS`
- `JOBS_PLACEHOLDER_EXCLUDE_GLOBS`
- `JOBS_COMMAND_INCLUDE_GLOBS`
- `JOBS_COMMAND_EXCLUDE_GLOBS`
- `JOBS_PERMISSION_INCLUDE_GLOBS`
- `JOBS_PERMISSION_EXCLUDE_GLOBS`
- `JOBS_FAQ_INCLUDE_GLOBS`
- `JOBS_FAQ_EXCLUDE_GLOBS`

## Current Data Layout

Right now the live CMI data remains where it already works:

```text
CMIPlugin/CMI/
CMIPlugin/data/
CMILibPlugin/CMILib/
JobsPlugin/data/
src/
```

This refactor now supports the plugin-folder layout you created, while still keeping the data-loading rules driven by env globs.

That means:

- CMI behavior stays stable
- Jobs can be added incrementally
- new plugin contexts can follow the same folder-and-glob pattern later

## Local CLI

The local CLI now understands plugin context too:

```bash
node src/cli.js cmi stats
node src/cli.js jobs stats
node src/cli.js cmi config --file Chat.yml dynmap
```

If no plugin is provided, it defaults to `cmi`.

## Install and Run

```bash
npm install
npm start
```

## Git Notes

- `.env` is ignored
- `.env.example` is tracked
- `logs/` is ignored
- `CMIPlugin/CMI/cmi.sqlite.db` is ignored as runtime data

## Next Planned Steps

- add real Jobs YAML config data when you are ready to index more than the shared CMILib files
- extend the multi-plugin structure to more support channels like Residence, TradeMe, or TryMe
