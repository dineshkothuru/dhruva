import path from "node:path";
import { promises as fs } from "node:fs";

/** Does the design cite components that actually exist?
 *
 * The largest single class of review finding, across every run measured, is the
 * design asserting something about this org that is not true:
 *
 *   "`getInvoiceDetails` does not exist on `ContractSearchController`"
 *   "the FLS-restricted write path cited by REQ-006 is dead code"
 *   "the allocation engine has no input data - no invoice service-line object exists"
 *
 * Asking harder does not fix it - the prompt already says "never cite a
 * component you have not opened". But EXISTENCE is arithmetic, and the design
 * format already draws the line for us: `EVIDENCE` means "what is here today",
 * while `DESIGN` may name things the design intends to create. So every name
 * cited as EVIDENCE must resolve to a file in the project, and a name that does
 * not is a fact, reported before the next round rather than found by a
 * fifteen-minute review.
 *
 * Measured against three real runs: 60, 61 and 69 checkable names, with 4
 * misses in one run and none in the other two. One of those four was
 * `Invoice_Line_Item__c` - reported by the reviewer as a CRITICAL finding.
 *
 * Deliberately narrow. Only two shapes are unambiguous enough to check:
 * custom objects and fields (`Foo__c`), and Apex classes by their suffix
 * convention. Constants, picklist values, SOQL keywords, relationship names
 * (`__r`), history objects and platform modules are all skipped, because a
 * checker that cries wolf is worse than none in a pipeline already fighting
 * noise. */

const CUSTOM = /^[A-Z][A-Za-z0-9_]*__c$/;
const APEX =
  /^[A-Z][A-Za-z0-9]*(Controller|Service|Handler|Batch|Selector|Helper|Util|Test|Schedule|Scheduler|Queueable|Trigger)$/;

const isCheckable = (n: string) => CUSTOM.test(n) || APEX.test(n);

/** Lightning web components, by folder name.
 *
 * Held separately because an LWC name is lowercase camelCase and matches no
 * safe shape rule - `subcontractorDetail` is indistinguishable from a variable.
 * That is fine for the "already exists" check, where membership IS the evidence
 * and a name absent from this set simply says nothing; it is why that check can
 * catch what the EVIDENCE check cannot. */
async function indexComponents(root: string): Promise<Set<string>> {
  const out = new Set<string>();
  const roots = [path.join(root, "force-app/main/default/lwc"), path.join(root, "force-app/main/default/aura")];
  for (const dir of roots) {
    for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (e.isDirectory()) out.add(e.name);
    }
  }
  return out;
}

/** Every metadata name in the project, by file name with its suffixes removed. */
async function indexProject(root: string): Promise<Set<string>> {
  const out = new Set<string>();
  const base = path.join(root, "force-app");
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 12) return;
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        await walk(p, depth + 1);
        continue;
      }
      out.add(
        e.name
          .replace(/\.(cls|trigger|js|html|xml|json|cmp|page)$/, "")
          .replace(/\.[A-Za-z]+-meta$/, ""),
      );
    }
  };
  await walk(base, 0);
  return out;
}

export interface EvidenceReport {
  /** names cited as EVIDENCE that this project does not contain */
  missing: { req: string; name: string }[];
  /** names the DESIGN proposes to create that already exist */
  duplicated: { req: string; name: string }[];
  /** how many names were checkable at all, so a zero can be trusted */
  checked: number;
}

/** "Build a new LWC `x`", "Create `Y__c`", "Add a new Apex service `Z`".
 *
 * The mirror of the EVIDENCE rule, and it catches the failure that has now cost
 * three times: a search returns nothing, absence of evidence is taken for
 * evidence of absence, and the design proposes building something that is
 * already there. On run d0e4f7bc-1d6 a corrupted glob - two prompts spliced
 * together by parallel sub-agents - produced "No dedicated Subcontractor detail
 * LWC exists", and the design set out to build `subcontractorDetail`, which the
 * repository already contains under exactly that name.
 *
 * EVIDENCE names must exist. Names the DESIGN sets out to CREATE must not.
 *
 * Narrow on purpose. A first cut matched any backticked name within 60
 * characters of a creation verb and flagged six things on a real design, five
 * of them wrong: "new fields ON `Invoice__c`", "a validation rule ON
 * `Revenue_Source__c`", "create an IN-MEMORY `..._Line__c`". The design was not
 * creating those - it was naming what it attaches to. So the artifact TYPE must
 * be named right before it ("Build a new LWC `x`", "create an Apex class `y`"),
 * and a preposition in between disqualifies the match. A checker that cries
 * wolf is worse than none in a pipeline already fighting noise. */
const TYPE =
  "(?:LWC|Lightning web component|Aura component|component|Apex class|class|service|trigger|batch|custom object|object|custom field|field|flow|permission set|permission-set)";
const CREATES = new RegExp(
  `\\b(?:build|create|introduce|add)\\b[^\`\\n]{0,30}\\b${TYPE}\\b(?!\\s+(?:on|to|for|from|in|by|of)\\b)[^\`\\n]{0,20}\`([A-Za-z][A-Za-z0-9_]*)\``,
  "gi",
);

/** Check every `EVIDENCE:` field in a design against the project. */
export async function checkEvidence(root: string, design: string): Promise<EvidenceReport> {
  const index = await indexProject(root).catch(() => new Set<string>());
  if (index.size === 0) return { missing: [], duplicated: [], checked: 0 };
  const components = await indexComponents(root).catch(() => new Set<string>());

  const missing: { req: string; name: string }[] = [];
  const duplicated: { req: string; name: string }[] = [];
  let checked = 0;
  let req = "";
  let field = "";
  const seen = new Set<string>();

  for (const line of design.split(/\r?\n/)) {
    const head = line.match(/^###\s+(REQ-\d+)\b/);
    if (head) {
      req = head[1];
      field = "";
      continue;
    }
    const label = line.match(/^([A-Z][A-Z0-9 _-]{0,30}):/);
    if (label) field = label[1];
    else if (/^<!-- lineage/.test(line)) field = "";

    if (field === "EVIDENCE") {
      for (const m of line.matchAll(/`([A-Za-z][A-Za-z0-9_]*)/g)) {
        const name = m[1];
        if (!isCheckable(name)) continue;
        checked++;
        const key = `E:${req}:${name}`;
        if (index.has(name) || seen.has(key)) continue;
        seen.add(key);
        missing.push({ req, name });
      }
    } else if (field === "DESIGN") {
      for (const m of line.matchAll(CREATES)) {
        const name = m[1];
        const exists = components.has(name) || (isCheckable(name) && index.has(name));
        if (!exists) continue;
        const key = `D:${req}:${name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        duplicated.push({ req, name });
      }
    }
  }
  return { missing, duplicated, checked };
}

/** One line for the step trace, or "" when there is nothing to say. */
export function evidenceNote(r: EvidenceReport): string {
  const parts: string[] = [];
  if (r.checked > 0) {
    parts.push(
      r.missing.length === 0
        ? `evidence check: all ${r.checked} cited component(s) exist in this project.`
        : `evidence check: ${r.missing.length} of ${r.checked} cited component(s) do NOT exist in ` +
          `this project - EVIDENCE must describe what is here today, so either the name is wrong ` +
          `or the item belongs in DESIGN as something to create: ` +
          r.missing.map((m) => `${m.name} (${m.req})`).join(", "),
    );
  }
  if (r.duplicated.length > 0) {
    parts.push(
      `ALREADY EXISTS: the design proposes creating ${r.duplicated.length} component(s) this ` +
        `project already has - open them before designing around their absence: ` +
        r.duplicated.map((m) => `${m.name} (${m.req})`).join(", "),
    );
  }
  return parts.join(" ");
}
