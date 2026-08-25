import type { WorkflowDef } from "../schema";

export const SOLUTION_DESIGN: WorkflowDef = {
  id: "solution-design",
  title: "Solution design",
  description:
    "Architect path: analyse a requirement against the existing codebase, gate on the proposed design, then produce HLD + TDD documents (with an ERD) in the project.",
  inputs: [
    {
      key: "requirement",
      label: "Requirement (paste the text; attach documents via chat intake)",
      kind: "text",
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
        "requirement touches. Then propose the design as a structured summary:\n" +
        "1. Solution overview and approach (declarative vs code, and why)\n" +
        "2. Data model: new/changed objects and fields, relationships\n" +
        "3. Components: apex classes, triggers, LWCs, flows to create or modify (name existing ones to reuse)\n" +
        "4. Security: sharing, profiles/permission sets, FLS\n" +
        "5. Impact analysis: existing behavior at risk\n" +
        "6. Risks, assumptions, and open questions\n" +
        "7. Rough effort estimate per component\n" +
        "Keep it reviewable — this summary is what the architect approves before the document is written.",
    },
    {
      id: "approve-design",
      title: "Approve the proposed design",
      type: "gate",
      message:
        "Review the proposed solution design above. On approval the full design document (including the ERD) is written into docs/designs/ in the project.",
    },
    {
      id: "write-doc",
      title: "Write HLD + TDD documents (with ERD)",
      type: "agent",
      prompt:
        "Write the APPROVED solution design as TWO Markdown documents (create folders if needed). " +
        "These two files are the only ones you may create or modify in this step:\n\n" +
        "1. docs/designs/{inputs.docName}-hld.md — HIGH-LEVEL DESIGN, written for stakeholders and " +
        "review boards: requirement summary, business context, solution overview and approach " +
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
        "do not contradict what was approved. Cross-link the two documents at the top of each.",
    },
    { id: "changes", title: "Collect created documents", type: "changes" },
    {
      id: "approve-doc",
      title: "Accept the design document",
      type: "gate",
      message:
        "HLD and TDD are written (open them from the changed-files list or the file tree under docs/designs/). Accept to complete the run.",
    },
  ],
};
