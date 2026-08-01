# LookupBot

LookupBot is a channel-aware Discord support bot for Zrips plugins. The same `/lookup` command automatically searches the plugin assigned to the current Discord channel, so CMI questions stay inside the CMI data set, Jobs questions stay inside Jobs, and file filters cannot cross plugin boundaries.

The repository is still named `CMIBot`, but `/lookup` is the only registered slash command.

## Current Features

- Channel-ID-based plugin routing
- Exact, whole-word, and broad searches
- Safe indexed-file filtering for config searches
- English locale searches with shared CMILib data
- Curated command, permission, placeholder, FAQ, material, and tab-complete indexes where available
- Automatic runtime extraction of commands, permissions, and placeholders from initialized plugin jars
- In-memory caches with global admin-only reloads
- Clean first-install plugin data generated from a disposable Paper server
- Local version inventory plus scheduled Paper and Spigot resource checks
- Paper 26.2 stable/API drift checks plus Java 25 and Java 26 smoke commands
- Per-user cooldowns, input validation, disabled mentions, role-ID access checks, and JSONL audit logs
- Context-aware help, stats, language stats, latest versions, and debug output

## Plugin Contexts

| Context | Search features |
| --- | --- |
| CMI | config, language, placeholder, material, command, permission, FAQ, tab-complete |
| Jobs | config, language, placeholder, command, permission, FAQ |
| Residence | config, language, placeholder, command, permission |
| SelectionVisualizer (SVIS) | config, language, command, permission |
| MobFarmManager (MFM) | config, language, generated command, generated permission |
| TryMe | config, language, generated placeholder, generated command, generated permission |
| TradeMe | config, language, generated placeholder, generated command, generated permission |
| BottledExp | config, language, generated command, generated permission |

All contexts also support `help`, `stats`, `langstats`, `latest`, `debug`, and the global admin-only `reload` command. Unsupported search features are hidden from the context-specific available list and are reported clearly if called directly.

CMILib config and English locale files are shared with every plugin context.

## Commands

```text
/lookup help
/lookup config <keyword>
/lookup language <keyword>
/lookup lang <keyword>
/lookup placeholder <keyword>
/lookup material <keyword>
/lookup command <keyword>
/lookup cmd <keyword>
/lookup permission <keyword>
/lookup perm <keyword>
/lookup faq <keyword>
/lookup tabcomplete <keyword>
/lookup langstats
/lookup stats
/lookup latest
/lookup latest public:true
/lookup latest scope:all
/lookup debug
/lookup reload
```

`language|lang`, `command|cmd`, and `permission|perm` are equivalent long and short forms.

### Search Options

- `mode:exact` is the default case-insensitive phrase search.
- `mode:whole` matches complete words or phrases, so `tho` does not match `thousand`.
- `mode:broad` matches all meaningful query terms when they are not adjacent.
- `limit:1-15` controls most result lists and defaults to `DEFAULT_RESULT_LIMIT`.
- CMI `material` supports up to 25 results and defaults to 25.
- `file:<name>` restricts config results to a valid indexed file in the active context.
- `related:true` adds nearby YAML entries to config and language results.
- `summary:true` requests an AI summary only when OpenAI support and the configured AI role are enabled.

### Examples

```text
/lookup config dynmap
/lookup config chat file:Chat.yml
/lookup config coal file:miner.yml
/lookup config "mini message" mode:whole
/lookup language "was fireballed by"
/lookup placeholder balance
/lookup material shulker
/lookup cmd balance
/lookup perm cmi.command.balance
/lookup faq refund
/lookup cmd bottle
/lookup perm bottledexp.command.consume
/lookup latest
/lookup latest public:true
/lookup latest scope:all
```

## Channel Routing

Only IDs listed in `DISCORD_ALLOWED_CHANNEL_IDS` can use the bot. The active plugin is then selected from these explicit mappings:

- `DISCORD_CMI_CHANNEL_IDS`
- `DISCORD_JOBS_CHANNEL_IDS`
- `DISCORD_SVIS_CHANNEL_IDS`
- `DISCORD_MFM_CHANNEL_IDS`
- `DISCORD_TRYME_CHANNEL_IDS`
- `DISCORD_TRADEME_CHANNEL_IDS`
- `DISCORD_RESIDENCE_CHANNEL_IDS`
- `DISCORD_BOTTLEDEXP_CHANNEL_IDS`

Current default routes are documented in `.env.example`. BottledExp has no production channel assigned yet, so its channel list is empty by default.

Configured test channels can switch context without restarting the bot:

```text
/lookup debug context:cmi
/lookup debug context:jobs
/lookup debug context:bottledexp
/lookup debug context:auto
```

Only an admin role can change the test-channel override. `auto` returns the test channel to `DISCORD_TEST_DEFAULT_CONTEXT`.

## Clean Reference Data

The bot's YAML data is generated from a clean first-install Paper server instead of copied from a customized live server.

### Server Layout

```text
servers/
|- _template-Paper-26.2/
|  `- companions/
`- Paper-26.2/
   `- companions/
```

`servers/` is ignored by Git. Never start or modify `_template-Paper-26.2` directly. It is a reusable source containing Paper, its cache/libraries, and the plugin jars. Non-Paper companion artifacts belong in the template's `companions/` directory, which the refresh copies into the disposable server without loading those jars as plugins.

The maintained template uses PaperScript's `STABLE` channel, same-version build upgrades, and the fixed `Paper-{version}.jar` filename. Its broad process-name fallback is disabled because another project can legitimately run a jar with the same name; exact test-port detection remains enabled.

Run the complete refresh with:

```bash
npm run refresh:data
```

The refresh script performs these steps:

1. Moves the existing `servers/Paper-26.2` to a temporary backup.
2. Clones `_template-Paper-26.2` into a new disposable working server, including its non-loaded `companions/` inventory.
3. Removes generated plugin, world, log, and Paper config state from the clone only.
4. Runs Paperclip's documented patch-only mode in the clone so the exact stable Paper API and runtime libraries are present without starting the template.
5. Builds `LookupRuntimeExporter` with JDK 25 against the API coordinate in `runtime-exporter/compatibility.json`, verifies Java 25 class bytecode, and places the jar in the disposable clone only.
6. Starts Paper with a 2 GB ceiling and waits for the server's `Done` state.
7. Runs the exporter after every plugin is initialized, waits for its explicit completion marker, then sends a clean `stop` and requires a successful shutdown.
8. Verifies every core config and English locale exists, then synchronizes generated Zrips config, locale, text, JSON, and image files into the plugin directories.
9. Regenerates supplemental command, permission, and placeholder indexes from runtime metadata, with each jar's `plugin.yml` as a fallback for root commands and declared permissions.
10. Writes `data/versions.json` from Paper state and every jar's `plugin.yml` metadata. The internal exporter is excluded from this catalog.
11. Removes the temporary backup only after the entire refresh succeeds.

Before synchronization, the workflow also backs up every managed repository plugin tree and `data/versions.json`. If startup, synchronization, index generation, or version generation fails, both the previous working server and repository lookup data are restored automatically; the failed clone is retained under `servers/Paper-26.2.failed-*` for diagnosis.

Runtime databases, logs, backups, `.DS_Store`, and `security.key` are never synchronized. Curated files under each plugin's `data/` directory are preserved, including FAQ, detailed command, permission, placeholder, material, and tab-complete indexes. Only `generated-commands.log`, `generated-permissions.log`, and `generated-placeholders.log` are rebuilt automatically.

Curated entries always win when a generated key describes the same command, permission, or placeholder. Generated entries fill missing coverage, while variable spellings such as `$1` and `[playerName]` are normalized for deduplication. This keeps hand-written descriptions and examples intact without losing newly added upstream entries.

To regenerate the repository index files from the most recent runtime export and current `plugin.yml` files without starting Paper again:

```bash
npm run refresh:indexes
```

The runtime exporter can inspect initialized command classes, permission enums, and placeholder enums that are not declared in `plugin.yml`. Its reflection is intentionally isolated to third-party plugin metadata whose public APIs do not expose a complete enumerable index; it does not use Paper NMS or CraftBukkit internals. Values created only for a particular online player, external expansion, or live server state may still be impossible to enumerate. `plugin.yml` remains the fallback, and curated indexes remain authoritative.

The exporter source lives under `runtime-exporter/`. Its compiled jar and raw TSV output stay inside ignored `servers/` paths; neither is deployed with LookupBot. You can compile it independently with:

```bash
npm run build:exporter
```

Use this lighter command to rebuild only `data/versions.json` from an already generated server:

```bash
npm run refresh:versions
```

## Generated Data Layout

```text
BottledExpPlugin/
CMIPlugin/CMI/
CMIPlugin/data/
CMILibPlugin/CMILib/
CMILibPlugin/data/
JobsPlugin/
JobsPlugin/data/
MFMPlugin/
MFMPlugin/data/
ResidencePlugin/
ResidencePlugin/data/
SVISPlugin/
SVISPlugin/data/
TradeMePlugin/
TradeMePlugin/data/
TryMePlugin/
TryMePlugin/data/
data/versions.json
runtime-exporter/
|- compatibility.json
scripts/
src/
```

Generated files outside `data/` are replaced on each clean refresh so removed or renamed upstream settings disappear from the bot too. Curated files belong in a plugin's `data/` directory so the refresh preserves them. The clearly named `generated-*.log` files are the only generated exception inside those directories.

## Version Checks

`/lookup latest` privately shows the clean snapshot version for the active plugin, CMILib, and Paper. `/lookup latest public:true` posts a compact public response containing only the latest upstream versions for the active plugin and CMILib, followed by an upgrade recommendation. It never includes the local clean snapshot, Paper, internal generation timestamps, or other tracked resources.

`/lookup latest scope:all` privately lists every jar in the clean reference server, support dependencies such as LuckPerms and PlaceholderAPI, and the tracked CMI companion resources. Public output is intentionally limited to the current channel context, so `scope:all public:true` is rejected privately.

The all-resources response is grouped for readability: the first private message lists the main Zrips plugins, and the second lists CMI companion resources followed by Paper and other third-party resources.

The CMI companion section always tracks CMI-API, CMI-Bungee, CMI-Velocity, CMI-Vault, and CMI-E-Injector through their official GitHub or Zrips sources. Their local jars are stored in the ignored `servers/_template-Paper-26.2/companions/` directory and copied to `servers/Paper-26.2/companions/` during a refresh. They are inventoried for version comparisons but are never placed in Paper's `plugins/` directory or started by the clean server.

Tracked Spigot resource versions are checked through the public Spiget API, Paper builds through Paper's official Fill API, LuckPerms through its official metadata service, and PlaceholderAPI through its latest successful Jenkins artifact. CMI companion downloads use their Zrips listings, while CMI-API uses its GitHub project version. PlaceholderAPI output includes both its plugin version and Jenkins build number. A failed or disabled network check never prevents the bot from starting; the command continues to show the local inventory.

Version controls:

- `VERSION_CATALOG_PATH=data/versions.json`
- `VERSION_CHECK_ENABLED=true`
- `VERSION_CHECK_INTERVAL_HOURS=12`
- `VERSION_CHECK_TIMEOUT_SECONDS=8`
- `PAPER_VERSION=26.2`
- `PAPER_VERSION_CHANNELS=STABLE`

The scheduled timer is in memory and starts with the bot. Restarting the bot resets the timer; no separate cron job is required.

### Paper Compatibility

`runtime-exporter/compatibility.json` is the source of truth for the internal Paper tooling. It currently pins Paper `26.2` build `84` on `STABLE`, API `26.2.build.84-stable`, exporter `1.0.1`, and Java target `25`.

Verify the tracked metadata, PaperScript source/config, installed jar checksum, exact API jar, JDKs, and the live latest-stable build:

```bash
npm run check:paper
```

Run maintained-server startup, plugin-list, exporter-enable, and clean-shutdown checks:

```bash
npm run smoke:java25
npm run smoke:java26
```

The scripts use the exact JDK paths from the compatibility manifest by default. `JAVA_HOME` or `JAVA_25_HOME`/`JAVA_26_HOME` can select another matching JDK installation; `JAVA_BIN`, `JAVAC_BIN`, and `JAR_BIN` can override individual tools. Feature mismatches fail before build or startup, and the exporter remains Java 25 bytecode even when tested on Java 26.

`npm run check` performs syntax plus offline compatibility drift validation. `npm run check:paper` additionally contacts Paper's official Fill API and fails if the pinned build is no longer the latest stable 26.2 build.

## Cache Behavior

All indexed YAML plus curated and jar-generated log data is loaded into RAM during startup. `/lookup reload` globally rebuilds every plugin cache, reloads the version catalog, and refreshes upstream version checks.

Use reload after adding, replacing, renaming, or removing indexed files:

```text
/lookup reload
```

The command is restricted to `ADMIN_ROLE_IDS`. Regular searches continue to use the old in-memory snapshot until reload or restart completes.

Reload reports are private. If the global per-plugin breakdown exceeds one Discord message, the bot continues it in additional ephemeral follow-ups instead of trimming contexts from the end.

`/lookup stats` reports only the current plugin context. Startup and `/lookup reload` report every context, followed by a separate `Shared CMILib data` section.

## Debug Output

`/lookup debug` is ephemeral and reports:

- active plugin and channel route
- tracked contexts and supported commands
- context/global cache totals and largest bucket
- cache and version-check timestamps
- clean version-catalog plugin count
- Paper build, stable API coordinate, and exporter Java target
- Node and discord.js versions
- process uptime, RSS, and heap usage
- project and per-plugin disk footprints
- active test-channel overrides

## Security

- Access is matched by immutable Discord role IDs, never role names.
- Reload and test-context changes are admin-only.
- AI features use their own role-ID list and hard enable switch.
- Queries have configurable length, filler-word, and character validation.
- Short valid terms such as `rt`, `rtp`, `tp`, and placeholders can be allowlisted.
- Discord mentions are disabled on all bot responses.
- `file:` only resolves against files already indexed in the active plugin profile.
- Per-user cooldowns limit lookup and AI-summary abuse.
- Usage is written as JSON lines to `logs/cmibot-usage.jsonl`.

## Install

Requirements:

- Node.js 20 or newer
- JDK 25.0.4 at `/Library/Java/JavaVirtualMachines/jdk-25.0.4.jdk/Contents/Home` for Paper and Java 25 exporter bytecode
- JDK 26.0.2 at `/Library/Java/JavaVirtualMachines/jdk-26.0.2.jdk/Contents/Home` for the optional forward-runtime smoke test
- `unzip` for reading plugin metadata from jars

Install and start:

```bash
npm install
cp .env.example .env
npm start
```

Fill in the Discord token, application ID, guild ID, channel IDs, and role IDs in `.env`. The real `.env` is ignored and must be created independently on each machine.

OpenAI support is optional and disabled by default with `OPENAI_ENABLED=false`.

## Local CLI

The CLI defaults to CMI, or accepts a plugin context first:

```bash
npm run lookup -- cmi stats
npm run lookup -- jobs config --file generalConfig.yml income
npm run lookup -- tryme config reward
npm run lookup -- bottledexp language experience
npm run lookup -- cmi latest
npm run lookup -- cmi latest all
```

## Verification

```bash
npm run check
npm run build:exporter
VERSION_CHECK_ENABLED=false npm run lookup -- cmi stats
VERSION_CHECK_ENABLED=false npm run lookup -- jobs stats
VERSION_CHECK_ENABLED=false npm run lookup -- bottledexp stats
```

## Git Safety

- `.env`, `logs/`, `node_modules/`, databases, keys, macOS metadata, and the entire `servers/` tree are ignored.
- `.env.example`, generated clean plugin files, curated and jar-generated `data/` files, refresh scripts, and `data/versions.json` are tracked.
- Always inspect `git status --ignored --short` before the first push from a new machine.
