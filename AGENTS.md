## Agent skills

### CMIBot runtime operations

- For concise production requests such as "restart it", use the operator-workstation `./scripts/remote restart` wrapper. Use `./scripts/remote status`, `logs`, or `deploy` for the matching remote operation.
- The destination host, account, executable path, and project path belong only in the ignored `.cmibot-remote.json` file. Never put those values in tracked files, public issues, pull requests, commit messages, or user-facing bot output.
- Do not expose operational controls through Discord, invoke host-local launchd scripts on the operator workstation, or start a second manual `npm start` process.

### Alert-driven tracked updates

- When the user pastes an admin alert containing specific update transitions and says "update those N", treat the pasted list as the exact authorized scope and the listed newer versions/builds as the requested targets.
- Update CMIBot's tracked clean-snapshot data and only the related committed artifacts, indexes, or compatibility metadata needed for those listed resources. Do not update other resources merely because newer versions are discovered during the work.
- Verify every target against its authoritative public upstream before changing it, run the relevant refresh and validation workflows, commit and push the result, deploy through the private operator wrapper, and verify the single managed service afterward.
- Never copy private alert-channel details, infrastructure information, credentials, or unrelated local paths into tracked files, commit messages, public issues, or deployment output.

### Oracle Java maintenance toolchain

- Compile the internal runtime exporter with installed Oracle JDK 25 and `--release 25` (class major 69). Run clean-snapshot and Paper smoke servers with installed Oracle JDK 27.
- Use the shared resolver in `scripts/runtime-compatibility.mjs`, which discovers each installed JDK via `/usr/libexec/java_home -F -v 25` or `-F -v 27`. Never store patch-specific JDK homes. Explicit installed selections use `ONE_MB_BUILD_JAVA_HOME` and `ONE_MB_TEST_JAVA_HOME` and must pass the same major/vendor validation.
- Do not download JDKs or fall back to another major/vendor. Do not bypass validation with individual Java binaries, ambient shell Java, or JVM/compiler environment flags.
- Use `npm run build:exporter` for a clean exporter build; `npm run refresh:data` also builds cleanly before running Oracle JDK 27. Verify with `npm run check`, `npm run check:paper`, and `npm run smoke:java27`. Report actual compiler/test paths, versions, Oracle vendor, and Java 25 bytecode.
- The bot's unit tests run on Node.js. Paper integration checks cover startup, metadata export, and shutdown; do not claim interactive gameplay coverage.

### Issue tracker

Issues and specs are tracked in GitHub Issues. See `docs/agents/issue-tracker.md`.

### Domain docs

This repository uses a single-context domain-doc layout. See `docs/agents/domain.md`.
