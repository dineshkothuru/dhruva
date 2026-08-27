import { describe, expect, it } from "vitest";
import { reviewFeedback } from "@/lib/findings";

/** The regression this file exists for.
 *
 * A review step's output is the RAW CLI transcript: engine banner, then a long
 * tool trace, and the findings only at the END. The engine used to forward
 * `output.slice(0, 4000)` of it to the step being reworked, so on a real run
 * (reviewer output 25,558 chars, first finding at char 9,936) the reworked step
 * received 4,000 characters of "Read file" lines and not one finding. It
 * changed nothing and the reviewer blocked it again, three rounds running.
 *
 * These tests hold the two properties that prevent it: nothing is dropped from
 * a finding at any size, and the tool trace never reaches the reworked step. */

const traceLines = (n: number) =>
  Array.from(
    { length: n },
    (_, i) => `> Read SomeClass${i}.cls\n  | force-app/main/default/classes/SomeClass${i}.cls\n  | 157 lines read\n`,
  ).join("\n");

const BANNER = `[engine] model requested: claude-opus-5 - shipped default for the "review" role\n`;

/** ~6,000 chars: longer than the old 4,000 cap, so a head-anchored slice would
 * still forward nothing but noise. */
const TRACE = `${BANNER}I'll read the instruction file first.\n\n${traceLines(60)}`;

/** Longer than the 12,000-char tail fallback, so the head really is dropped. */
const LONG_TRACE = `${BANNER}${traceLines(220)}`;

const LONG_PROBLEM = `The callout runs inside the loop. ${"Detail sentence explaining exactly why. ".repeat(150)}`;

const REVIEW =
  `${TRACE}\n` +
  `**F1 (critical) [refs: REQ-006, REQ-007]: Bulk transmission blows the callout limit**\n` +
  `  Where: REQ-006 DESIGN\n` +
  `  Problem: ${LONG_PROBLEM}\n` +
  `  Fix: Batch the Ids and issue one callout per batch.\n\n` +
  `**F2 (nit) [refs: REQ-001]: Flag is never reset to false**\n` +
  `  Where: eventProfileView.js L35\n` +
  `  Problem: The wire only ever sets the flag true.\n` +
  `  Fix: Assign the field value directly.\n\n` +
  `VERDICT: BLOCKED - F1 (critical)\n` +
  `[exit 0]\n`;

describe("reviewFeedback", () => {
  it("forwards every finding, with Where / Problem / Fix intact", () => {
    const fb = reviewFeedback(REVIEW);
    expect(fb).toContain("F1 (critical) [refs: REQ-006, REQ-007]");
    expect(fb).toContain("F2 (nit) [refs: REQ-001]");
    expect(fb).toContain("Where: REQ-006 DESIGN");
    expect(fb).toContain("Fix: Batch the Ids and issue one callout per batch.");
    expect(fb).toContain("Where: eventProfileView.js L35");
  });

  it("caps nothing - a finding longer than the old 4,000 limit survives whole", () => {
    expect(LONG_PROBLEM.length).toBeGreaterThan(4_000);
    expect(reviewFeedback(REVIEW)).toContain(LONG_PROBLEM.trim());
  });

  it("drops the tool trace, which is not information", () => {
    const fb = reviewFeedback(REVIEW);
    expect(fb).not.toContain("[engine] model requested");
    expect(fb).not.toContain("lines read");
  });

  it("leads with the verdict so the reworked step knows it was blocked", () => {
    expect(reviewFeedback(REVIEW).startsWith("VERDICT: BLOCKED")).toBe(true);
  });

  it("would not have survived the old head-slice implementation", () => {
    // the guard itself: the first finding sits beyond the old cap
    expect(REVIEW.indexOf("F1 (critical)")).toBeGreaterThan(4_000);
    expect(REVIEW.slice(0, 4_000)).not.toContain("F1 (critical)");
  });

  it("falls back to the TAIL, not the head, when no finding parses", () => {
    const noFindings = `${LONG_TRACE}\nCOVERAGE: INCOMPLETE - section 4 is missing.\n`;
    expect(noFindings.length).toBeGreaterThan(12_000);
    const fb = reviewFeedback(noFindings);
    // the conclusion at the END survives; the banner at the START is dropped
    expect(fb).toContain("COVERAGE: INCOMPLETE");
    expect(fb).not.toContain("[engine] model requested");
  });

  it("returns the whole output when it is short and unparseable", () => {
    expect(reviewFeedback("COVERAGE: OK")).toBe("COVERAGE: OK");
  });
});
