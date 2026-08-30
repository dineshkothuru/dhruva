---
id: design-to-docs.design-in
title: Take in the approved design (read-only)
type: agent
role: read
readOnly: true
orgAware: false
skipIf: designFile
timeoutMinutes: 20
artifact: .dhruva/runs/{runId}/docs/design.md
---
You are being given a design that has ALREADY been made and signed off. Your only job is to put it into the shape the documents step reads. Do not design anything, do not judge the design, do not add or remove requirements, and do not modify any files.

Normally this step does not run at all: when the person names an approved design file, the engine adopts it directly and nothing is spent here. You are running because no such file was named, so the design arrived as prose - pasted text, an attachment, an older document - and it has to be normalised first.

Binary attachments (.docx/.pdf) cannot be read directly - when one is referenced, read the extracted sibling file <same-name>.extracted.md instead (created at upload); only report a document unreadable if no extracted sibling exists.

Read every attached document in full, in chunks with offsets until the end. A design normalised from a partially read document is a design with requirements missing from it.

The design:
{inputs.design}

Output the design as ONE BLOCK PER REQUIREMENT, wrapped in this fence, with NOTHING else inside it:

=== DESIGN START ===
(the OVERVIEW paragraph if the source has one, then every requirement block)
=== DESIGN END ===

Each block formatted exactly:
### REQ-001: <the requirement's title, in the source's own words>
BRD-REF: <where it comes from, if the source says; '-' if not>
STATUS: ALREADY IMPLEMENTED | PARTIAL | NEW
EVIDENCE: <as the source gives it; '-' if it gives none>
ALREADY-PRESENT: <as the source gives it; '-'>
PENDING: <as the source gives it; '-'>
DESIGN: <the design for this requirement, carried over IN FULL>
EFFORT: <as the source gives it; '-'>
DEPENDS-ON: <REQ-ids or '-'>

Rules that matter more than tidiness:

- **Carry the text over; do not rewrite it.** This design was reviewed and approved as it stands. Summarising a DESIGN field, tightening its wording, or "improving" a decision silently replaces work a human signed with work nobody has seen. Copy it.
- **Keep the ids and their order exactly as the source has them.** If the source numbers its requirements, those numbers ARE the ids. Never renumber, merge or split.
- If the source has no ids, number sequentially from REQ-001 in the source's own order, and say in your outcome summary that you assigned them.
- A field the source does not give is `-`. Do not infer one, and never invent EVIDENCE: a component name you supply here is a claim about an org you have not looked at.
- If a block carries `HUMAN-NOTE:` or `OPEN-CONFIRMED:`, keep that line verbatim. Those are the human's own words and the questions still outstanding; the documents need both.
- If what you were given is not a design at all - a raw requirement list, a BRD, an empty file - STOP and say so plainly instead of designing one. This workflow writes documents from an existing design; it does not produce a design.
