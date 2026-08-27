# Instructions for AI agents working with this repository

**To install and run Dhruva:** follow the "For AI assistants installing this
repo" section of [README.md](README.md) exactly, in order, verifying each step.
Summary: verify Node 20+/git → install/update Salesforce CLI (`sf`) →
`sf plugins install @salesforce/plugin-lightning-dev` → ensure at least one
agent CLI exists (copilot/claude/codex; the USER must perform logins - never
attempt them yourself) → `npm ci` → `npm run build` → `npm start` →
verify http://localhost:3005 returns 200 → hand off to the user.
On Windows, `dhruva.cmd` performs all of this in one command.

**To develop in this repository:** Next.js 16 App Router + TypeScript.
Before declaring any change done: `npm run lint && npm run build` must pass.
Key areas: `src/lib/workflows/` (engine + definitions), `src/lib/standards.ts`
and `standards/` (team ruleset), `src/lib/agents.ts` (agent adapters + model
tiers), `src/lib/snapshot.ts` (review snapshots). Never weaken the guardrails:
whitelisted CLI binaries only, human gates before deploys, read-only
enforcement on analysis steps, path containment on all file APIs.
