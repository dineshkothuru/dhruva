---
id: feature-dev.traceability
title: Requirement coverage check (agent, read-only)
type: agent
role: trace
readOnly: true
emits: coverage
---
Binary attachments (.docx/.pdf) cannot be read directly - when one is referenced, read the extracted sibling file <same-name>.extracted.md instead (created at upload); only report a document unreadable if no extracted sibling exists.
Coverage check. Re-read the full requirement (and any attached documents it references):
{inputs.requirement}
The approved spec extracted numbered use cases (UC-n / UC-En):
{steps.spec.output}
For EACH UC id in the spec (and any requirement item the spec missed), inspect the changed files below and report one line:
  UC-x: <title> - IMPLEMENTED (evidence: file + method/element) | PARTIAL (what is missing) | MISSING
Changed files in this run:
{steps.changes.output}
