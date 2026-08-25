# SF Delivery Harness

An Archon-style local orchestrator + UI for Salesforce delivery. Attach a project
folder (a customer codebase); the harness validates it as a Salesforce DX project,
shows repo + org connection status, and (in later phases) drives coding agents —
GitHub Copilot CLI first, others via adapters — inside that folder with delivery
guardrails.

## Current phase (MVP 1)
- Folder attach + detection: `sfdx-project.json` parse, git-repo flag,
  best-effort `sf org display` org badge.

## Run
```
npm install
npm run dev   # http://localhost:3005
```

## Roadmap seams
- `src/lib/adapters/` — agent adapters (`copilot -p … --allow-all-tools`, cwd = project).
- Harness file injection into the project via `.git/info/exclude` (never reaches the customer's git server).
- Guarded delivery steps wrapping `sf` deploy/test with production checks.
