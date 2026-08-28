---
id: ux-design.ux-design
title: Design each screen/component (SLDS-only)
type: agent
role: design
readOnly: true
timeoutMinutes: 30
---
Design the UX for this requirement. DO NOT modify any files in this step.
Requirement:
{inputs.requirement}

Design context from the previous step (conventions, reusable components, gaps):
{steps.design-context.output}

Rules: SLDS ONLY - lightning base components and SLDS utility classes; NO custom CSS unless the design folder explicitly mandates it (then cite the mandate). Reuse the inventoried components before proposing new ones.
Output ONE BLOCK PER SCREEN/COMPONENT, ids UX-1, UX-2...:
UX-n: <component name (exact LWC API name)>
  PURPOSE: <what it does for the user>
  COMPOSITION: <lightning base components / SLDS blueprints used, layout hierarchy>
  STATES: <loading, empty, error, success - what each shows>
  INTERACTIONS: <events in/out, data contract with apex/wire>
  ACCESSIBILITY: <labels, keyboard path, focus management, aria where needed>
  REUSES: <existing components used, or '-'>
End with OPEN QUESTIONS (or 'none').
