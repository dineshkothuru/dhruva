---
id: implement-tdd.review
title: Code review against the TDD (agent, read-only)
type: agent
role: review
persona: salesforce-review
readOnly: true
tasksFile: {inputs.tasksPath}
autoRevise:
  target: implement
  trigger: VERDICT:\s*BLOCKED
  maxRounds: 3
emits: findings
---
Review ONLY the changes listed below against the team standards AND against the TDD at {inputs.tddPath} (the changes must implement what the TDD specifies - flag deviations). Do not modify any files.
Changed files:
{steps.changes.output}
Deterministic standards-check result:
{steps.verify-standards.output}
