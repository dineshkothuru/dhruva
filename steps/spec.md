---
id: spec
title: Draft technical spec (agent, read-only)
type: agent
role: design
readOnly: true
---
Binary attachments (.docx/.pdf) cannot be read directly - when one is referenced, read the extracted sibling file <same-name>.extracted.md instead (created at upload); only report a document unreadable if no extracted sibling exists.
You are designing a Salesforce implementation for a requirement. DO NOT modify any files in this step.
Requirement: {inputs.requirement}
Study the existing codebase first (reuse existing classes/objects/patterns - never plan a parallel implementation of something that exists).
Reply in EXACTLY this structure:
1. USE CASES - extract them from the requirement with stable ids:
   UC-1: <title> - <actor> wants to <action> so that <outcome>.  (happy paths)
   UC-E1: <title> - what happens when <error/edge condition>.    (error & edge cases - think bulk loads, missing permissions, null data, concurrent edits)
2. SCOPE - 'In scope' bullet list and 'Out of scope' bullet list (with why), so the reviewer sees the boundary explicitly.
3. TECHNICAL SPEC - (a) approach, (b) components to create or modify with exact API names, (c) test plan covering every UC id above.
4. OPEN QUESTIONS - anything unresolved that could change the design ('none' if none).
End your reply with one line listing every EXISTING file you will modify as project-relative paths:
FILES: force-app/main/default/classes/Example.cls
