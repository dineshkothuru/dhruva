# Contributing to Dhruva

## Setup

```
npm ci
npm run dev        # http://localhost:3005
```

Verify everything before you push:

```
npm run verify     # lint + typecheck + test
npm run build      # must also pass
```

CI runs exactly these on every push and pull request.

## How the code is laid out

```
src/app/api/       thin HTTP routes - validate input, call lib, return JSON
src/lib/           all the logic (no React imports - unit testable)
  workflows/       the engine, schema, validator, tasks contract
src/components/    the UI
workflows/*.json   the shipped workflow definitions
standards/         the Salesforce ruleset injected into every agent prompt
tests/             vitest suite over the pure lib modules
```

The rule that keeps this maintainable: **logic lives in `src/lib` and never
imports React**. Anything in `src/lib` can be unit tested directly, and the
tests in `tests/` prove the contracts the engine depends on.

## The execution model (read this before touching the engine)

A run is a `RunState` (see `src/lib/workflows/schema.ts`) executing a
`WorkflowDef` step by step. Every state change is persisted to
`<project>/.dhruva/runs/<runId>.json` - that file is the audit trail and the
source of truth after a restart.

- **Step types**: `snapshot | agent | cli | gate | changes | verify | tasks-check`
- **Gates** pause the run for a human (approve / revise / abort). A "revise"
  replays the steps from the gate's `reviseTarget` with the feedback injected,
  then gates again. Gates are handled in `executeSteps`, never in `runStep`.
- **autoRevise** lets a review step self-heal its target a bounded number of
  rounds *before* the human gate - it never replaces the gate.
- **Chains** (`RunState.chain`) start the next workflow when a run finishes
  clean; a failed or aborted run pauses the chain until it is resumed.
- **Unattended mode** (`RunState.autoGate`) lets an AI gatekeeper resolve
  gates. Its reasoning is written into the gate step's output - never hide a
  gatekeeper decision from the audit trail.

## Adding a workflow

Add a JSON file to `workflows/`. It goes through the *same* validator as
user-authored custom workflows (`src/lib/workflows/validate.ts`), and
`tests/workflows.test.ts` fails the build if it is invalid, has a duplicate
id, references an undeclared input, or points at a step that runs later.

## House rules

- **No em dashes or en dashes** anywhere in the app, prompts, or docs. Use a
  plain hyphen. `tests/workflows.test.ts` enforces this for workflow files.
- **Never send project content to a third party.** Telemetry (if enabled) is
  restricted to the `ALLOWED_PROPS` allowlist in `src/lib/telemetry.ts`.
  Adding a field there is a deliberate decision, not a convenience: it must
  be impossible for the value to identify a customer, a person, a repository,
  or a piece of work. `tests/telemetry.test.ts` guards this contract, and
  telemetry stays OFF until the user opts in.
- **Every path from user input goes through `src/lib/fsguard.ts`.** Do not
  build paths by hand in a route.
- Comments should explain *why*, not restate the code. The existing comments
  are the standard to match.
