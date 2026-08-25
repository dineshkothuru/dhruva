# Dhruva — deterministic Salesforce delivery harness

Named for the pole star: the fixed reference point everything else navigates by.
Dhruva is a local orchestrator + UI for Salesforce delivery. Attach a project
folder (a customer codebase); Dhruva validates it as a Salesforce DX project,
connects the org, and runs **deterministic, gated, auditable workflows** in which
coding agents (GitHub Copilot / Claude Code / OpenAI Codex — swappable adapters)
do only the bounded creative steps. The orchestration, standards, verification,
and deployment are engine-owned — independent of any LLM.

## What works today

- **Project attach** — validate/create an SFDX project, authorize the org
  (`sf org login web`), file explorer + search + multi-file Monaco editor.
- **Agent chat** — task an agent inside the project; output streams in; a
  deterministic review card shows exactly what changed, with side-by-side diffs.
- **Workflows** (`src/lib/workflows/builtins.ts`) — Bug fix, Feature development,
  Retrieve/org sync, Deploy preview, Validate deploy, Run Apex tests, Scratch org.
  Step types: `snapshot | agent | cli | gate | changes | verify`. CLI steps run
  whitelisted binaries only; gates pause for human approval; every run persists
  to `<project>/.sfharness/runs/<id>.json` as the audit trail.
- **Standards** (`standards/`) — the full team ruleset (baseline + 15 scoped
  instruction modules + 5 personas), injected into agent prompts by the engine
  (scoped via `applyTo` globs) and enforced by deterministic checks over changed
  files (SeeAllData, hardcoded IDs, secrets, SOQL/DML in loops, …).
- **Live tracking + cost** — running steps stream a structured trace; token
  usage and API-rate cost shown per step and per run (exact for Claude,
  estimated otherwise).

## Run (team members)

Double-click `dhruva.cmd` (or run it in a terminal). It installs dependencies,
builds once, and opens http://localhost:3005. One-time machine prerequisites:
Node 20+, git, Salesforce CLI (`sf`), and at least one agent CLI logged in
(`copilot` / `claude` / `codex`).

## Run (development)

```
npm install
npm run dev   # http://localhost:3005 (or the port in your launch config)
```

Agents authenticate once on the machine via their own CLIs (`copilot`, `claude`,
`codex`) — Dhruva never handles credentials, Salesforce's or the agents'.

## Layout

- `src/lib/workflows/` — engine, schema, built-in workflow definitions
- `src/lib/standards.ts` + `standards/` — rules: distilled checks + full library
- `src/lib/agents.ts` — LLM-agnostic agent adapters
- `src/lib/snapshot.ts` — git-server-independent before/after snapshots
- `.sfharness/` (inside attached projects) — snapshots, run audit logs
