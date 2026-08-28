---
id: plan
title: Read the TDD and plan the build (agent, read-only)
type: agent
role: read
readOnly: true
emits: work
---
Read the approved Technical Design Document at {inputs.tddPath} in this project. DO NOT modify any files in this step.
Scope note from the requester (may narrow the work): {inputs.scope}
Cross-check the TDD against the current codebase (components it references, reuse it assumes). If the TDD has a Build Plan section (task table T-1, T-2… with depends_on), use ITS order as the checklist; otherwise produce the implementation checklist in dependency order yourself. Either way: each component to create or modify, and flag anything in the TDD that no longer matches the codebase.
End with one line listing every EXISTING file you will modify as project-relative paths:
FILES: force-app/main/default/classes/Example.cls
