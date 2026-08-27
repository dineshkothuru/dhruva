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

/** A thread is named by the question that started it. */
export function threadTitle(messages: StoredMsg[]): string {
  const first = messages.find((m) => m.role === "user" && m.text.trim());
  if (!first) return "Untitled chat";
  const line = first.text.trim().split("\n")[0];
  return line.length > 60 ? `${line.slice(0, 60)}…` : line;
}

/** Nothing worth keeping: no real dialogue happened. */
export function isEmptyThread(messages: StoredMsg[]): boolean {
  return !messages.some((m) => (m.role === "user" || m.role === "agent") && m.text.trim());
}
