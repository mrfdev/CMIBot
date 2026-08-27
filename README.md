# LookupBot

LookupBot is a channel-aware Discord support bot for Zrips plugins. The same `/lookup` command automatically searches the plugin assigned to the current Discord channel, so CMI questions stay inside the CMI data set, Jobs questions stay inside Jobs, and file filters cannot cross plugin boundaries.

The repository is still named `CMIBot`, but `/lookup` is the only registered slash command.

## Current Features

- Channel-ID-based plugin routing
- Exact, whole-word, and broad searches
- Configurable plugin-scoped aliases and synonym expansion
- Safe indexed-file filtering for config searches
- English locale searches with shared CMILib data
- Curated command, permission, placeholder, FAQ, material, and tab-complete indexes where available
- Automatic runtime extraction of commands, permissions, and placeholders from initialized plugin jars
- In-memory caches with transactional full, plugin, and profile reloads
- Clean first-install plugin data generated from a disposable Paper server
- Local version inventory plus scheduled Paper and Spigot resource checks
- Paper 26.2 stable/API drift checks plus Java 25 and Java 26 smoke commands
- One canonical CMILib cache composed into every supporting plugin context
- Fail-closed startup validation for configuration, routes, indexes, cache summaries, and version-catalog drift
- Layered user/channel/global rate limits, input validation, disabled mentions, role-ID access checks, JSONL audit logs, and bounded privacy-aware structured service logs
- Privacy-safe aggregate metrics for commands, searches, reloads, AI usage, upstream checks, errors, and memory
- Generated environment schema, blank-safe examples, and plugin-profile documentation
- Context-aware help, stats, language stats, latest versions, health, and debug output

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

All contexts also support `help`, `stats`, `langstats`, and `latest`. The global `health`, `debug`, and `reload` commands are admin-only. Unsupported search features are hidden from the context-specific available list and are reported clearly if called directly.

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
/lookup health                # admin only
/lookup debug                 # admin only
/lookup reload                # full reload by default, admin only
/lookup reload plugin:current
/lookup reload plugin:cmi profile:config
```

`language|lang`, `command|cmd`, and `permission|perm` are equivalent long and short forms.

### Search Options

- `mode:exact` is the default case-insensitive phrase search.
- `mode:whole` matches complete words or phrases, so `tho` does not match `thousand`.
- `mode:broad` matches all meaningful query terms when they are not adjacent.
- `limit:1-15` controls most result lists and defaults to `DEFAULT_RESULT_LIMIT`.
- CMI `material` supports up to 25 results and defaults to 25.
- `file:<name>` restricts config results to a valid indexed file in the active context.
- Source filenames and repository paths are metadata, not searchable content. Use `file:` when you intentionally want to restrict a config lookup to an indexed file.
- Found totals and file counts are calculated before the display limit is applied.
- `related:true` adds nearby YAML entries to config and language results.
- `summary:true` requests an AI summary only when OpenAI support and the configured AI role are enabled.
- Configured aliases are expanded automatically only inside the active plugin context. Direct matches for the original term remain first.

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

### Search Synonyms

Plugin-specific aliases live in `data/search-synonyms.json`, or another safe project-relative JSON file selected with `SEARCH_SYNONYMS_PATH`. For example, CMI `tp` can retain direct `/cmi tp` matches while also finding entries about `teleport` and `teleportation`. The same alias has no effect in another plugin context unless that plugin defines it independently.

Each alias maps to one or more trusted expansion terms:

```json
{
  "schemaVersion": 1,
  "plugins": {
    "cmi": {
      "tp": ["teleport", "teleportation"]
    }
  }
}
```

The file is validated at startup. Unknown plugin contexts, malformed JSON, duplicate normalized aliases, self-expansion, unsafe characters, traversal, symlinks, and excessive alias or expansion counts fail closed. Query expansion is bounded and never recursively expands generated terms. Configuration changes take effect after the next verified deployment or restart.

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

Route values belong only in the ignored `.env` file. The generated `.env.example` documents every route variable but deliberately leaves Discord IDs blank.

Configured test channels can switch context without restarting the bot:

```text
/lookup debug context:cmi
/lookup debug context:jobs
/lookup debug context:bottledexp
/lookup debug context:auto
```

Only an admin role can use `/lookup debug` or change the test-channel override. `auto` returns the test channel to `DISCORD_TEST_DEFAULT_CONTEXT`.

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

For a plugin update, preserve or remove the superseded jar so `plugins/` contains exactly one active jar for that plugin, copy the verified replacement into `_template-Paper-26.2/plugins/`, and run `npm run refresh:data`. Download Residence releases from the official free listing at `https://zrips.net/Residence/`; a premium Spigot download is not required. Preserve superseded jars under the ignored `servers/plugin-archive/` tree when needed; that directory is outside the template, so archived jars are neither copied into the disposable server nor loaded by Paper.

`data/versions.json` is the authoritative record of the clean snapshot versions. It is regenerated from verified jar metadata during every successful refresh, so plugin versions are intentionally not hardcoded in this README.

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
`- discord/
```

Generated files outside `data/` are replaced on each clean refresh so removed or renamed upstream settings disappear from the bot too. Curated files belong in a plugin's `data/` directory so the refresh preserves them. The clearly named `generated-*.log` files are the only generated exception inside those directories.

## Source Layout

Discord responsibilities are separated under `src/discord/`: command schema and registration, shared command constants, channel context and role checks, diagnostics, help output, result formatting, and interaction safety. `src/discordBot.js` owns the interaction pipeline and keeps compatibility re-exports for existing callers. Search, cache, config, indexing, security, audit logging, AI loading, and version checks remain independent top-level services in `src/`.

Keep new Discord presentation or routing behavior in the matching focused module instead of growing the central interaction handler. `npm run check` syntax-checks both top-level source files and every `src/discord/*.js` module before running the tests.

## Version Checks

`/lookup latest` privately shows the clean snapshot version for the active plugin, CMILib, and Paper. `/lookup latest public:true` posts a compact public response containing only the latest upstream versions for the active plugin and CMILib, followed by an upgrade recommendation. It never includes the local clean snapshot, Paper, internal generation timestamps, or other tracked resources.

`/lookup latest scope:all` privately lists every jar in the clean reference server, support dependencies such as LuckPerms and PlaceholderAPI, and the tracked CMI companion resources. Public output is intentionally limited to the current channel context, so `scope:all public:true` is rejected privately.

The all-resources response is grouped for readability: the first private message lists the main Zrips plugins, and the second lists CMI companion resources followed by Paper and other third-party resources.

The CMI companion section always tracks CMI-API, CMI-Bungee, CMI-Velocity, CMI-Vault, and CMI-E-Injector through their official GitHub or Zrips sources. Their local jars are stored in the ignored `servers/_template-Paper-26.2/companions/` directory and copied to `servers/Paper-26.2/companions/` during a refresh. They are inventoried for version comparisons but are never placed in Paper's `plugins/` directory or started by the clean server.

Most tracked Spigot resource versions are checked through the public Spiget API. Residence is checked directly through its official free Zrips listing at `https://zrips.net/Residence/`, Paper builds through Paper's official Fill API, LuckPerms through its official metadata service, and PlaceholderAPI through its latest successful Jenkins artifact. Spiget and Zrips listing requests use a unique cache key because their cached pages can otherwise lag behind a plugin release. CMI companion downloads use their Zrips listings, while CMI-API uses its GitHub project version. PlaceholderAPI output includes both its plugin version and Jenkins build number. A failed or disabled network check never prevents the bot from starting; the command continues to show the local inventory.

Upstream refreshes are resilient per resource. After a resource has checked successfully, a temporary timeout or provider failure retains that last-known version while unrelated successful checks still update normally. The sanitized last-known state is atomically persisted to the ignored `VERSION_STATE_PATH`, so fallback survives bot and machine restarts. Retained values are clearly marked as last known in private and public version output, and recover automatically after the provider succeeds again. A resource with no successful check yet remains unavailable rather than inventing a version.

Version controls:

- `VERSION_CATALOG_PATH=data/versions.json`
- `VERSION_STATE_PATH=logs/upstream-versions.json`
- `VERSION_CHECK_ENABLED=true`
- `VERSION_CHECK_INTERVAL_HOURS=12`
- `VERSION_CHECK_TIMEOUT_SECONDS=8`
- `PAPER_VERSION=26.2`
- `PAPER_VERSION_CHANNELS=STABLE`

The scheduled timer is in memory and starts with the bot. Restarting the bot resets the timer; no separate cron job is required.

### Paper Compatibility

`runtime-exporter/compatibility.json` is the source of truth for the internal Paper tooling. It currently pins Paper `26.2` build `112` on `STABLE`, API `26.2.build.112-stable`, exporter `1.0.1`, and Java target `25`.

Verify the tracked metadata, PaperScript source/config, installed jar checksum, exact API jar, JDKs, and the live latest-stable build:

```bash
npm run check:paper
```

Run maintained-server startup, plugin-list, exporter-enable, and clean-shutdown checks:

```bash
npm run smoke:java25
npm run smoke:java26
```

The scripts prefer the JDK home paths from the compatibility manifest. If a patch-specific directory disappears after a JDK update, macOS falls back to `/usr/libexec/java_home -v <feature>` and uses the installed JDK from that feature line. `JAVA_HOME` or `JAVA_25_HOME`/`JAVA_26_HOME` can select another matching JDK installation; `JAVA_BIN`, `JAVAC_BIN`, and `JAR_BIN` can override individual tools. Feature mismatches fail before build or startup, and the exporter remains Java 25 bytecode even when tested on Java 26.

`npm run check` performs syntax plus offline compatibility drift validation. `npm run check:paper` additionally contacts Paper's official Fill API and fails if the pinned build is no longer the latest stable 26.2 build.

## Cache Behavior

All indexed YAML plus curated and jar-generated log data is loaded into RAM during startup. `/lookup reload` without options globally rebuilds every plugin cache, reloads the version catalog, and refreshes upstream version checks. `plugin:` narrows the cache reload to one context, and `profile:` narrows it to one profile. A profile without `plugin:` uses the current channel context. Selective reloads intentionally leave version data and unrelated cache snapshots unchanged.

CMILib is cached once through the `CMILIB_*_INCLUDE_GLOBS` profiles. Plugin contexts retain only their own entries, then compose the matching shared CMILib config, language, and placeholder entries into searches at read time. This preserves the same `/lookup` results and per-context stats without retaining another copy of every CMILib entry for every Zrips plugin.

The startup, reload, and debug global totals describe entries actually retained in RAM: local plugin entries plus one CMILib copy. Per-context `/lookup stats` totals continue to describe everything searchable in that channel, including shared CMILib data. Legacy plugin include globs that still mention `CMILibPlugin/**` are excluded from local caches defensively.

Reload is transactional. The next search cache and version snapshot are prepared separately from live state while lookups continue using the previous snapshots. Both are committed together only after every profile and the version catalog finish successfully; otherwise the prepared data is discarded and the complete previous state remains active.

Startup is also fail closed. Duplicate channel routes, path traversal in configured globs or state paths, unsupported loaders or version sources, missing required index data, malformed or duplicate index entries, incomplete cache summaries, and mismatched version-catalog contexts stop the process before Discord login. Known optional data sources must be marked explicitly rather than becoming silently empty.

Use reload after adding, replacing, renaming, or removing indexed files:

```text
/lookup reload
/lookup reload plugin:current
/lookup reload profile:language
```

The command is restricted to `ADMIN_ROLE_IDS`. Regular searches continue to use the old in-memory snapshot until reload or restart completes.

Reload reports are private. If the global per-plugin breakdown exceeds one Discord message, the bot continues it in additional ephemeral follow-ups instead of trimming contexts from the end.

`/lookup stats` reports only the current plugin context. Startup and a full `/lookup reload` report every context, followed by a separate `Shared CMILib data` section. Selective reloads report only the requested plugin or profile.

## Health Output

`/lookup health` is admin-only and ephemeral. It reports the release, uptime, Discord readiness, cache readiness and freshness, clean-data generation time, upstream version-check state, startup-validation state, bounded command/search/reload/AI aggregates, process memory, and service-log protection state. It intentionally omits query text, channel and role IDs, routes, hostnames, usernames, and filesystem paths.

## Debug Output

`/lookup debug` is admin-only, ephemeral, and reports:

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
- Health, debug, reload, and test-context changes are admin-only.
- When enabled, AI features use their own role-ID list and hard enable switch; disabled installations do not require AI credentials or roles.
- Queries have configurable length, filler-word, and character validation.
- Short valid terms such as `rt`, `rtp`, `tp`, and placeholders can be allowlisted.
- Discord mentions are disabled on all bot responses.
- `file:` only resolves against files already indexed in the active plugin profile.
- A sliding-window limit follows each user across every subcommand, so switching commands cannot bypass throttling.
- Authorized support commands also share per-channel and process-wide windows to contain coordinated bursts.
- Lookup and AI-summary operations retain separate per-user cooldowns; lookup throttling runs before cache filtering.
- Debug has a global cooldown, while reload has both a global cooldown and a single-flight guard.
- Rate-limit state is memory-bounded and expired buckets are pruned automatically.
- Repeated rate-limit audit events are coalesced to prevent JSONL log flooding.
- Usage is written as JSON lines to `logs/cmibot-usage.jsonl`. Before the active log would exceed `AUDIT_LOG_MAX_SIZE_MB`, it rotates to numbered archives and retains at most `AUDIT_LOG_MAX_FILES` archives.
- Service output is one JSON object per line. Discord commands receive random request IDs, completion records include elapsed milliseconds, and service error serialization omits stacks, sensitive fields, absolute paths, common credential forms, and Discord snowflakes.
- Info and error service streams rotate independently before `SERVICE_LOG_MAX_SIZE_MB`, retain at most `SERVICE_LOG_MAX_FILES` archives each, and prune only their own archives when the `SERVICE_LOG_MIN_FREE_MB` reserve is threatened. If the reserve remains low, new service records are dropped instead of consuming it.
- Metrics use fixed low-cardinality buckets and counters. They never retain query terms, user/channel IDs, file paths, host data, or dynamic labels.
- `.env.example`, the JSON schema, and configuration/profile references are generated only from static metadata. The generator never reads `.env` or process environment values, and all secret and Discord-ID fields remain blank.
- Every interaction runs behind a top-level rejection boundary. Unexpected command and fallback-response errors are logged without terminating the bot.
- Discord client and shard errors have explicit listeners so an emitted runtime error cannot become an unhandled `error` event.

The abuse-control defaults are configurable. Set a limit or its window to `0` to disable that layer:

```dotenv
COMMAND_USER_RATE_LIMIT=10
COMMAND_CHANNEL_RATE_LIMIT=30
COMMAND_GLOBAL_RATE_LIMIT=100
COMMAND_RATE_WINDOW_SECONDS=30
LOOKUP_COOLDOWN_SECONDS=3
SUMMARY_COOLDOWN_SECONDS=15
DEBUG_COOLDOWN_SECONDS=10
RELOAD_COOLDOWN_SECONDS=30
RATE_LIMIT_AUDIT_COOLDOWN_SECONDS=30
AUDIT_LOG_PATH=logs/cmibot-usage.jsonl
AUDIT_LOG_MAX_SIZE_MB=10
AUDIT_LOG_MAX_FILES=5
SERVICE_LOG_MAX_SIZE_MB=10
SERVICE_LOG_MAX_FILES=5
SERVICE_LOG_MIN_FREE_MB=256
METRICS_LOG_INTERVAL_MINUTES=5
```

## Generated Configuration Reference

`src/configMetadata.js` is the canonical documentation metadata for bot environment variables and plugin profiles. Regenerate the blank-safe example, JSON schema, and Markdown references after changing configuration:

```bash
npm run docs:generate
npm run docs:check
```

Generated references are committed under `docs/generated/`. `npm run check:bot` fails when they drift from the metadata. Runtime configuration validation remains authoritative for operational behavior.

## Install

Requirements:

- Node.js 22 or newer
- Java 25 for Paper and Java 25 exporter bytecode
- Java 26 for the optional forward-runtime smoke test
- `unzip` for reading plugin metadata from jars

Install and start:

```bash
npm ci
cp .env.example .env
npm start
```

`npm ci` installs the exact dependency versions recorded in `package-lock.json`, which is the recommended path for the live bot and fresh clones. Use `npm install` only when intentionally updating dependencies locally.

Fill in the Discord token, application ID, guild ID, channel IDs, and role IDs in `.env`. The real `.env` is ignored and must be created independently on each machine.

OpenAI support is optional and disabled by default with `OPENAI_ENABLED=false`. In disabled mode, the bot stays lexical-only: it does not import the OpenAI SDK, construct an API client, or require `AI_ROLE_IDS`/`OPENAI_API_KEY`. This avoids the SDK's runtime memory overhead until AI is explicitly enabled.

## Managed macOS Service

The production host can run LookupBot as the per-user LaunchAgent `com.mrfdev.cmibot`. The tracked `operations/com.mrfdev.cmibot.plist` is a sanitized template with no username, home path, executable path, Discord ID, or credential. `./scripts/install` renders an owner-readable host-local definition from the current project and Node executable. Installing or loading it is an explicit host-administration step and is never performed by `npm ci`.

Operator commands:

```bash
./scripts/install
./scripts/status
./scripts/start
./scripts/stop
./scripts/restart
./scripts/logs --lines 100
./scripts/logs --follow
```

`status` exits `0` when launchd reports a running process and `3` when the job is stopped or waiting. `start` bootstraps an unloaded job or kickstarts a loaded-but-waiting job. `stop` uses `launchctl bootout`, which gives the Node process time to handle `SIGTERM`; `restart` safely refreshes the installed definition, then unloads and bootstraps the job so launchd remains the only process owner. A same-process managed entrypoint captures both current structured records and legacy release output into the bounded streams. It does not spawn a second bot process, and it keeps health-checked rollback compatible with older releases.

From an authorized operator workstation, create the private configuration once:

```bash
cp .cmibot-remote.example.json .cmibot-remote.json
chmod 600 .cmibot-remote.json
```

Fill in the private SSH destination and absolute remote paths in `.cmibot-remote.json`. The file is ignored by Git and must remain local. Then use the remote wrapper instead of the host-local commands:

```bash
./scripts/remote status
./scripts/remote restart
./scripts/remote update
./scripts/remote logs --lines 100
./scripts/remote logs --follow
./scripts/remote deploy
./scripts/remote deploy --rollback
```

The wrapper reads its destination only from the owner-readable local configuration, uses non-interactive SSH authentication, and accepts only the documented operations and options. `update` runs the fail-closed source updater remotely with a minimal executable path derived from the configured Node location; it does not restart or activate a release. It is an operator tool and is never exposed through Discord. Do not put host aliases, usernames, private paths, credentials, or other infrastructure identifiers in tracked files or public tickets.

Deploy the currently committed, clean Git revision with:

```bash
./scripts/deploy
```

Deployment data is generated under ignored `.deploy/`. The deployer acquires an exclusive lock, exports only the committed Git revision to a new release, links the host-specific `.env` and persistent `logs/` directory instead of copying them, runs `npm ci` and `npm run check:bot`, and only then atomically switches `.deploy/current`. After launchd restarts the bot, deployment succeeds only when the job is running and a fresh structured `discord.connected` health record appears in the service log. Legacy connection lines remain accepted so rollback can verify an older release. A failed health check automatically restores, restarts, and verifies the preceding release.

The last two verified releases can be swapped explicitly with:

```bash
./scripts/deploy --rollback
```

The LaunchAgent points at `.deploy/current`. Each release is assembled with its generated `node_modules` during staging and is left unchanged after activation; `.env`, usage logs, and upstream-version state remain shared at the project root across deploys and rollbacks.

## Continuous Integration

GitHub Actions runs on pushes to `main`, pull requests, and manual dispatches. The macOS test matrix runs `npm ci` followed by `npm run check:bot` on Node.js 22 LTS, 24 LTS, and 26 Current, including generated-document drift, privacy checks, and validation of the launchd service definition. A separate Node.js 24 Ubuntu job installs the locked dependency tree without lifecycle scripts and runs the production dependency audit.

The workflow has read-only repository permissions, receives no repository secrets, disables checkout credential persistence and automatic package-manager caching, and pins official actions to immutable commit SHAs. Dependabot monitors both npm packages and GitHub Actions references.

## Dependency Maintenance

- `npm run audit:deps` checks production dependencies for moderate-or-higher security advisories.
- `npm run outdated:deps` reports direct dependency drift. npm exits with status `1` when updates are available, which is expected for this informational command.
- Weekly Dependabot checks group compatible npm and GitHub Actions minor and patch updates into reviewable pull requests. Major updates remain separate and are never merged automatically.
- Keep `package-lock.json` committed, review dependency diffs, run `npm run check`, and rerun `npm run audit:deps` before deploying an update.

## Safe Source Updates

Source updates and deployments are operator-invoked; the bot never pulls code, installs dependencies, restarts itself, or creates an operating-system schedule. An occasional check, such as once per month or before a planned maintenance restart, is enough for now:

```bash
npm run update:check
```

This fetches remote metadata and reports whether the current tracked branch is current or has a safe fast-forward available. It does not change tracked files. If an update is available, run:

```bash
npm run update:safe
```

The updater requires a clean worktree, an attached branch, and a configured upstream. It refuses local-ahead or diverged histories, and its only source-changing Git operation is `git pull --ff-only`; it never stashes, resets, switches branches, merges, or rebases. If `package.json` or `package-lock.json` changed, it runs `npm ci` against the committed lockfile. It then runs the portable bot syntax and test suite with `npm run check:bot`.

On a host where the managed LaunchAgent has been installed, follow a successful source update with `./scripts/deploy`; do not run a second manual `npm start` process. A failed fetch, pull, dependency install, release verification, or health check exits nonzero, and deployment keeps or restores the preceding verified release. The full developer check remains `npm run check`, which additionally verifies the locally maintained Paper/JDK environment and is intentionally not required on a lightweight remote bot host.

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
