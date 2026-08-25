"use client";

/** Render sf CLI --json output as readable summaries/tables instead of a raw
 * JSON dump. Recognizes the common shapes (deploy preview, retrieve, deploy/
 * validate results incl. component + test failures); anything unrecognized
 * falls back to the terminal view. Raw JSON stays available for audit. */

interface Row {
  cells: string[];
  bad?: boolean;
}

function Table({ head, rows }: { head: string[]; rows: Row[] }) {
  if (rows.length === 0) return null;
  return (
    <div className="overflow-x-auto rounded-lg border border-slate-200">
      <table className="w-full text-left text-xs">
        <thead>
          <tr className="bg-slate-50 text-[10px] uppercase tracking-wide text-slate-400">
            {head.map((h) => (
              <th key={h} className="px-2.5 py-1.5 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, 100).map((r, i) => (
            <tr key={i} className={`border-t border-slate-100 ${r.bad ? "bg-red-50" : ""}`}>
              {r.cells.map((c, j) => (
                <td key={j} className={`px-2.5 py-1 ${r.bad ? "text-red-700" : "text-slate-600"}`}>
                  {c}
                </td>
              ))}
            </tr>
          ))}
          {rows.length > 100 && (
            <tr className="border-t border-slate-100">
              <td colSpan={head.length} className="px-2.5 py-1 text-slate-400">
                … {rows.length - 100} more
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function Chip({ label, tone }: { label: string; tone: "ok" | "bad" | "info" }) {
  const cls =
    tone === "ok"
      ? "bg-emerald-100 text-emerald-700"
      : tone === "bad"
        ? "bg-red-100 text-red-700"
        : "bg-slate-100 text-slate-600";
  return (
    <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${cls}`}>{label}</span>
  );
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function extractJson(output: string): any | null {
  const start = output.indexOf("{");
  if (start < 0) return null;
  // the JSON blob ends at the last closing brace before trailer lines
  const end = output.lastIndexOf("}");
  if (end <= start) return null;
  try {
    return JSON.parse(output.slice(start, end + 1));
  } catch {
    return null;
  }
}

function Fallback({ output }: { output: string }) {
  return (
    <div className="max-h-72 overflow-y-auto border-t border-slate-100">
      <pre className="whitespace-pre-wrap break-words px-4 py-3 font-mono text-xs text-slate-600">
        {output}
      </pre>
    </div>
  );
}

export default function CliResult({ output }: { output: string }) {
  const parsed = extractJson(output);
  const result = parsed?.result;
  if (!parsed || typeof parsed !== "object" || !result) return <Fallback output={output} />;

  const sections: React.ReactNode[] = [];

  // --- deploy preview: toDeploy / toDelete / conflicts / ignored
  for (const [key, label] of [
    ["toDeploy", "Will deploy"],
    ["toDelete", "Will delete"],
    ["conflicts", "Conflicts"],
  ] as const) {
    const arr = result[key];
    if (Array.isArray(arr) && arr.length > 0) {
      sections.push(
        <div key={key}>
          <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-slate-400">
            {label} ({arr.length})
          </p>
          <Table
            head={["Type", "Name", "Path"]}
            rows={arr.map((c: any) => ({
              cells: [String(c.type ?? ""), String(c.fullName ?? ""), String(c.path ?? c.filePath ?? "")],
              bad: key === "conflicts",
            }))}
          />
        </div>,
      );
    }
  }

  // --- retrieve: result.files [{state, fullName, type, filePath}]
  if (Array.isArray(result.files) && result.files.length > 0) {
    sections.push(
      <div key="files">
        <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-slate-400">
          Files ({result.files.length})
        </p>
        <Table
          head={["State", "Type", "Name"]}
          rows={result.files.map((f: any) => ({
            cells: [String(f.state ?? ""), String(f.type ?? ""), String(f.fullName ?? f.filePath ?? "")],
            bad: String(f.state ?? "").toLowerCase() === "failed",
          }))}
        />
      </div>,
    );
  }

  // --- deploy/validate result: status + component/test failures
  if (typeof result.success === "boolean" || result.status) {
    const chips: React.ReactNode[] = [];
    if (result.status) {
      chips.push(
        <Chip
          key="status"
          label={String(result.status)}
          tone={String(result.status) === "Succeeded" ? "ok" : result.success === false ? "bad" : "info"}
        />,
      );
    }
    if (typeof result.numberComponentsDeployed === "number") {
      chips.push(
        <Chip key="comp" label={`${result.numberComponentsDeployed}/${result.numberComponentsTotal ?? "?"} components`} tone="info" />,
      );
    }
    if (typeof result.numberTestsCompleted === "number") {
      chips.push(
        <Chip
          key="tests"
          label={`${result.numberTestsCompleted} tests, ${result.numberTestErrors ?? 0} failed`}
          tone={(result.numberTestErrors ?? 0) > 0 ? "bad" : "ok"}
        />,
      );
    }
    if (chips.length) {
      sections.unshift(
        <div key="chips" className="flex flex-wrap gap-1.5">
          {chips}
        </div>,
      );
    }

    const compFailures = result.details?.componentFailures;
    const failures = Array.isArray(compFailures) ? compFailures : compFailures ? [compFailures] : [];
    if (failures.length > 0) {
      sections.push(
        <div key="compfail">
          <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-red-500">
            Component failures ({failures.length})
          </p>
          <Table
            head={["Component", "Problem"]}
            rows={failures.map((f: any) => ({
              cells: [String(f.fullName ?? f.fileName ?? ""), String(f.problem ?? "")],
              bad: true,
            }))}
          />
        </div>,
      );
    }
    const testFailures = result.details?.runTestResult?.failures;
    const tf = Array.isArray(testFailures) ? testFailures : testFailures ? [testFailures] : [];
    if (tf.length > 0) {
      sections.push(
        <div key="testfail">
          <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-red-500">
            Test failures ({tf.length})
          </p>
          <Table
            head={["Test", "Message"]}
            rows={tf.map((f: any) => ({
              cells: [`${f.name ?? ""}.${f.methodName ?? ""}`, String(f.message ?? "")],
              bad: true,
            }))}
          />
        </div>,
      );
    }
  }

  if (sections.length === 0) return <Fallback output={output} />;

  return (
    <div className="space-y-3 border-t border-slate-100 px-4 py-3">
      {sections}
      <details>
        <summary className="cursor-pointer text-[10px] text-slate-400 hover:text-slate-600">
          raw output
        </summary>
        <pre className="mt-1 max-h-60 overflow-y-auto whitespace-pre-wrap break-words rounded bg-slate-50 p-2 font-mono text-[10px] text-slate-500">
          {output}
        </pre>
      </details>
    </div>
  );
}
