import path from "node:path";
import { spawn } from "node:child_process";
import { AGENTS, isAgentId, isSafeModelId } from "@/lib/agents";
import { isAttachableRoot } from "@/lib/fsguard";
import { takeSnapshot } from "@/lib/snapshot";
import { hasActiveRun } from "@/lib/workflows/engine";

export const maxDuration = 800;

const RUN_TIMEOUT_MS = 10 * 60 * 1000;

/** Run ONE whitelisted coding-agent CLI (GitHub Copilot / Claude Code /
 * OpenAI Codex — see AGENTS) inside the attached Salesforce project and
 * stream its output to the chat pane.
 *
 * Guards: the binary comes from the AGENTS whitelist (never caller input),
 * the cwd must be an attached SFDX project (isAttachableRoot), and the
 * prompt is length-capped (and shell-sanitized for inline agents).
 *
 * POST {root, agent, prompt} → text/plain chunked stream of the CLI output. */
export async function POST(req: Request) {
  let body: {
    root?: unknown;
    agent?: unknown;
    prompt?: unknown;
    model?: unknown;
    attachments?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return new Response("Invalid JSON body", { status: 400 });
  }

  const root = typeof body.root === "string" ? path.normalize(body.root.trim()) : "";
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (!root || !(await isAttachableRoot(root))) {
    return new Response("not an attached Salesforce project", { status: 400 });
  }
  if (!isAgentId(body.agent)) {
    return new Response("unknown agent", { status: 400 });
  }
  if (!prompt || prompt.length > 8000) {
    return new Response("prompt required (max 8000 chars)", { status: 400 });
  }

  // attachments: harness-saved files only (.sfharness/attachments/*), never
  // arbitrary caller paths
  const attachments = (Array.isArray(body.attachments) ? body.attachments : [])
    .filter(
      (a): a is string =>
        typeof a === "string" &&
        /^\.sfharness\/attachments\/[A-Za-z0-9._-]+$/.test(a.replace(/\\/g, "/")),
    )
    .slice(0, 8);

  const def = AGENTS[body.agent];
  const model = isSafeModelId(body.model) ? body.model : undefined;
  const fullPrompt =
    attachments.length > 0
      ? `${prompt}\n\nAttached files (read them from the project root): ${attachments.join(", ")}`
      : prompt;
  const { args, viaStdin } = def.build(fullPrompt, model);
  if (body.agent === "copilot") {
    // Copilot has native attachment support (images/documents)
    for (const a of attachments) args.push("--attachment", `"${a}"`);
  }

  // Baseline snapshot so the review layer can show exactly what this run
  // changed — deterministic, works for projects without git. Skipped while a
  // workflow run is active for this project: re-baselining mid-run (e.g. at a
  // gate) would erase that run's pending diff.
  if (!hasActiveRun(root)) await takeSnapshot(root);

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      // shell:true only resolves the npm .cmd shims on Windows; the command
      // and args are entirely harness-built (whitelist + sanitizer).
      const child = spawn(def.bin, args, {
        cwd: root,
        shell: true,
        windowsHide: true,
        env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0", CI: "true" },
      });

      const timer = setTimeout(() => {
        controller.enqueue(encoder.encode("\n[harness] task timed out after 10 minutes\n"));
        child.kill();
      }, RUN_TIMEOUT_MS);

      // EPIPE (CLI exits before draining, e.g. expired login) must not crash
      child.stdin.on("error", () => {});
      if (viaStdin) child.stdin.write(fullPrompt);
      child.stdin.end();

      const push = (chunk: Buffer) => {
        try {
          controller.enqueue(
            encoder.encode(chunk.toString("utf8").replace(/\x1b\[[0-9;]*m/g, "")),
          );
        } catch {
          /* stream already closed by the client */
        }
      };
      child.stdout.on("data", push);
      child.stderr.on("data", push);

      child.on("error", (e) => {
        clearTimeout(timer);
        try {
          controller.enqueue(
            encoder.encode(`\n[harness] could not start ${def.bin}: ${e.message}\n`),
          );
          controller.close();
        } catch {}
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        try {
          controller.enqueue(encoder.encode(`\n[harness] ${def.label} finished (exit ${code})\n`));
          controller.close();
        } catch {}
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-cache",
      "X-Accel-Buffering": "no",
    },
  });
}
