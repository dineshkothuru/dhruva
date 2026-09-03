import path from "node:path";
import { promises as fs, existsSync } from "node:fs";
import { resolveInside } from "@/lib/fsguard";
import type { RunState } from "./schema";

/** Placeholder expansion and argv construction - the pure text layer of the
 * engine, extracted so the substitution rules can be read (and tested) without
 * the orchestration around them. Everything here treats run inputs and agent
 * output as UNTRUSTED text: single-pass expansion, path containment, and
 * shell-metacharacter stripping are the point, not conveniences. */

export function toPosix(p: string): string {
  return p.split(String.fromCharCode(92)).join("/");
}

/** Fill "{inputs.x}" and "{steps.id.output}" placeholders.
 *
 * A referenced step output is passed WHOLE - no cap. There used to be one, and
 * it kept biting: at 8,000 chars a 15-requirement design produced
 * 4-requirement documents, and raising it to 48,000 only moved the cliff (the
 * largest real design measured 40,728, so 85% of the budget was already gone).
 * Every agent step is a fresh CLI process, so nothing accumulates across steps
 * and there is no context pressure to spend a cap on. */
export function template(text: string, run: RunState, docs?: Map<string, string>): string {
  // ONE pass, one combined pattern. Sequential passes meant a placeholder
  // arriving inside an INPUT VALUE (user text, attachment content) was
  // expanded by a later pass - letting pasted text pull another step's whole
  // transcript into a prompt. Substituted values are never re-scanned now.
  return text.replace(
    /\{runId\}|\{inputs\.([\w-]+)\}|\{steps\.([\w-]+)\.output\}/g,
    (whole, inputKey?: string, stepId?: string) => {
      // {runId} lets a workflow stamp its outputs, so running the same
      // workflow twice produces two designs instead of overwriting the first
      if (whole === "{runId}") return run.runId;
      if (inputKey !== undefined) return String(run.inputs[inputKey] ?? "");
      if (stepId !== undefined) {
        // A step that wrote a document is quoted BY that document. Callers
        // that cannot read files (artifact paths, titles) pass no map and get
        // the previous behaviour exactly.
        const doc = docs?.get(stepId);
        if (doc) return doc;
        const s = run.steps.find((x) => x.id === stepId);
        return s ? s.output : "";
      }
      return whole;
    },
  );
}

/** Load the documents a prompt's `{steps.x.output}` placeholders should resolve
 * to: for every step it quotes that wrote an artifact, that artifact. */
export async function quotedDocs(run: RunState, text: string): Promise<Map<string, string>> {
  const docs = new Map<string, string>();
  for (const m of text.matchAll(/\{steps\.([\w-]+)\.output\}/g)) {
    const rel = run.steps.find((x) => x.id === m[1])?.artifact;
    if (!rel || docs.has(m[1])) continue;
    const abs = resolveInside(run.root, toPosix(rel));
    const body = abs ? await fs.readFile(abs, "utf8").catch(() => "") : "";
    if (body.trim()) docs.set(m[1], body);
  }
  return docs;
}

/** Parse a "FILES: a, b, c" line from agent output into run.affected -
 * project-relative paths only; anything absolute or escaping is dropped. */
export function harvestAffectedFiles(run: RunState, output: string, merge = false) {
  // Line-anchored, LAST occurrence: agents are told to emit the line at the
  // end, so a "FILES:" inside quoted documents or tool traces earlier in the
  // output must not win over the real one.
  const all = [...output.matchAll(/^\s*\**FILES:\s*([^\n]+)/gim)];
  const m = all.length ? all[all.length - 1] : null;
  if (!m) return;
  const files = m[1]
    .split(",")
    .map((f) => f.trim().replace(/\\/g, "/").replace(/^["'`]|["'`]$/g, ""))
    .filter((f) => f && !f.includes("..") && !path.isAbsolute(f) && f.length < 300)
    .slice(0, 30);
  if (!files.length) return;
  // merge: a task LOOP harvests per task over that task's own output segment -
  // replacing would keep only the final task's files and downstream retrieves
  // would refresh a fraction of what the step actually touched
  run.affected = merge
    ? [...new Set([...(run.affected ?? []), ...files])].slice(0, 60)
    : files;
}

/** Expand argv templates. "{changedSourceDirs}" becomes repeated
 * --source-dir <file> pairs for every non-deleted changed file; returns null
 * when the expansion is required but there are no changed files. */
export function expandArgs(argv: string[], run: RunState): string[] | null {
  const out: string[] = [];
  for (const a of argv) {
    if (a === "{changedSourceDirs}") {
      const files = (run.changes ?? []).filter((c) => c.status !== "deleted");
      if (files.length === 0) return null;
      // Refuse, never truncate: silently deploying/validating a SUBSET of a
      // larger change set reports success for work that never shipped. The
      // bound is the real one - command-line length (cmd.exe caps near 8k) -
      // not an arbitrary file count.
      let argChars = 0;
      for (const f of files) argChars += f.file.length + 15;
      if (argChars > 6000) {
        throw new Error(
          `${files.length} changed files exceed the command-line budget for --source-dir - ` +
            `deploy this run manually with a manifest (sf project deploy start -x package.xml)`,
        );
      }
      // file names can be agent-created - sanitize like any templated value
      for (const f of files) out.push("--source-dir", cliSafe(f.file));
    } else if (a === "{affectedSourceDirs}") {
      // Only paths that EXIST locally. --source-dir refreshes a local copy, so
      // a component the design is about to CREATE has nothing to refresh: on an
      // empty project "create a Student object" named files that were not in the
      // org or on disk, sf errored on the missing path, and the run died at the
      // retrieve step before writing a line of metadata.
      const files = (run.affected ?? []).filter((f) => existsSync(path.join(run.root, f)));
      if (files.length === 0) return null;
      for (const f of files.slice(0, 30)) out.push("--source-dir", cliSafe(f));
    } else if (a.startsWith("{flag:")) {
      // "{flag:--synchronous:inputs.key}" → the bare flag only when truthy
      const m = a.match(/^\{flag:([\w-]+):inputs\.([\w-]+)\}$/);
      if (m && run.inputs[m[2]]) out.push(m[1]);
    } else if (a.startsWith("{opt:")) {
      // "{opt:--flag:inputs.key}" → ["--flag", value] only when value non-empty
      const m = a.match(/^\{opt:([\w-]+):inputs\.([\w-]+)\}$/);
      if (m) {
        const v = cliSafe(String(run.inputs[m[2]] ?? "").trim());
        if (v) out.push(m[1], v);
      }
    } else {
      out.push(cliSafe(template(a, run)));
    }
  }
  return out;
}

/** Slice a "### REQ-nnn"-structured document to the given ids: kept sections
 * whole, the rest reduced to their heading plus a one-line stub. Used on
 * REVISION rounds only - the frozen requirement list is immutable during a
 * run, so a settled block's section serves no reader until that block reopens
 * (when it does, its id re-enters the closure and the section returns).
 * Anything not REQ-structured is returned untouched. */
export function sliceRequirements(body: string, keep: Set<string>): string {
  const sections = body.split(/(?=^###[ \t]+REQ-\d+)/m);
  if (sections.length < 3) return body; // not REQ-structured - never slice
  let dropped = 0;
  const parts = sections.slice(1).map((sec) => {
    const id = sec.match(/^###[ \t]+(REQ-\d+)/)?.[1];
    if (!id || keep.has(id)) return sec;
    dropped++;
    const title = sec.split("\n")[0].trimEnd();
    return `${title}\n(settled in the design and unrelated to this round - full text in the frozen requirements document)\n\n`;
  });
  return dropped === 0 ? body : sections[0] + parts.join("");
}

/** User-provided values that end up in argv must never carry shell
 * metacharacters (args pass through cmd.exe to resolve .cmd shims). */
export function cliSafe(v: string): string {
  return v.replace(/["'`^&|<>%$;\r\n\t]/g, " ").trim();
}

/** Args pass through cmd.exe (shell:true resolves .cmd shims) - quote paths
 * with spaces; templates never contain quotes (whitelisted argv, not shell). */
export function winQuote(a: string): string {
  return /[\s&|^<>%()]/.test(a) && !a.startsWith('"') ? `"${a}"` : a;
}
