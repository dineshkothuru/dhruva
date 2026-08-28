---
id: implement-tdd.implement
title: Implement per TDD (agent - one bounded run per build-plan task)
type: agent
role: implement
timeoutMinutes: 30
taskLoop: true
tasksFile: {inputs.tasksPath}
---
Implement the approved plan. The Technical Design Document at {inputs.tddPath} is the specification - follow its component designs, API names, and test strategy exactly.
Approved build checklist:
{steps.plan.output}

Org-refresh delta since planning:
{steps.retrieve-delta.output}
If files are listed in that delta, re-read them before changing them.
Write or update the Apex tests the TDD's test strategy specifies. Never create a parallel implementation of something that exists. Do not deploy.
