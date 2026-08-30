---
id: requirements
title: Extract the requirement list from the source documents (read-only)
type: agent
role: read
readOnly: true
orgAware: false
skipIf: requirementsFile
timeoutMinutes: 30
artifact: .dhruva/runs/{runId}/docs/requirements.md
---
Read the source documents and extract the requirement list. Do NOT design anything, do not inventory the codebase, and do not modify any files.

This list is written ONCE and then frozen. Every later step cites these ids: the design produces one block per REQ id, the reviewer checks coverage against this list, and the documents trace back to it. Nothing downstream re-reads the source document, so a requirement you leave out here is a requirement that never gets built.

That is also why the ids must never move. The same source document has produced 11, then 16, then 15 requirements across three runs of the old pipeline, because nobody ever wrote down what a requirement WAS. You are writing that down.

Binary attachments (.docx/.pdf) cannot be read directly - when one is referenced, read the extracted sibling file <same-name>.extracted.md instead (created at upload); only report a document unreadable if no extracted sibling exists.

Read EVERY attached document in full - every page and line, continuing in chunks with offsets until the end of each file. A list built from a partially read document is invalid; if a document cannot be fully read, say so explicitly instead of proceeding.

Requirement:
{inputs.requirement}

## Scope: what the requirement text says, wins

The text above is the person's instruction, and it OUTRANKS the "extract everything" rules below. If it narrows the job - "only user stories 1 and 2", "just Feature 4", "ignore the integration sections, that system is not built yet", "skip anything to do with reporting" - then obey it exactly:

- Extract ONLY what is in scope. Number it normally from REQ-001; the ids describe this run, not the document.
- **Record what you left out, and why.** Close the list with an `## EXCLUDED` section naming each part of the document you did not extract and the instruction that excluded it. Something deliberately out of scope must never look like something you missed - a later reader, and the coverage check, both need to tell the difference.
- Do not narrow the scope on your own. Only an explicit instruction takes something out; a section that merely looks difficult, incomplete, or out of date stays in.
- If the instruction is ambiguous about a section, keep the section and note the ambiguity in its `OPEN:` line rather than guessing.

Where the text says nothing about scope, extract the whole document as described below.

Output a title line, then ONE BLOCK PER REQUIREMENT, in the source document's own order, formatted exactly:

### REQ-001: <short title, in the document's own words>
SOURCE: <where it comes from: feature / user story / section and page>
ASKS:
- AC1: <the acceptance criterion, in the document's wording>
- AC2: <...>
OPEN: <a decision the document itself leaves undecided ("to be finalized during development"), or '-'>

Rules:
- Number sequentially from REQ-001 with no gaps.
- One block per distinct ask. Do not merge unrelated asks to keep the list short, and do not split one ask into several to make it look thorough.
- List EVERY acceptance criterion the document states, each on its own AC line, using the document's wording rather than your paraphrase. These are what the design is later checked against, one by one.
- Use the document's EXACT names for user-facing actions, labels and fields. A renamed label is a scope change, and it will be built the way you write it here.
- Carry an undecided decision into OPEN rather than settling it. You are recording the requirement, not choosing the solution.
- Where the document assigns work to another system, say so in the block instead of dropping it - it is a requirement about a boundary, and the design has to acknowledge it.
- Do not add requirements the document does not state, and do not judge whether anything is already built. That is the design step's job, against the codebase.
- Do not raise setup or deployment actions. You have not seen this org, so you cannot know whether a site is already published, a permission set already exists, or a mapping table is already loaded. The design step reads the codebase and raises those; a checklist written from the document alone sends the customer work they have already done.

Close with one line: `TOTAL: <n> requirements, <m> acceptance criteria.` - counting what is IN scope.

Then, only if the requirement text narrowed the job, the exclusions:

## EXCLUDED
- <the feature, user story or section left out> - <the instruction that excluded it>

Everything downstream treats this list as the whole job: the design produces one block per REQ id here, the reviewer checks coverage against it, and the documents trace back to it. Nothing re-reads the source document. So a section you exclude is genuinely not designed, not built, and not costed - which is exactly right when it was asked for, and a silent hole when it was not.
