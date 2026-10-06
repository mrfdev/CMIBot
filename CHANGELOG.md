# Changelog

This file records material LookupBot changes by ship date. User-facing examples intentionally omit private identifiers, infrastructure details, credentials, and host-specific paths.

## 2026-10-06

### Toolchain and dependency maintenance

- Preserve verified stable Homebrew executable links in generated Node and Ollama service definitions so package cleanup does not strand a service on a removed Cellar version.
- Update dotenv to 18.0.5 and the locked Undici dependency to 6.29.0, and align the declared Discord.js version with the existing 14.27.0 lockfile.
- Replace fast-glob and its unpatched braces dependency with native Node file discovery, preserving profile exclusions and rejecting symlink files and directories.
- Require Node 22.20+ on the 22.x line or 24.8+, and add the minimum supported version to CI alongside current 22, 24, and 26 releases.
- Exercise runtime export during Paper smoke tests, read the exporter version from the compatibility manifest, and enforce separate startup, export, and shutdown deadlines.
- Document that the bot uses Node directly, the reference exporter uses JDK 25's compiler and jar tool, and neither Gradle nor Python is a project dependency.

## 2026-08-27

### Zero-cost local AI

- Added private `/lookup ask` answers grounded only in bounded, redacted evidence from the active plugin's existing indexes.
- Added local Ollama generation over a loopback-only address with structured output, citation allowlisting, output safety checks, one-request concurrency, hard timeouts, and local resource limits.
- Locked the paid budget to `$0.00`, rejected external providers and cloud model names, removed the paid OpenAI SDK dependency, and prevented silent provider fallback.
- Added deterministic cited evidence fallback whenever local generation is disabled, busy, unsafe, unavailable, or missing its configured model.
- Added admin-only `/lookup ai-status`, aggregate-only owner-readable day/month usage state, and a privacy-safe operator readiness command.
- Added an explicit, repeatable operator installer for the approved local model using the verified Homebrew package, owner-only cloud-disabled configuration, a loopback-only user service, and an end-to-end structured-output smoke test.
- Kept grounded-answer footers concise by removing the repeated external-provider disclaimer; provider safety remains visible in the dedicated status output.
- Removed automatic AI reranking from ordinary searches. AI runs only for an authorized private `ask` or `summary:true` request.
- Added secret, token, private-key, Discord-ID, traversal, and private-path rejection before AI retrieval, plus credential-value redaction before local prompts.

### Search and result experience

- Added owner-bound Previous/Next pagination with bounded, expiring sessions and safe invalidation after cache changes.
- Added commit-pinned source links so each result continues to reference the exact public source revision that produced it.
- Added context-aware Discord autocomplete using cached keys, tokens, and safe plugin-relative filenames without recording partial input.
- Added local “Did you mean?” suggestions for valid searches that return no useful result.
- Added private `/lookup files` and `/lookup categories` navigation over the safe indexed view.
- Added private expandable YAML results with the complete matched block, bounded surrounding context, generic attachments for long output, and credential-value redaction.
- Extended `related:true` from nearby YAML entries to deterministic references across commands, permissions, configuration, placeholders, FAQs, tab-complete data, and language entries.
- Rendered related references one per line and made Discord-limit trimming preserve complete links and balanced code fences, preventing partial source URLs from producing unwanted embeds.
- Added validated, plugin-scoped synonyms and aliases while preserving direct-match priority.

### Versions and tracked data

- Added private `/lookup latest changes:true` reports containing version differences and bounded release notes for pending updates. `scope:all` applies the report to all tracked resources, while public release-note output remains disabled.
- Added fixed-provider, size-bounded, mention-safe release metadata retrieval with exact-version-pair caching and safe release-history fallbacks.
- Added bounded retries, exponential backoff, per-resource circuit breakers, and persistent last-known values for temporary upstream failures.
- Updated the clean snapshot to Paper `26.2 build 119` and LuckPerms `5.5.79`.

### Administration and operations

- Added admin-only `/lookup health` with privacy-safe readiness, freshness, version-check, cache, and service summaries.
- Kept `/lookup reload` as a full reload by default and added optional plugin- and profile-selective reloads.
- Added fail-closed startup validation for malformed configuration, unsafe paths, duplicate routes, incomplete indexes, and version-catalog drift.
- Added aggregate private alerts for stale data, failed checks, and tracked updates, plus `/lookup alerts-test` for delivery testing.
- Added guarded operator workflows for status, restart, logs, safe source updates, verified deployment, and rollback without exposing them through Discord.
- Added private standard-input operations for configuring the admin-alert destination and adding an allowed test channel without placing identifiers in command arguments or tracked files.

### Performance, observability, and maintenance

- Added bounded parallel cache warming, transactional reloads, and a bounded LRU cache for repeated identical searches.
- Added owner-only compact derived profile indexes with exact content fingerprints, automatic stale/corrupt fallback, preserved YAML expansion metadata, bounded gzip artifacts, and aggregate health counters.
- Added admin-only `/lookup reload force:true` for full, plugin, or profile scopes. It validates a fresh source snapshot and atomically replaces only selected derived artifacts without deleting or modifying source data.
- Added structured service records with request IDs and command timing, bounded aggregate metrics, independent log rotation, retention limits, and disk-reserve protection.
- Added GitHub Actions checks across supported Node.js versions, syntax and test validation, a production dependency audit, least-privilege workflow settings, and Dependabot coverage.
- Added canonical configuration metadata plus generated blank-safe environment examples, JSON Schema, and Markdown references. CI now fails when generated documentation drifts.
