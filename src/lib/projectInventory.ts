import path from "node:path";
import { promises as fs } from "node:fs";

/** A compact, ENGINE-derived inventory of the attached DX project.
 *
 * Injected into investigation/design prompts so "does object X have a
 * trigger?" is answered by ground truth instead of by how well the agent
 * happens to glob. Names are no signal - a trigger on Account can be called
 * anything - so triggers are parsed from their own source (`trigger X on Y`),
 * which IS authoritative. Deterministic input replacing a probabilistic
 * search, same as everything else the engine injects. */

const MAX_NAMES = 150;
const MAX_BLOCK = 4000;

async function packageDirs(root: string): Promise<string[]> {
  try {
    const raw = JSON.parse(await fs.readFile(path.join(root, "sfdx-project.json"), "utf8"));
    const dirs = (raw?.packageDirectories ?? [])
      .map((d: { path?: string }) => (typeof d?.path === "string" ? d.path : ""))
      .filter(Boolean);
    return dirs.length ? dirs : ["force-app"];
  } catch {
    return ["force-app"];
  }
}

async function names(dir: string, strip: RegExp): Promise<string[]> {
  const out = await fs.readdir(dir).catch(() => [] as string[]);
  return out.map((n) => n.replace(strip, "")).filter(Boolean).sort();
}

function list(label: string, items: string[]): string {
  if (items.length === 0) return "";
  const shown = items.slice(0, MAX_NAMES);
  const more = items.length > shown.length ? ` [+${items.length - shown.length} more]` : "";
  return `${label} (${items.length}): ${shown.join(", ")}${more}\n`;
}

export async function projectInventory(root: string): Promise<string> {
  const triggers: string[] = [];
  let classes: string[] = [];
  let objects: string[] = [];
  let lwc: string[] = [];
  const flows: string[] = [];

  for (const pkg of await packageDirs(root)) {
    const base = path.join(root, pkg, "main", "default");

    for (const f of await fs.readdir(path.join(base, "triggers")).catch(() => [] as string[])) {
      if (!f.endsWith(".trigger")) continue;
      const head = await fs
        .readFile(path.join(base, "triggers", f), "utf8")
        .then((s) => s.slice(0, 2000))
        .catch(() => "");
      const m = head.match(/\btrigger\s+(\w+)\s+on\s+(\w+)/i);
      triggers.push(m ? `${m[1]} on ${m[2]}` : f.replace(/\.trigger$/, ""));
    }
    classes = classes.concat(
      (await names(path.join(base, "classes"), /\.cls(-meta\.xml)?$/)).filter(
        (n) => !n.endsWith(".xml"),
      ),
    );
    objects = objects.concat(await names(path.join(base, "objects"), /$/));
    lwc = lwc.concat((await names(path.join(base, "lwc"), /$/)).filter((n) => !n.includes(".")));
    for (const f of await fs.readdir(path.join(base, "flows")).catch(() => [] as string[])) {
      if (!f.endsWith(".flow-meta.xml")) continue;
      const head = await fs
        .readFile(path.join(base, "flows", f), "utf8")
        .then((s) => s.slice(0, 32_000))
        .catch(() => "");
      const kind = /<recordTriggerType>|<triggerType>\s*Record/i.test(head)
        ? " (record-triggered)"
        : /<screens>/i.test(head)
          ? " (screen)"
          : "";
      flows.push(f.replace(/\.flow-meta\.xml$/, "") + kind);
    }
  }

  classes = [...new Set(classes)].sort();
  triggers.sort();

  const body =
    list("Objects", objects) +
    list("Apex triggers", triggers) +
    list("Apex classes", classes) +
    list("Flows", flows.sort()) +
    list("LWC components", lwc.sort());
  if (!body.trim()) return "";

  return (
    `\nPROJECT INVENTORY (engine-derived from the working tree - ground truth; ` +
    `do not re-discover it by searching, and trust it over filename guesses. ` +
    `A trigger's name says nothing about its object; the "X on Y" pairs below are ` +
    `parsed from the trigger source itself):\n` +
    body.slice(0, MAX_BLOCK) +
    `\n`
  );
}
