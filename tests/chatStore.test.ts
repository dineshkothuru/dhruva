import { describe, expect, it } from "vitest";
import { isEmptyThread, threadTitle, type StoredMsg } from "@/lib/chatStore";

const msg = (role: string, text: string): StoredMsg => ({ role, text });
const convo = (q = "how does sharing work?") => [msg("user", q), msg("agent", "Like so.")];

/** Threads are files under .dhruva/chats and are never deleted; these cover
 * the shared naming and emptiness rules both sides rely on. */
describe("threadTitle", () => {
  it("names a thread by the question that started it", () => {
    expect(threadTitle(convo())).toBe("how does sharing work?");
  });

  it("uses the first LINE only, so a pasted wall does not become the title", () => {
    expect(threadTitle([msg("user", "first line\nsecond line")])).toBe("first line");
  });

  it("truncates a very long question", () => {
    const t = threadTitle([msg("user", "x".repeat(200))]);
    expect(t.length).toBeLessThanOrEqual(61);
    expect(t.endsWith("…")).toBe(true);
  });

  it("falls back when the user never spoke", () => {
    expect(threadTitle([msg("agent", "unprompted")])).toBe("Untitled chat");
  });
});

describe("isEmptyThread", () => {
  it("treats system and proposal rows as not-a-conversation", () => {
    expect(isEmptyThread([msg("system", "an error"), msg("proposal", "")])).toBe(true);
  });
  it("sees a real exchange", () => {
    expect(isEmptyThread(convo())).toBe(false);
  });
});

describe("what gets written to disk", () => {
  it("refuses to write a thread with no real dialogue", () => {
    expect(isEmptyThread([msg("system", "connection error")])).toBe(true);
    expect(isEmptyThread([msg("proposal", ""), msg("changes", "2 files")])).toBe(true);
  });

  it("writes a thread as soon as one exchange exists", () => {
    expect(isEmptyThread(convo())).toBe(false);
  });
});
