---
id: design-context
title: Read the design folder + existing components (read-only)
type: agent
role: read
readOnly: true
timeoutMinutes: 20
---
Binary attachments (.docx/.pdf) cannot be read directly - when one is referenced, read the extracted sibling file <same-name>.extracted.md instead (created at upload); only report a document unreadable if no extracted sibling exists.
CONTEXT GATHERING ONLY - do not design anything and do not modify any files.
Requirement:
{inputs.requirement}

1. Read EVERY file in the project's standing design folder {inputs.designDir} in full (style guides, brand rules, screenshots described by their file names, component conventions). If the folder does not exist or is empty, say so explicitly and note that SLDS defaults apply.
2. If the requirement references attached documents (paths under .dhruva/attachments/), read them in full too.
3. Inventory the existing LWCs under force-app that are relevant to this requirement: component name, what it renders today, reusable parts (verified by reading the markup/JS, never guessed from the name).
Output: DESIGN CONVENTIONS (what the design folder mandates), REUSABLE COMPONENTS (what exists), and GAPS (what has no precedent).
