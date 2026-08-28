import { describe, expect, it } from "vitest";
import { workRemaining, WORK_INSTRUCTION } from "@/lib/workflows/workRemaining";

/** A feature-dev run for "create a Student object" was reported as FAILED
 * having done nothing wrong. An earlier run had already built the object, its
 * fields, the permission set and the tests, so the implement agent correctly
 * reported PRODUCED: nothing, the change set was empty, and the run then died
 * at the check-only deploy with "no changed files to act on".
 *
 * Failing was the visible bug; running implement at all was the real one. The
 * design phase already knows what exists and what is missing, so that is where
 * the run should stop. This is the counter that decides. */

function req(id: string, status: string): string {
  return [`${id}: Something`, `STATUS: ${status}`, "ALREADY-PRESENT: x", "PENDING: -", ""].join(
    "\n",
  );
}

describe("reading a design for remaining work", () => {
  it("says none when every requirement is already implemented", () => {
    const design = req("REQ-001", "ALREADY IMPLEMENTED") + req("REQ-002", "ALREADY IMPLEMENTED");
    const r = workRemaining(design);
    expect(r.verdict).toBe("none");
    expect(r.total).toBe(2);
    expect(r.satisfied).toBe(2);
  });

  it("says some when a single requirement still carries work", () => {
    const design =
      req("REQ-001", "ALREADY IMPLEMENTED") + req("REQ-002", "NEW") + req("REQ-003", "PARTIAL");
    const r = workRemaining(design);
    expect(r.verdict).toBe("some");
    expect(r.pendingIds).toEqual(["REQ-002", "REQ-003"]);
  });

  // PARTIAL means work remains, however small. Treating it as satisfied is how
  // a hardening task or a missing test would silently never get built.
  it("treats PARTIAL as work remaining", () => {
    expect(workRemaining(req("REQ-001", "PARTIAL")).verdict).toBe("some");
  });

  it("reads the single-line contract when there are no requirement blocks", () => {
    expect(workRemaining("some spec text\nWORK-REMAINING: NONE\n").verdict).toBe("none");
    expect(workRemaining("some spec text\nWORK-REMAINING: SOME\n").verdict).toBe("some");
  });

  it("accepts the line when a model has bolded it", () => {
    expect(workRemaining("**WORK-REMAINING**: NONE").verdict).toBe("none");
  });

  // The most important property in the file. A design with no status structure
  // must never read as "nothing to do" - that would end runs at random.
  it("returns unknown rather than none when the design says neither", () => {
    const r = workRemaining("A spec with no statuses and no contract line at all.");
    expect(r.verdict).toBe("unknown");
    expect(r.basis).toContain("neither");
  });

  it("returns unknown for empty or missing input", () => {
    expect(workRemaining("").verdict).toBe("unknown");
    expect(workRemaining(undefined as unknown as string).verdict).toBe("unknown");
  });

  // Prose is not a status. Only a line that IS the status counts.
  it("ignores the phrase when it appears mid-sentence", () => {
    const r = workRemaining("This is ALREADY IMPLEMENTED in another org, so REQ-001: applies.");
    expect(r.verdict).toBe("unknown");
  });

  it("counts use-case ids as well as requirement ids", () => {
    const design = req("UC-1", "ALREADY IMPLEMENTED") + req("UC-E1", "ALREADY IMPLEMENTED");
    const r = workRemaining(design);
    expect(r.verdict).toBe("none");
    expect(r.total).toBe(2);
  });

  // Per-item statuses are stronger evidence than a summary line. When they
  // disagree, the cautious reading wins: a wrong "none" ends the run and the
  // work never happens, while a wrong "some" only costs a pointless step.
  it("prefers the cautious reading when the line contradicts the items", () => {
    const design = req("REQ-001", "ALREADY IMPLEMENTED") + "\nWORK-REMAINING: SOME\n";
    const r = workRemaining(design);
    expect(r.verdict).toBe("some");
    expect(r.basis).toContain("cautious");
  });

  it("lets the items decide when they name outstanding work", () => {
    const design = req("REQ-001", "NEW") + "\nWORK-REMAINING: NONE\n";
    expect(workRemaining(design).verdict).toBe("some");
  });
});

describe("the instruction that produces the contract", () => {
  // One source: the prompt text and the parser must not drift apart.
  it("names the exact line and both allowed values", () => {
    expect(WORK_INSTRUCTION).toContain("WORK-REMAINING: NONE | SOME");
    expect(workRemaining("WORK-REMAINING: NONE").verdict).toBe("none");
    expect(workRemaining("WORK-REMAINING: SOME").verdict).toBe("some");
  });

  it("tells the model which way to err", () => {
    expect(WORK_INSTRUCTION).toContain("When in");
    expect(WORK_INSTRUCTION).toContain("SOME");
  });
});
