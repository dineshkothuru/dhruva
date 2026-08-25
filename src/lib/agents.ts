/** Agent adapter registry — each entry describes how to probe and run one
 * coding-agent CLI inside the attached project. The user's own machine login
 * (GitHub / Claude / ChatGPT) is used; no keys pass through this app. */

export type AgentId = "copilot" | "claude" | "codex";

export interface AgentDef {
  id: AgentId;
  label: string;
  /** Command probed with --version to detect installation. */
  bin: string;
  /** Selectable model ids for the dropdown; "" means the CLI's default.
   * Org policies can disable a CLI's default model, so letting the user pick
   * an allowed one matters (e.g. Copilot policy: only Sonnet 5 / Opus 5). */
  models: { id: string; label: string }[];
  /** Build the CLI invocation. `viaStdin` prompts are written to the child's
   * stdin (no shell-quoting risk); otherwise the sanitized prompt is inlined. */
  build: (prompt: string, model?: string) => { args: string[]; viaStdin: boolean };
  installHint: string;
}

/** Model ids reach the shell as CLI args — allow only plain token shapes. */
export function isSafeModelId(v: unknown): v is string {
  return typeof v === "string" && /^[A-Za-z0-9._-]{1,60}$/.test(v);
}

/** Inline prompts pass through cmd.exe (shell:true is required to resolve
 * .cmd shims on Windows), so shell-significant characters are replaced.
 * Task prompts survive this fine; stdin-capable agents skip it entirely. */
export function sanitizeInline(prompt: string): string {
  return prompt
    .replace(/[\r\n]+/g, " ")
    .replace(/"/g, "'")
    .replace(/[%^&|<>`$]/g, " ")
    .slice(0, 4000);
}

export const AGENTS: Record<AgentId, AgentDef> = {
  copilot: {
    id: "copilot",
    label: "GitHub Copilot",
    bin: "copilot",
    models: [
      { id: "claude-sonnet-5", label: "Claude Sonnet 5" },
      { id: "claude-opus-5", label: "Claude Opus 5" },
      { id: "auto", label: "Auto (Copilot picks)" },
      { id: "gpt-5.4", label: "GPT-5.4" },
      { id: "gemini-3.0-pro", label: "Gemini 3.0 Pro" },
    ],
    // --allow-all-tools: the agent may edit files and run commands inside the
    // attached project; the harness user asked it to do the task.
    // --model matters because org policy can disable the CLI's default model
    // (startup then fails with "access denied by policy").
    build: (prompt, model) => ({
      args: [
        "-p",
        `"${sanitizeInline(prompt)}"`,
        "--allow-all-tools",
        ...(model ? ["--model", model] : []),
      ],
      viaStdin: false,
    }),
    installHint: "npm i -g @github/copilot, then run `copilot` once to log in",
  },
  claude: {
    id: "claude",
    label: "Claude Code",
    bin: "claude",
    models: [
      { id: "", label: "Default" },
      { id: "sonnet", label: "Sonnet" },
      { id: "opus", label: "Opus" },
      { id: "haiku", label: "Haiku" },
    ],
    // -p reads the prompt from stdin; acceptEdits lets it write files without
    // interactive approval while still refusing arbitrary commands.
    build: (_prompt, model) => ({
      args: ["-p", "--permission-mode", "acceptEdits", ...(model ? ["--model", model] : [])],
      viaStdin: true,
    }),
    installHint: "npm i -g @anthropic-ai/claude-code, then run `claude` once to log in",
  },
  codex: {
    id: "codex",
    label: "OpenAI Codex",
    bin: "codex",
    models: [
      { id: "", label: "Default" },
      { id: "gpt-5.4-codex", label: "GPT-5.4 Codex" },
    ],
    // `codex exec -` reads the task from stdin; sandboxed auto mode.
    build: (_prompt, model) => ({
      args: ["exec", "--full-auto", ...(model ? ["-m", model] : []), "-"],
      viaStdin: true,
    }),
    installHint: "npm i -g @openai/codex, then run `codex` once to log in",
  },
};

export function isAgentId(v: unknown): v is AgentId {
  return v === "copilot" || v === "claude" || v === "codex";
}
