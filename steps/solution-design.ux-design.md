---
id: solution-design.ux-design
title: UX design for the UI scope (project setting: UX enabled)
type: agent
role: design
readOnly: true
timeoutMinutes: 30
onlyIf: uxEnabled
artifact: .dhruva/runs/{runId}/docs/ux-design.md
---
UX DESIGN for the approved solution. DO NOT modify any files in this step.
The approved per-requirement design is at .dhruva/runs/{runId}/docs/design.md - read it completely.

PROJECT UX RULES (mandatory, from the project's settings):
{inputs.uxRules}

1. Read EVERY file in the project's standing design folder {inputs.designDir} in full (style guides, conventions). If it does not exist or is empty, say so - SLDS defaults apply.
2. Identify the REQ blocks with USER-FACING scope (screens, components, record pages). Requirements with no UI scope are out of this step - list them as 'no UI'.
3. For each UI-scoped requirement produce UX blocks, ids UX-1, UX-2..., each:
UX-n (traces: REQ-xxx): <exact LWC API name>
  PURPOSE: <what it does for the user>
  COMPOSITION: <lightning base components / SLDS blueprints, layout hierarchy>
  STATES: <loading, empty, error, success - what each shows>
  INTERACTIONS: <events in/out, data contract with apex/wire>
  ACCESSIBILITY: <labels, keyboard path, focus management, aria where needed>
  REUSES: <existing components (verified in the codebase), or '-'>
Rules: SLDS only - no custom CSS unless the project UX rules or the design folder explicitly mandate it (cite the mandate). Reuse before new.
