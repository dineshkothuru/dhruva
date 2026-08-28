---
id: implement-tdd.traceability
title: Requirements traceability matrix (agent, read-only)
type: agent
role: trace
readOnly: true
emits: coverage
---
Build a requirements traceability matrix. Re-read the ENTIRE TDD at {inputs.tddPath} (chunked reads to the end). Extract every requirement/component/behavior it specifies (respect the scope note: {inputs.scope}). For EACH item, inspect the changed files below and report one line:
  <n>. <requirement item> - IMPLEMENTED (evidence: file + method/element) | PARTIAL (what is missing) | MISSING
Changed files in this run:
{steps.changes.output}
