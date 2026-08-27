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

### Issue tracker

Issues and specs are tracked in GitHub Issues. See `docs/agents/issue-tracker.md`.

### Domain docs

This repository uses a single-context domain-doc layout. See `docs/agents/domain.md`.
