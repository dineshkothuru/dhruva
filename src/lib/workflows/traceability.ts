import path from "node:path";
import { promises as fs } from "node:fs";

/** Requirement coverage, counted rather than judged.
 *
 * A design is supposed to have a REQ block for every requirement in the source
 * document. Nothing checked that. `coverage-check` verifies REQ blocks reached
 * the HLD and TDD - the other direction - and the reviewer is asked whether any
 * requirement is missing, but by opinion, with no list to count against.
 *
 * Measured on three runs of the SAME byte-identical BRD, the design came back
 * with 11, then 16, then 15 requirements. The document declares 3 user stories
 * with AC1..AC5 each, so none of those numbers is wrong exactly - the prompt
 * says "extract EVERY distinct requirement" without ever saying what a
 * requirement IS, so the model picks the granularity and picks differently each
 * time. What nobody could tell was whether anything had been dropped.
 *
 * The BRD numbers itself, so this is arithmetic: pull US-n and its ACn out of
 * the document, pull the BRD-REF lines out of the design, and report which
 * units no block claims. Deterministic, no tokens, and it fails on a fact. */

export interface Coverage {
  /** every unit found in the source document, e.g. "US-2 AC4" */
  units: string[];
  /** units no BRD-REF line claims */
  uncited: string[];
}

const STORY_OPENER = /^\*{0,2}(US-\d+)\s*:/;
const TOC_ROW = /\t\s*\d+\s*$/;
const AC_TOKEN = /\bAC(\d+)\b/g;

/** Units the document declares.
 *
 * A story OPENS only on its own heading - "US-2: <title>" at the start of a
 * line. Any mention of US-n used to move the pointer, so a table-of-contents
 * row ("US-2: Publish an event<tab>7") or a cross-reference ("see US-2") stole
 * the ACs that followed. Measured on a real BRD that filed US-1 AC5 under US-2,
 * which then read as a missing requirement. */
export function brdUnits(doc: string): string[] {
  const out: string[] = [];
  // Set membership, not out.includes(): the input is an attached document's
  // extracted text, and includes() inside the per-token loop is
  // O(occurrences × distinct units) - a degenerate BRD with a million tokens
  // hung the (single-threaded) server for hours.
  const seen = new Set<string>();
  const push = (u: string) => {
    if (!seen.has(u)) {
      seen.add(u);
      out.push(u);
    }
  };
  let story = "";
  for (const raw of doc.split(/\r?\n/)) {
    const line = raw.trim();
    const opener = line.match(STORY_OPENER);
    if (opener && !TOC_ROW.test(raw)) {
      story = opener[1];
      push(story);
    }
    for (const m of line.matchAll(AC_TOKEN)) {
      push(story ? `${story} AC${m[1]}` : `AC${m[1]}`);
    }
  }
  return out;
}

/** Which units the design's BRD-REF lines claim. A reference may name a range
 * ("AC2-AC5", "AC2-AC4") or a list ("AC2, AC3, AC5"), and a story reference
 * with no AC claims that story only. */
export function citedUnits(design: string): Set<string> {
  const cited = new Set<string>();
  for (const line of design.split(/\r?\n/)) {
    if (!/^BRD-REF:/i.test(line.trim())) continue;
    const stories = [...line.matchAll(/\bUS-(\d+)\b/g)].map((m) => `US-${m[1]}`);
    if (stories.length === 0) continue;
    for (const s of stories) cited.add(s);
    const story = stories[0];
    // ranges first, then any remaining single ACs
    for (const r of line.matchAll(/\bAC(\d+)\s*[-–—]\s*AC?(\d+)\b/g)) {
      const from = Number(r[1]);
      const to = Number(r[2]);
      // The design text is LLM output - "AC1-AC999999999" must not expand to a
      // billion Set.adds. No real BRD has hundreds of ACs on one story; a range
      // wider than that is a hallucination, clamped rather than obeyed.
      const lo = Math.min(from, to);
      const hi = Math.min(Math.max(from, to), lo + 500);
      for (let n = lo; n <= hi; n++) {
        cited.add(`${story} AC${n}`);
      }
    }
    for (const m of line.matchAll(/\bAC(\d+)\b/g)) cited.add(`${story} AC${m[1]}`);
  }
  return cited;
}

export function coverageOf(doc: string, design: string): Coverage {
  const units = brdUnits(doc);
  const cited = citedUnits(design);
  return { units, uncited: units.filter((u) => !cited.has(u)) };
}

/** The extracted source documents a run's requirement text points at.
 *
 * Only the harness's own attachment folders, and only the deterministic
 * .extracted.md - never the binary, never a caller-supplied path. Both
 * locations are matched because a run adopts its files when it starts: the
 * recorded requirement says .dhruva/tmp/attachments before that and
 * .dhruva/runs/<runId>/attachments after. */
export function attachmentPaths(requirement: string): string[] {
  // the third alternative is the pre-move flat folder, so resuming a run
  // recorded before the layout changed still finds its source document
  const re =
    /\.dhruva\/(?:tmp\/attachments|runs\/[A-Za-z0-9-]+\/attachments|attachments)\/[A-Za-z0-9._-]+/g;
  return [
    ...new Set(
      (requirement.match(re) ?? [])
        .map((p) => p.replace(/\\/g, "/"))
        .filter((p) => p.endsWith(".extracted.md")),
    ),
  ];
}

/** Read the run's source documents and report what the design leaves unclaimed.
 * Returns null when there is no source document to check against, so a run
 * without attachments behaves exactly as before. */
export async function checkCoverage(
  root: string,
  requirement: string,
  design: string,
): Promise<Coverage | null> {
  const rels = attachmentPaths(requirement);
  if (rels.length === 0) return null;
  let doc = "";
  for (const rel of rels) {
    doc += (await fs.readFile(path.join(root, rel), "utf8").catch(() => "")) + "\n";
  }
  if (!doc.trim()) return null;
  const cov = coverageOf(doc, design);
  return cov.units.length === 0 ? null : cov;
}
