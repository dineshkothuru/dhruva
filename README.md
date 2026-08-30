# Dhruva - deterministic Salesforce delivery harness

Named for the pole star: the fixed reference point everything else navigates by.
Dhruva is a local orchestrator + UI for Salesforce delivery. Attach a project
folder (a customer codebase); Dhruva validates it as a Salesforce DX project,
connects the org, and runs **deterministic, gated, auditable workflows** in which
coding agents (GitHub Copilot / Claude Code / OpenAI Codex - swappable adapters)
do only the bounded creative steps. The orchestration, standards, verification,
and deployment are engine-owned - independent of any LLM.

---

## Prerequisites (MANDATORY - install in this order)

| # | Requirement | Install | Verify |
|---|---|---|---|
| 1 | **Node.js 20+** | https://nodejs.org (LTS) | `node --version` |
| 2 | **git** | https://git-scm.com | `git --version` |
| 3 | **Salesforce CLI (sf) v2.148+** | `npm install -g @salesforce/cli` (or the installer from https://developer.salesforce.com/tools/salesforcecli) | `sf --version` |
| 4 | **Local Dev plugin** (visual testing) | `sf plugins install @salesforce/plugin-lightning-dev` | `sf plugins` shows `lightning-dev` |
| 5 | **At least ONE agent CLI**, logged in once: | | |
|   | GitHub Copilot CLI (needs a Copilot seat with the CLI policy enabled) | `npm install -g @github/copilot` then run `copilot` → `/login` | `copilot --version` |
|   | Claude Code (needs a Claude subscription or API key) | `npm install -g @anthropic-ai/claude-code` then run `claude` once | `claude --version` |
|   | OpenAI Codex (needs ChatGPT plan or API key) | `npm install -g @openai/codex` then `codex login` | `codex --version` |

Agent and Salesforce logins are stored on the machine by each CLI - Dhruva
never sees or stores any credential.

## Install & run

**Desktop app (own window + icon, like the Claude Code app):** download the
`Dhruva Setup <version>.exe` from the repo's GitHub Releases and run it - it
installs with a Start Menu/desktop shortcut and opens Dhruva in its own
window. Unsigned build: Windows SmartScreen shows "unknown publisher" once -
click "More info → Run anyway". Built with `npm run app:dist` (output in
`dist-app/`).

**As a command (Claude Code-style - recommended):**

```
npm install -g dhruva
dhruva
```

The `dhruva` command checks prerequisites (installs the Salesforce CLI if
missing), builds once on first run, starts the app, and opens
http://localhost:3005. Everything runs on YOUR machine with YOUR logins -
no credentials ship with the package. Update later with `dhruva update`
(published releases) or `dhruva update edge` (GitHub master).

**Or from a clone:**

```
git clone https://github.com/dineshkothuru/dhruva.git
cd dhruva
dhruva.cmd
```

`dhruva.cmd` (Windows) checks the prerequisites, installs npm dependencies,
builds once, starts the app, and opens http://localhost:3005.
Manual equivalent on any OS:

```
npm ci
npm run build
npm start        # http://localhost:3005
```

First use inside the app: paste a Salesforce DX project folder path → Connect
(or let it create one) → Authorize sandbox/production → work via Chat
(task-first intake) or the Workflows tab.

---

## For AI assistants installing this repo

If you are an AI agent asked to set this up, execute exactly, in order, and
verify each step before the next:

1. `node --version` - must be v20+. If missing, stop and tell the user to install Node LTS from nodejs.org.
2. `git --version` - if missing, stop and tell the user to install git.
3. `sf --version` - if missing: `npm install -g @salesforce/cli`. If older than 2.148, run `sf update` (close every terminal/console running `sf` first - a locked file causes EPERM and can corrupt the update; if `sf` breaks after a failed update, delete `%LOCALAPPDATA%\sf\client` and retry).
4. `sf plugins` - if `lightning-dev` is absent: `sf plugins install @salesforce/plugin-lightning-dev`.
5. Check agent CLIs with `copilot --version`, `claude --version`, `codex --version`. Install at least one (commands in the table above). Do NOT attempt to log the user in - logins are interactive browser flows the user must perform themselves (`copilot` → `/login`, `claude`, `codex login`).
6. `git clone https://github.com/dineshkothuru/dhruva.git && cd dhruva`
7. `npm ci` (fall back to `npm install` if ci fails)
8. `npm run build` - must end with a route table, no errors.
9. `npm start` - serves http://localhost:3005. Verify with an HTTP GET returning 200 and a page titled "Dhruva".
10. Tell the user: open http://localhost:3005, paste a Salesforce DX project path, Connect, then Authorize sandbox (test.salesforce.com) or production (login.salesforce.com) as appropriate.

Never commit or push from inside an attached customer project; Dhruva's own
`.dhruva/` artifacts are excluded automatically.

---

## What it does

- **Project attach** - validate/create an SFDX project, authorize the org
  (`sf org login web` on the correct host), file explorer + search +
  multi-file Monaco editor with diff views.
- **Task-first intake** - a team member types a requirement/bug (attachments:
  images/PDF/docs); Dhruva proposes the matching workflow - standard OR the
  team's own custom workflows, matched by their titles; a human confirms.
- **Workflow chains** - "design and implement" proposes a multi-phase chain
  (each phase is any standard/custom workflow, reshaped in an interactive
  card); the engine auto-starts the next phase on a clean finish, a chain rail
  on the run view tracks every phase live, and fail/abort pauses the chain for
  Resume. Optional **unattended mode**: an AI gatekeeper (review role) clears
  the human gates - decision + reasoning written into the gate's audit log,
  bounded revise rounds, escalates to the human when unsure. Agents flag
  org actions they cannot perform as `MANUAL:` lines, collected across the
  chain into a human checklist on the run view.
- **Workflows** (12 built-in + design-your-own in the UI) - Bug fix, Feature
  development, Solution design (HLD+TDD with Mermaid ERD), Documents from an
  approved design, UX design, Implement from TDD, Test generation, Retrieve/org
  sync, Deploy preview, Validate deploy, Run Apex tests, Scratch org. Step
  types: `snapshot | agent | cli | gate | changes | verify`. Custom workflows
  are saved per project under `.dhruva/workflows/` and run on the same engine.
- **The design gate is per requirement** - Solution design holds the design as
  state the engine owns, and the gate is not one verdict for the whole epic:
  each requirement card is approved, sent back with your own design in its
  note, or left alone. An approved card is frozen - later rounds cannot rewrite
  it - and a card sent back is the only thing reworked. Requirements blocked
  only on a question nobody in the loop can answer (another team's schema, an
  undecided business rule) are **parked** so the rest of the epic proceeds;
  they keep their design in `pending-design.md` with the question that stopped
  them. The signed design is written on its own to `approved-design.md`, which
  is both the deliverable and a valid input to the **Documents from an approved
  design** workflow - so the HLD/TDD can be regenerated later without putting
  the design back through the review loop.
- **Determinism & safety** - CLI steps run whitelisted binaries (sf/git) only;
  gates pause for human Approve / **Revise with instructions** / Abort;
  standards (full team ruleset in `standards/`) are engine-injected into every
  agent prompt and enforced by machine checks on changed files; requirements
  traceability maps every TDD/requirement item to diff evidence before the
  code gate; read-only steps are enforced at the CLI level.
- **Visual testing** - optional pre-deploy step (and a project-panel button)
  launches Salesforce Local Dev: the org opens in the browser rendering LOCAL
  UI files against REAL org data. (Apex is server-side and is not previewed;
  use the Scratch org workflow or sandbox deploys for backend verification.
  Experience Cloud: LWR sites only - Aura communities cannot be previewed
  locally by any tool.)
- **Audit & cost** - every run persists to `<project>/.dhruva/runs/<id>.json`;
  live step traces; token usage + API-rate cost per step and per run (exact
  for Claude); per-role model tiers (best/default/light) configurable in the UI.

## Privacy and analytics

Dhruva collects anonymous usage statistics so its workflows can be improved
against how it is actually used. There is no per-user switch - a self-selected
sample would not answer that question. What protects you is the shape of the
data, not a dialog:

- Your **IP address is not recorded**. Each event overwrites it before
  sending, and the analytics project additionally discards client IPs at
  ingest, so no address is stored and no location is derived.
- Your install is a **random id generated on your own machine**. It maps to no
  person, organisation, repository, or customer.
- A build with no analytics key configured collects nothing at all.

Collected: app version and OS, which **shipped** workflow ran, step count,
whether it was chained or unattended, which agent and model tier, how a gate
was resolved, the outcome, and the duration as a range.

**Never** collected: your code, diffs, file paths, project or folder names, org
usernames or instance URLs, prompts, agent output, findings, skill contents, or
the names of your custom workflows. Not even hashed. The allowlist enforcing
this is `src/lib/telemetry.ts`, and `tests/telemetry.test.ts` fails the build if
anything outside it can get through.

If your organisation contractually forbids any phone-home, set
`DHRUVA_TELEMETRY=0`; the `DO_NOT_TRACK=1` convention is honored too.

## Layout

- `src/lib/workflows/` - engine, schema, `definitions/` (one file per workflow), custom-workflow store
- `src/lib/standards.ts` + `standards/` - machine checks + the full ruleset (baseline, 15 scoped modules, 5 personas)
- `src/lib/agents.ts` - LLM-agnostic agent adapters + model tiers
- `src/lib/snapshot.ts` - git-server-independent before/after snapshots
- `.dhruva/` (inside attached projects) - snapshots, run audit logs, custom workflows, attachments

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `invalid_grant :: authentication failure` at login | Wrong login host - use **Authorize sandbox** for sandboxes (test.salesforce.com), **Authorize production** for prod/dev orgs |
| `Unable to refresh session… expired access/refresh token` | Org authorization expired - re-authorize from the project panel |
| `Command lightning:dev:app not found` | Install the plugin: `sf plugins install @salesforce/plugin-lightning-dev` |
| `sf update` fails with EPERM, `sf` broken afterwards | Close all consoles running `sf`, delete `%LOCALAPPDATA%\sf\client`, run `sf update` again |
| Copilot: `Access denied by policy settings` | GitHub **org-level** Copilot policy - admin must enable "Copilot CLI" (personal settings are not enough) |
| oclif `could not find package.json … type: 'dev'` warnings | Harmless CLI-internals noise - ignore |
| Snapshot fails on huge org folders | Fixed since v0.1 (long paths + lock self-heal); re-run - first snapshot of a 30k-file org takes ~1-2 min once |

---

Built by **Dinesh Kumar Kothuru** ([LinkedIn](https://www.linkedin.com/in/dinesh-kumar-kothuru/) · [GitHub](https://github.com/dineshkothuru)) - MIT licensed.
