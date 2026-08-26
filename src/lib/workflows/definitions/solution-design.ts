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
      modelTier: "best",
      readOnly: true,
      persona: "salesforce-architect",
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
      prompt:
        "Write the APPROVED solution design as TWO Markdown documents (create folders if needed). " +
        "These two files are the only ones you may create or modify in this step:\n\n" +
        "1. docs/designs/{inputs.docName}-hld.md — HIGH-LEVEL DESIGN, written for stakeholders and " +
        "review boards: requirement summary, business context, a GAP ANALYSIS table (each " +
        "requirement item: Already implemented / Partial / New, with the existing component named " +
        "as evidence), solution overview and approach " +
        "(declarative vs code and why), architecture at component-group level, data model section " +
        "with a Mermaid er-diagram code block (```mermaid / erDiagram) of new and impacted objects " +
        "with relationships and key fields, integration touchpoints, security model overview, " +
        "impact analysis, risks/assumptions/open questions, effort estimate table.\n\n" +
        "2. docs/designs/{inputs.docName}-tdd.md — TECHNICAL DESIGN DOCUMENT, written for the " +
        "developers who will build it: per component (each apex class, trigger, LWC, flow, object/" +
        "field) — exact API names, purpose, reuse-vs-new decision, method-level design or flow " +
        "outline, key logic/pseudocode where non-trivial, error handling, governor-limit " +
        "considerations, sharing/FLS specifics, deployment order and dependencies, and a test " +
        "strategy section with the test classes/scenarios to write (positive/negative/bulk).\n\n" +
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
      id: "coverage-check",
      title: "Verify the documents cover every requirement (agent, read-only)",
      type: "agent",
      readOnly: true,
      modelTier: "best",
      prompt:
        "Design coverage verification. Do not modify any files.\n" +
        "Read IN FULL: (1) the original requirement text below and every attached document it " +
        "references, (2) docs/designs/{inputs.docName}-hld.md, (3) docs/designs/{inputs.docName}-tdd.md.\n" +
        "Requirement:\n{inputs.requirement}\n\n" +
        "Approved per-requirement design:\n{steps.analyse.output}\n\n" +
        "For EVERY REQ item, report one line:\n" +
        "  REQ-xxx — COVERED (HLD section N / TDD section M) | MISSING FROM DOCS | DIVERGES " +
        "(the docs say something different from the approved design — quote it)\n" +
        "Also flag anything in the docs that has no approved requirement behind it (scope creep).\n" +
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
