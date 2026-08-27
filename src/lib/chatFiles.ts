import path from "node:path";
import { promises as fs } from "node:fs";
import { isEmptyThread, threadTitle, type StoredMsg } from "@/lib/chatStore";

/** Chat threads on disk: <project>/.dhruva/chats/<id>.json
 *
 * Kept beside the run audit rather than in browser storage, so a cleared
 * browser cannot lose a conversation and a thread is as inspectable as a run.
 * Nothing here deletes: starting a new chat writes a new file. */

const ID_RE = /^[0-9a-z-]{6,40}$/;

export interface ChatThreadFile {
  id: string;
  startedAt: number;
  updatedAt: number;
  title: string;
  messages: StoredMsg[];
}

function dir(root: string) {
  return path.join(root, ".dhruva", "chats");
}

/** Threads newest first, without their bodies - the list only needs headers. */
export async function listChats(
  root: string,
): Promise<Omit<ChatThreadFile, "messages">[]> {
  const out: Omit<ChatThreadFile, "messages">[] = [];
  try {
    for (const f of await fs.readdir(dir(root))) {
      if (!f.endsWith(".json")) continue;
      try {
        const t = JSON.parse(await fs.readFile(path.join(dir(root), f), "utf8")) as ChatThreadFile;
        if (!t?.id) continue;
        out.push({
          id: t.id,
          startedAt: t.startedAt ?? 0,
          updatedAt: t.updatedAt ?? 0,
          title: t.title || "Untitled chat",
        });
      } catch {
        /* a corrupt thread file must not hide the rest */
      }
    }
  } catch {
    /* no chats yet */
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 100);
}

export async function readChat(root: string, id: string): Promise<ChatThreadFile | null> {
  if (!ID_RE.test(id)) return null;
  try {
    return JSON.parse(
      await fs.readFile(path.join(dir(root), `${id}.json`), "utf8"),
    ) as ChatThreadFile;
  } catch {
    return null;
  }
}

/** Write (or update) one thread. A thread with no real dialogue is not
 * written, so an accidental click cannot litter the folder with blanks. */
export async function saveChat(
  root: string,
  id: string,
  messages: StoredMsg[],
): Promise<boolean> {
  if (!ID_RE.test(id) || isEmptyThread(messages)) return false;
  const now = Date.now();
  const existing = await readChat(root, id);
  const thread: ChatThreadFile = {
    id,
    startedAt: existing?.startedAt ?? now,
    updatedAt: now,
    title: threadTitle(messages),
    messages,
  };
  try {
    await fs.mkdir(dir(root), { recursive: true });
    await fs.writeFile(path.join(dir(root), `${id}.json`), JSON.stringify(thread, null, 2), "utf8");
    return true;
  } catch {
    return false;
  }
}
