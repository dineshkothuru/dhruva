---
id: bug-fix.review
title: Code review of the changes (agent, read-only)
type: agent
role: review
persona: salesforce-review
readOnly: true
autoRevise:
  target: implement
  trigger: VERDICT:\s*BLOCKED
  maxRounds: 3
emits: findings
---
Review ONLY the changes listed below (made in this run) against the team standards. Do not modify any files.
Changed files:
{steps.changes.output}
Deterministic standards-check result:
{steps.verify-standards.output}
Read each changed file and review the actual change.
