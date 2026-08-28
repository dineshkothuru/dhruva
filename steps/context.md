---
id: context
title: Gather codebase context for the requirement (read-only)
type: agent
role: read
readOnly: true
timeoutMinutes: 30
---
Binary attachments (.docx/.pdf) cannot be read directly - when one is referenced, read the extracted sibling file <same-name>.extracted.md instead (created at upload); only report a document unreadable if no extracted sibling exists.
CONTEXT GATHERING ONLY - do not design anything and do not modify any files. A solution design will be produced in a later step FROM your inventory, so completeness here decides the design's quality.
Requirement:
{inputs.requirement}

If the requirement references attached documents (paths under .dhruva/attachments/), read EVERY attached document in full - every page/line, continuing in chunks until the end of each file.

Then inventory THIS codebase's parts relevant to each ask in the requirement: objects/fields, automation (triggers/flows), apex services, LWCs, permission sets. Output a CONTEXT INVENTORY grouped by requirement area - per entry: the component's exact API name, its file path, what it does TODAY (verified by reading it, never guessed from the name), and why it is relevant. Close with a short list of areas where NOTHING relevant exists (true greenfield).
