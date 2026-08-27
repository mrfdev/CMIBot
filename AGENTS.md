## Agent skills

### CMIBot runtime operations

- For concise production requests such as "restart it", use the operator-workstation `./scripts/remote restart` wrapper. Use `./scripts/remote status`, `logs`, or `deploy` for the matching remote operation.
- The destination host, account, executable path, and project path belong only in the ignored `.cmibot-remote.json` file. Never put those values in tracked files, public issues, pull requests, commit messages, or user-facing bot output.
- Do not expose operational controls through Discord, invoke host-local launchd scripts on the operator workstation, or start a second manual `npm start` process.

### Issue tracker

Issues and specs are tracked in GitHub Issues. See `docs/agents/issue-tracker.md`.

### Domain docs

This repository uses a single-context domain-doc layout. See `docs/agents/domain.md`.
