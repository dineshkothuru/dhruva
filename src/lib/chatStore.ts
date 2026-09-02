/** Chat thread storage.
 *
 * Threads live on disk under <project>/.dhruva/chats, beside the run audit -
 * so they survive a cleared browser, travel with the project, and are as
 * inspectable as everything else the harness records. Nothing is ever
 * deleted: "New chat" simply starts a new file.
 *
 * These helpers are pure so they can be tested and shared by both sides. */

export interface StoredMsg {
  role: string;
  text: string;
  [k: string]: unknown;
}

export interface ChatThread {
  id: string;
  endedAt: number;
  title: string;
  messages: StoredMsg[];
}

/** A message may arrive from the client (or a hand-edited thread file) with a
 * non-string text - never let that TypeError into a route. */
function textOf(m: StoredMsg): string {
  return typeof m.text === "string" ? m.text : "";
}

/** A thread is named by the question that started it. */
export function threadTitle(messages: StoredMsg[]): string {
  const first = messages.find((m) => m.role === "user" && textOf(m).trim());
  if (!first) return "Untitled chat";
  const line = textOf(first).trim().split("\n")[0];
  return line.length > 60 ? `${line.slice(0, 60)}…` : line;
}

/** Nothing worth keeping: no real dialogue happened. */
export function isEmptyThread(messages: StoredMsg[]): boolean {
  return !messages.some((m) => (m.role === "user" || m.role === "agent") && textOf(m).trim());
}
