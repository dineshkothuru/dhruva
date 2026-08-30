---
id: solution-design.write-doc
title: Write HLD + TDD documents (with ERD)
type: agent
role: design
persona: salesforce-writer
timeoutMinutes: 30
---
The approved design is already written, in full, at .dhruva/runs/{runId}/docs/design.md - one REQ block per requirement, each with STATUS, EVIDENCE, ALREADY-PRESENT, PENDING, DESIGN, EFFORT and DEPENDS-ON. Read it completely. If your search tool reports no match, read the path directly: it is inside a dot-directory, which some search tools skip, and a failed search is not evidence the file is absent.

Each block may also carry its own review history, below a `<!-- lineage -->` marker: the findings raised against it and the designer's answers. That is the record of HOW the design reached its current form - the design itself is the fields ABOVE the marker. Write the documents from the fields. Read the history only when you need to know why something is the way it is, and never carry a superseded design into the documents because it appears in a finding.

If that file does not exist or has no REQ blocks, STOP and say so plainly - do not invent a design. It is the only copy; writing documents from memory would silently replace an approved design with a guess.

Your job is NOT to restate it. Re-typing a gap analysis that already exists is how requirements get lost: on a real run five of them vanished between the design and the documents. Reference the design for anything it already says, and spend your effort on what it does NOT say.

The design is organised per REQUIREMENT. These documents are organised per CONCERN - data flow, error handling, governor limits, deployment order. That thinking cuts across all the REQ blocks at once and exists nowhere yet. That is the work.

Create or modify ONLY these three files:

1. .dhruva/runs/{runId}/docs/hld.md - for stakeholders and review boards:
  1. Context - the problem space and system boundaries this design stands on.
  2. Goals / Non-Goals - what it achieves, and what it explicitly does not.
  3. Gap Analysis - DO NOT re-tabulate the REQ blocks. One short paragraph of the shape of the gap (how many already implemented / partial / new, and the theme), then: "Per-requirement detail: see design.md."
  4. Approaches Considered - assemble this from the REJECTED lines the design already recorded: per decision, the option taken, the option rejected, and the constraint that ruled it out. Do NOT invent alternatives the design does not name - a deliberation nobody had, written up after approval, is the one section of this document no reviewer ever checked. Add the overall complexity (XS/S/M/L/XL) for the selected approach.
  5. High-Level Design - how the component groups interact, and the key abstractions introduced. Architecture, not a per-REQ list.
  6. Data Model - a Mermaid er-diagram (```mermaid / erDiagram) of new and impacted objects, their relationships and key fields.
  7. Integration Touchpoints and Security Model.
  8. Constraints and Trade-offs - assemble from the design's TRADE-OFF lines; add only constraints that emerge across requirements rather than within one.
  9. Acceptance Criteria - "AC-n: Given <precondition>, when <action>, then <outcome>. [traces: REQ-xxx]". Every REQ with pending work needs at least one AC.
  10. Impact analysis, risks and assumptions, Open Questions. For effort, total the design's EFFORT values and show the total plus any contingent items - do not re-list every requirement.

2. .dhruva/runs/{runId}/docs/tdd.md - for the developers who build it:
  1. Components - per apex class, trigger, LWC, flow, object and field: exact API names, responsibility, inputs/outputs, dependencies, reuse-vs-new, and method-level design or pseudocode where non-trivial.
  2. Data Flow - how data moves end to end.
  3. State Management - what state exists, where it lives, how it changes.
  4. Error Handling - what can fail, and how each failure is handled and surfaced.
  5. Governor Limits and Sharing/FLS specifics.
  6. Deployment Order and dependencies.
  7. Test Strategy - the test classes and scenarios (positive, negative, bulk). Apex tests run in the org, so tests ship WITH the implementation and are proven by a check-only deploy with RunLocalTests; never promise a failing-tests-first cycle.
  8. Build Plan - a short summary table of the tasks file (T-n | title | depends on | traces). The tasks file is the authority.
  9. Decisions - one line each: Decision -> Rationale -> Consequence.
  10. Open Questions that may affect implementation.

3. .dhruva/runs/{runId}/docs/tasks.json - the machine-readable build plan the implementation workflow executes. Strict JSON, no comments, no trailing commas, exactly this shape:
{ "version": 1, "tasks": [ { "id": "T-1", "title": "<imperative, one line>", "depends_on": [], "files": ["force-app/main/default/classes/Example.cls"], "change": "<the mechanism - what edit, where>", "test_scenarios": ["<case>"], "traces": ["REQ-001", "AC-1"], "status": "pending" } ] }
Rules: ids sequential from T-1; every task lists the project-relative files it touches and traces to at least one REQ or AC; depends_on names only earlier tasks; no cycles; one component plus its test class per task; order is safe deployment order. Take file paths from the design's EVIDENCE where it names them - guess a path only when the design gives none, and follow this project's existing folder layout when you do.

Do not contradict the approved design. Where you need precision it does not give, add it; where it already decided something, cite it rather than re-deciding.

The Mermaid block must be valid erDiagram syntax - every relationship line has both entities and a label - with no styling directives.

APPROVED UX DESIGN: if .dhruva/runs/{runId}/docs/ux-design.md exists, read it completely and incorporate it fully (when UX is disabled for this project the file is absent - then skip this paragraph). The TDD gains a 'UI Components' section carrying every UX-n block, and the tasks file gets one task per UX component (files under force-app/main/default/lwc/..., traces include the UX-n id AND its REQ id).
