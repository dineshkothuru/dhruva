---
id: solution-design.coverage-check
title: Verify the documents cover every requirement (agent, read-only)
type: agent
role: trace
readOnly: true
timeoutMinutes: 30
autoRevise:
  target: write-doc
  trigger: COVERAGE:\s*INCOMPLETE
  maxRounds: 1
emits: coverage
---
Design coverage verification. Do not modify any files.
Read IN FULL: (1) .dhruva/runs/{runId}/docs/hld.md, (2) .dhruva/runs/{runId}/docs/tdd.md. If your search tool reports no match, read the paths directly - they are inside a dot-directory, which some search tools skip.

FROZEN REQUIREMENT LIST (the agreed requirement set - check against this, not the source document):
{steps.requirements.output}

Approved per-requirement design. Each block may carry its review history below a `<!-- lineage -->` marker; the design is the fields ABOVE it, and a superseded approach quoted inside a finding is not the design:
{steps.analyse.output}

For EVERY REQ item, report one line:
  REQ-xxx - COVERED (HLD section N / TDD section M) | MISSING FROM DOCS | DIVERGES (the docs say something different from the approved design - quote it)
Also flag anything in the docs that has no approved requirement behind it (scope creep), any REQ with pending work that no Acceptance Criterion traces ([traces: REQ-xxx]), and any Build Plan task in the TDD that traces to nothing.
If an approved UX design exists (below), ALSO report one line per UX-n: covered in the TDD's UI section + a task traces to it, or MISSING.
Approved UX design (may be empty):
{steps.ux-design.output}
