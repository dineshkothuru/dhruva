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
tiers), `src/lib/snapshot.ts` (review snapshots), `src/lib/org/` (in-process
org reads), `src/lib/lsp/` (language servers). Never weaken the guardrails:
human gates before deploys, read-only enforcement on analysis steps, path
containment on all file APIs, and only whitelisted binaries may be spawned.

**Org access has two paths, on purpose.** WRITES and anything interactive stay
on the `sf` CLI - deploys, `sf org login web`, scratch org creation,
`sf lightning dev`. READS go in-process through `src/lib/org/connection.ts`,
which reuses the CLI's own `~/.sf` authentication via `@salesforce/core`,
because a CLI spawn costs ~6s of startup before doing any work and that made
compare and the Org tab unusable. Every in-process read must keep its CLI
fallback: a failed connection should cost the old speed, never the feature.
An access token is in memory on that path - do not log it, persist it, or send
it anywhere but Salesforce.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
