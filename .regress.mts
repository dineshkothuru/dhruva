import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";
import { builtinWorkflows } from "./src/lib/workflows/builtins";
import { checkWorkflowSemantics } from "./src/lib/workflows/validate";
import { validateTasks, saveTasks, loadTasks, reopenFromFindings, pendingInOrder } from "./src/lib/workflows/tasks";
import { resumeRun } from "./src/lib/workflows/engine";

let pass = 0, fail = 0;
const ok = (n: string, c: boolean) => { c ? pass++ : (fail++, console.log("FAIL:", n)); };

// workflows still valid after the dash sweep
const w = await builtinWorkflows();
ok("11 workflows valid post-sweep", Object.keys(w).length === 11 && Object.values(w).every(d => checkWorkflowSemantics(d).length === 0));
// no em/en dashes remain in any prompt
ok("no long dashes in prompts", Object.values(w).every(d => d.steps.every(s => !/[\u2013\u2014]/.test(s.prompt ?? "") && !/[\u2013\u2014]/.test(s.message ?? ""))));

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "dhruva-regress-"));
await fs.writeFile(path.join(tmp, "sfdx-project.json"), "{}");
await fs.mkdir(path.join(tmp, "docs"), { recursive: true });
await fs.mkdir(path.join(tmp, ".sfharness", "runs"), { recursive: true });

// bug #8: bold REOPEN + comma-separated ids
const t = validateTasks({ version: 1, tasks: [
  { id: "T-1", title: "a", files: [] }, { id: "T-2", title: "b", files: [] }, { id: "T-3", title: "c", files: [] },
]}).data!;
for (const x of t.tasks) x.status = "completed";
await saveTasks(tmp, "docs/t.json", t);
const r1 = await reopenFromFindings(tmp, "docs/t.json", "**REOPEN T-2: fix the null guard**\nREOPEN T-1, T-3: align boundaries\nVERDICT: BLOCKED");
ok("bold + comma REOPEN reopens all three", r1.sort().join(",") === "T-1,T-2,T-3");
const after = await loadTasks(tmp, "docs/t.json");
ok("bold stripped from comment", after.data!.tasks.find(x => x.id === "T-2")!.reviews![0].comment === "fix the null guard");
ok("all pending again", pendingInOrder(after.data!).length === 3);

// bug #2: dead-run disk resume (status still "running" on disk)
const deadRun = {
  runId: "deadrun123", workflowId: "run-tests", workflowTitle: "Run Apex tests", root: tmp,
  createdAt: 1, status: "running", agent: "claude", inputs: { testLevel: "RunLocalTests" },
  steps: [{ id: "run", title: "run", type: "cli", status: "running", output: "partial" }],
};
await fs.writeFile(path.join(tmp, ".sfharness", "runs", "deadrun123.json"), JSON.stringify(deadRun));
const resumed = await resumeRun(tmp, "deadrun123", {});
ok("dead disk run resumes", resumed !== null && resumed.status === "running");
// bug #4: empty roleModels REPLACES (cleared settings apply)
ok("roleModels cleared on resume", resumed !== null && Object.keys(resumed.roleModels ?? {}).length === 0);

await new Promise(r => setTimeout(r, 1500)); // let the resumed cli run finish/fail quietly
await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
