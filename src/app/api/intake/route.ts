import path from "node:path";
import { spawn } from "node:child_process";
import { AGENTS, isAgentId } from "@/lib/agents";
import { isAttachableRoot } from "@/lib/fsguard";
import { buildIntakePrompt, parseIntakeReply, type IntakeCandidate } from "@/lib/intakeLlm";
import { builtinWorkflows } from "@/lib/workflows/builtins";
import { listCustomWorkflows } from "@/lib/workflows/custom";

export const maxDuration = 120;

/** One short read-only agent call to route a chat message to the right
 * workflow(s). Runs on the LIGHT tier: this is a routing decision, not the
 * work, and it sits in front of the user pressing Send.
 *
 * The catalog is built HERE, server-side, and the model's answer is validated
 * against it - the client never supplies the list of runnable workflows.
 *
 * POST {root, agent, text, attachments} -> {workflows:[{workflow,title}], reason}
 * or {workflows: []} when this reads like a question. Any failure returns 204
 * so the client silently falls back to the deterministic classifier. */
const TIMEOUT_MS = 60_000;

export async function POST(req: Request) {
  let body: { root?: unknown; agent?: unknown; text?: unknown; attachments?: unknown };
  try {
    body = await req.json();
  } catch {
    return new Response("Invalid JSON body", { status: 400 });
  }

  const root = typeof body.root === "string" ? path.normalize(body.root.trim()) : "";
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!root || !(await isAttachableRoot(root))) {
    return new Response("not an attached Salesforce project", { status: 400 });
  }
  if (!isAgentId(body.agent)) return new Response("unknown agent", { status: 400 });
  if (!text) return new Response("text required", { status: 400 });

  // attachment NAMES only, for intent - the router never reads the files
  const attachments = (Array.isArray(body.attachments) ? body.attachments : [])
    .filter((a): a is string => typeof a === "string")
    .map((a) => a.replace(/\\/g, "/").split("/").pop() ?? "")
    .filter(Boolean)
    .slice(0, 8);

  let catalog: IntakeCandidate[] = [];
  try {
    const builtins = Object.values(await builtinWorkflows());
    const customs = await listCustomWorkflows(root).catch(() => []);
    catalog = [
      ...builtins.map((w) => ({ id: w.id, title: w.title, description: w.description })),
      ...customs.map(({ def: w }) => ({
        id: w.id,
        title: w.title,
        description: w.description,
        custom: true,
      })),
    ];
  } catch {
    return new Response(null, { status: 204 }); // no catalog, no routing
  }
  if (catalog.length === 0) return new Response(null, { status: 204 });

  const def = AGENTS[body.agent];
  // routing is a cheap decision, never worth the design/review tier
  const model = def.tiers.light || undefined;
  const prompt = buildIntakePrompt(text, attachments, catalog);
  const { args, viaStdin } = def.build(prompt, model, true);

  const raw = await new Promise<string>((resolve) => {
    let out = "";
    let done = false;
    const finish = (v: string) => {
      if (!done) {
        done = true;
        resolve(v);
      }
    };
    // shell:true only resolves the npm .cmd shims on Windows; bin and args are
    // harness-built (whitelist + sanitizer), never caller input
    const child = spawn(def.bin, args, {
      cwd: root,
      shell: true,
      windowsHide: true,
      env: {
        ...process.env,
        NO_COLOR: "1",
        FORCE_COLOR: "0",
        CI: "true",
        // cmd.exe searches the CURRENT DIRECTORY before PATH on Windows, and
        // cwd is the attached (untrusted) project - a planted claude.cmd/
        // copilot.cmd would run on the first chat message. Same fix as the
        // engine's spawn (spawnStep.ts).
        NoDefaultCurrentDirectoryInExePath: "1",
      },
    });
    const timer = setTimeout(() => {
      if (child.pid) spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { shell: false });
      child.kill();
      finish("");
    }, TIMEOUT_MS);
    child.stdin.on("error", () => {});
    if (viaStdin) child.stdin.write(prompt);
    child.stdin.end();
    const push = (c: Buffer) => {
      out += c.toString("utf8").replace(/\x1b\[[0-9;]*m/g, "");
    };
    child.stdout.on("data", push);
    child.stderr.on("data", push);
    child.on("error", () => {
      clearTimeout(timer);
      finish("");
    });
    child.on("close", () => {
      clearTimeout(timer);
      finish(out);
    });
  });

  if (!raw.trim()) return new Response(null, { status: 204 }); // CLI missing or timed out
  const parsed = parseIntakeReply(raw, catalog);
  // null = no usable answer; 204 tells the client to use the keyword fallback.
  // {workflows: []} = the model read it and says it is a question, which is an
  // ANSWER - the client honours it and goes straight to chat.
  if (!parsed) return new Response(null, { status: 204 });
  return Response.json(parsed);
}
