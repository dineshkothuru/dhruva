import { NextResponse } from "next/server";
import { execFile } from "node:child_process";
import { AGENTS } from "@/lib/agents";

function probe(bin: string): Promise<{ installed: boolean; version?: string }> {
  return new Promise((resolve) => {
    execFile(
      bin,
      ["--version"],
      { timeout: 15_000, shell: true, windowsHide: true },
      (err, stdout) => {
        if (err) resolve({ installed: false });
        else resolve({ installed: true, version: String(stdout).trim().split("\n")[0] });
      },
    );
  });
}

export async function GET() {
  const entries = await Promise.all(
    Object.values(AGENTS).map(async (a) => [
      a.id,
      {
        ...(await probe(a.bin)),
        label: a.label,
        installHint: a.installHint,
        models: a.models,
        tiers: a.tiers,
      },
    ]),
  );
  return NextResponse.json(Object.fromEntries(entries));
}
