---
id: ux-design.coverage-check
title: Verify the spec covers every UX block (read-only)
type: agent
role: trace
readOnly: true
timeoutMinutes: 20
autoRevise:
  target: write-doc
  trigger: COVERAGE:\s*INCOMPLETE
  maxRounds: 1
emits: coverage
---
Coverage verification. Do not modify any files.
Read .dhruva/runs/{runId}/docs/ux.md and .dhruva/runs/{runId}/docs/tasks.json in full.
Approved UX design:
{steps.ux-design.output}

For EVERY UX-n block report one line:
  UX-n - COVERED (spec section + task id) | MISSING FROM SPEC | NO TASK | DIVERGES (quote it)
