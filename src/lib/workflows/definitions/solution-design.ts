import type { WorkflowDef } from "../schema";

export const SOLUTION_DESIGN: WorkflowDef = {
  id: "solution-design",
  title: "Solution design",
  description:
    "Architect path: analyse a requirement against the existing codebase, gate on the proposed design, then produce HLD + TDD documents (with an ERD) in the project.",
  inputs: [
    {
      key: "requirement",
      label: "Requirement (paste the text and/or attach documents below)",
      kind: "text",
      attachTo: true,
    },
    { key: "docName", label: "Design document name (file-safe)", kind: "text", default: "solution-design" },
  ],
  steps: [
    { id: "snapshot", title: "Snapshot baseline", type: "snapshot" },
    {
      id: "analyse",
      title: "Analyse requirement against the codebase (architect, read-only)",
      type: "agent",
      modelTier: "default",
      readOnly: true,
      persona: "salesforce-architect",
      timeoutMinutes: 45,
      prompt:
        "A requirement needs a solution design for THIS org's codebase. DO NOT modify any files in this step.\n" +
        "Requirement:\n{inputs.requirement}\n\n" +
        "If the requirement references attached documents (paths under .sfharness/attachments/), " +
        "read EVERY attached document in full — every page/line, continuing in chunks until the end " +
        "of each file — before designing anything. A design based on a partially read requirement " +
        "is invalid.\n\n" +
        "Study the existing codebase first: objects, automation, apex services, LWCs that this " +
        "requirement touches.\n\n" +
        "Then output in EXACTLY this structure (it is machine-parsed into review cards):\n\n" +
        "First a short OVERVIEW paragraph (overall approach, phasing, key risks).\n\n" +
        "Then ONE BLOCK PER REQUIREMENT, in the BRD's sequence, each formatted exactly:\n" +
        "### REQ-001: <short title>\n" +
        "BRD-REF: <section/page in the source document>\n" +
        "STATUS: ALREADY IMPLEMENTED | PARTIAL | NEW\n" +
        "EVIDENCE: <for implemented/partial: the exact existing components, backticked API names>\n" +
        "ALREADY-PRESENT: <what exists today; '-' for NEW>\n" +
        "PENDING: <what is missing; '-' if nothing>\n" +
        "DESIGN: <the solution for exactly this item's PENDING work — components to create/modify " +
        "with API names, declarative vs code and why, security notes. For ALREADY IMPLEMENTED " +
        "items write 'No work required' plus any caveat.>\n" +
        "EFFORT: <rough estimate, e.g. 2d>\n" +
        "DEPENDS-ON: <REQ-ids or '-'>\n\n" +
        "Rules: number sequentially REQ-001, REQ-002…; extract EVERY distinct requirement from the " +
        "text and ALL attached documents — do not merge unrelated asks into one block; be strict on " +
        "STATUS (ALREADY IMPLEMENTED only with concrete component evidence); design ONLY the " +
        "pending work — never redesign what exists; follow the team standards in this prompt.",
    },
    {
      id: "design-review",
      title: "Design critique (best model, read-only) — auto-fixes once before your gate",
      type: "agent",
      modelTier: "best",
      readOnly: true,
      persona: "salesforce-review",
      autoRevise: { target: "analyse", trigger: "VERDICT:\\s*BLOCKED", maxRounds: 1 },
      prompt:
        "You are the DESIGN REVIEWER — adversarially critique the solution design below before a " +
        "human sees it. Do not modify any files.\n\n" +
        "Design under review:\n{steps.analyse.output}\n\n" +
        "Original requirement:\n{inputs.requirement}\n\n" +
        "Check, verifying against the ACTUAL codebase (read the components named as evidence):\n" +
        "1. EVIDENCE is real — every component cited for ALREADY IMPLEMENTED/PARTIAL exists and " +
        "does what is claimed. A wrong claim here is the worst failure mode.\n" +
        "2. STATUS is honest — nothing marked implemented that is only similar.\n" +
        "3. DESIGN covers the full PENDING scope of its requirement, reuses existing components, " +
        "and declarative-vs-code choices are justified.\n" +
        "4. No requirement from the source text/documents is missing a REQ block; dependencies " +
        "and sequencing make sense.\n" +
        "Report findings referencing requirements inline as REQ-xxx (NEVER as '### REQ-' headings " +
        "— those are machine-parsed). End with exactly one line:\n" +
        "VERDICT: APPROVED — or — VERDICT: BLOCKED, followed by the numbered findings to fix.",
    },
    {
      id: "approve-design",
      title: "Review each requirement's design",
      type: "gate",
      reviseTarget: "analyse",
      message:
        "Review each requirement card above (status, evidence, design). Reject/comment per item and Revise — only rejected items are reworked. Approve when every requirement's design is right; the HLD and TDD are then written.",
    },
    {
      id: "write-doc",
      title: "Write HLD + TDD documents (with ERD)",
      type: "agent",
      timeoutMinutes: 30,
      prompt:
        "Write the APPROVED solution design as TWO Markdown documents plus ONE machine-readable " +
        "tasks file (create folders if needed). These three files are the only ones you may create " +
        "or modify in this step:\n\n" +
        "1. docs/designs/{inputs.docName}-hld.md — HIGH-LEVEL DESIGN, written for stakeholders and " +
        "review boards, with EXACTLY these numbered sections:\n" +
        "  1. Context — problem space, constraints, existing system boundaries (only what the " +
        "design needs to stand on its own).\n" +
        "  2. Goals / Non-Goals — what this design achieves, and what it explicitly does NOT do.\n" +
        "  3. Gap Analysis — table of every REQ-xxx: Already implemented / Partial / New, with the " +
        "existing component named as evidence.\n" +
        "  4. Approaches Considered — at least two named approaches with brief description, pros, " +
        "cons; then a Selected Approach subsection stating the choice, its complexity (XS/S/M/L/XL), " +
        "and WHY, referencing the constraints that ruled out the alternatives (declarative vs code " +
        "belongs here).\n" +
        "  5. High-Level Design — architecture overview (how component groups interact) and the key " +
        "abstractions/patterns introduced.\n" +
        "  6. Data Model — Mermaid er-diagram code block (```mermaid / erDiagram) of new and " +
        "impacted objects with relationships and key fields.\n" +
        "  7. Integration Touchpoints and Security Model overview.\n" +
        "  8. Constraints and Trade-offs — what was sacrificed and why that is acceptable.\n" +
        "  9. Acceptance Criteria — 'AC-n: Given <precondition>, when <action>, then <outcome>. " +
        "[traces: REQ-xxx]' — every REQ id with pending work must be traced by at least one AC.\n" +
        "  10. Impact analysis, risks/assumptions, Open Questions, effort estimate table.\n\n" +
        "2. docs/designs/{inputs.docName}-tdd.md — TECHNICAL DESIGN DOCUMENT, written for the " +
        "developers who will build it, with EXACTLY these numbered sections:\n" +
        "  1. Components — per component (each apex class, trigger, LWC, flow, object/field): " +
        "exact API names, purpose/responsibility, inputs/outputs, dependencies, reuse-vs-new " +
        "decision, method-level design or flow outline, key logic/pseudocode where non-trivial.\n" +
        "  2. Data Flow — how data moves through the components end to end.\n" +
        "  3. State Management — what state exists, where it lives, how it changes.\n" +
        "  4. Error Handling — what can fail and how each failure is handled/surfaced.\n" +
        "  5. Governor Limits and Sharing/FLS specifics.\n" +
        "  6. Deployment Order and dependencies.\n" +
        "  7. Test Strategy — the test classes/scenarios to write (positive/negative/bulk). Note: " +
        "Apex tests run in the org, so tests are written WITH the implementation and proven via a " +
        "check-only deploy with RunLocalTests — never promise a run-failing-tests-first cycle.\n" +
        "  8. Build Plan — a short human-readable summary table of the tasks file below " +
        "(T-n | title | depends on | traces). The tasks file is the authority.\n" +
        "  9. Decisions — one line each: Decision -> Rationale -> Consequence.\n" +
        "  10. Open Questions that may affect implementation.\n\n" +
        "3. docs/designs/{inputs.docName}-tasks.json — the MACHINE-READABLE build plan the " +
        "implementation workflow executes task by task. Strict JSON (no comments, no trailing " +
        "commas), exactly this shape:\n" +
        '{ "version": 1, "tasks": [ { "id": "T-1", "title": "<imperative, one line>", ' +
        '"depends_on": [], "files": ["force-app/main/default/classes/Example.cls"], ' +
        '"change": "<the mechanism - what edit, where>", "test_scenarios": ["<case>"], ' +
        '"traces": ["REQ-001", "AC-1"], "status": "pending" } ] }\n' +
        "Rules: ids T-1, T-2… sequential; every task lists the project-relative files it touches " +
        "and traces to at least one REQ/AC; depends_on only references earlier tasks; no cycles; " +
        "one component (plus its test class) per task; order = safe deployment order.\n\n" +
        "Approved design from the analysis step:\n{steps.analyse.output}\n\n" +
        "Incorporate every detail from the approved design; expand where precision is needed but " +
        "do not contradict what was approved. Cross-link the two documents at the top of each.\n\n" +
        "DOCUMENT STYLE (mandatory for both files):\n" +
        "- Plain ASCII punctuation only: use the normal hyphen '-', NEVER em dashes or en dashes, " +
        "and straight quotes, never smart quotes. These documents get pasted into Word and email.\n" +
        "- Start each document with a metadata table: Document, Version (0.1 Draft), Date, Author " +
        "(leave as 'TBD'), Status (Draft for review), and a link to the sibling document.\n" +
        "- Use numbered section headings (1., 1.1) so reviewers can reference sections in feedback.\n" +
        "- Use Markdown tables for the estimate, the component list, and field definitions; " +
        "prose only where explanation is genuinely needed.\n" +
        "- Exact Salesforce API names in backticks everywhere a component is mentioned.\n" +
        "- The Mermaid block must be valid erDiagram syntax (test mentally: every relationship " +
        "line has both entities and a label); no styling directives.\n" +
        "- No filler: every sentence must carry information a reviewer or developer acts on.",
    },
    { id: "changes", title: "Collect created documents", type: "changes" },
    {
      id: "tasks-check",
      title: "Validate the build-plan tasks file (deterministic)",
      type: "tasks-check",
      tasksFile: "docs/designs/{inputs.docName}-tasks.json",
    },
    {
      id: "coverage-check",
      title: "Verify the documents cover every requirement (agent, read-only)",
      type: "agent",
      timeoutMinutes: 30,
      readOnly: true,
      modelTier: "best",
      autoRevise: { target: "write-doc", trigger: "COVERAGE:\\s*INCOMPLETE", maxRounds: 1 },
      prompt:
        "Design coverage verification. Do not modify any files.\n" +
        "Read IN FULL: (1) the original requirement text below and every attached document it " +
        "references, (2) docs/designs/{inputs.docName}-hld.md, (3) docs/designs/{inputs.docName}-tdd.md.\n" +
        "Requirement:\n{inputs.requirement}\n\n" +
        "Approved per-requirement design:\n{steps.analyse.output}\n\n" +
        "For EVERY REQ item, report one line:\n" +
        "  REQ-xxx — COVERED (HLD section N / TDD section M) | MISSING FROM DOCS | DIVERGES " +
        "(the docs say something different from the approved design — quote it)\n" +
        "Also flag anything in the docs that has no approved requirement behind it (scope creep), " +
        "any REQ with pending work that no Acceptance Criterion traces ([traces: REQ-xxx]), and any " +
        "Build Plan task in the TDD that traces to nothing.\n" +
        "Be strict: no section reference = not covered. End with the verdict line: " +
        "COVERAGE: COMPLETE, or COVERAGE: INCOMPLETE — items <REQ-ids>.",
    },
    {
      id: "approve-doc",
      title: "Accept the design documents",
      type: "gate",
      reviseTarget: "write-doc",
      message:
        "Review the coverage verdict above and the documents themselves (docs/designs/). If items are MISSING or DIVERGE, type e.g. 'cover REQ-007 and fix REQ-012' and Revise — the documents are rewritten and re-verified. Accept to complete the run.",
    },
  ],
};
