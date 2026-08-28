import { NextResponse } from "next/server";
import path from "node:path";
import { isAttachableRoot } from "@/lib/fsguard";
import { hasActiveRun } from "@/lib/workflows/engine";
import {
  excludeClaimed,
  isApiName,
  listMembers,
  listTypes,
  retrieveBatches,
  retrieveMetadata,
  scopeTypes,
  type MetaType,
} from "@/lib/orgMetadata";

/** The Org Browser's data source - the org half of the project tree.
 *
 * POST {root, action:"types"}                       -> {types}
 * POST {root, action:"members", type, inFolder}     -> {members}
 * POST {root, action:"retrieve", specs:[...]}       -> {ok, output, files}
 * POST {root, action:"retrieve-all", types?, label} -> {id} (queued, see GET)
 * POST {root, action:"cancel", id}                  -> {ok}
 * POST {root, action:"dismiss", id}                 -> {ok}
 * GET  ?root=...                                    -> {jobs: [...]}
 *
 * Listing is cached per project because `sf org list metadata` is a round trip
 * to the org - ApexClass on a real production org measured 45 seconds - and a
 * tree the user expands and collapses would otherwise pay that repeatedly.
 * `refresh:true` drops the cache, which is what the refresh button sends. */

interface Cached {
  types?: MetaType[];
  members: Map<string, unknown[]>;
}
const cache = new Map<string, Cached>(); // key: normalized root

type JobStatus = "queued" | "running" | "done" | "cancelled" | "failed";

/** A retrieve runs for minutes, so it cannot live inside one request: it runs
 * here and the UI polls. Several can be asked for at once - a group here, a
 * group there - so they queue rather than being refused. */
interface Job {
  id: string;
  root: string;
  /** what this job covers - "full org", or a group name like "Apex" */
  label: string;
  status: JobStatus;
  /** the requested scope; undefined means the whole org */
  only?: string[];
  /** what it settled on retrieving, known once it starts */
  types: string[];
  /** types another running job had already claimed */
  skipped: string[];
  done: number;
  total: number;
  files: number;
  current: string;
  failed: { types: string[]; reason: string }[];
  queuedAt: number;
  startedAt?: number;
  finishedAt?: number;
  /** set by the cancel action; the batch loop checks it between batches */
  cancelRequested: boolean;
}

const jobs = new Map<string, Job>(); // key: job id
let jobSeq = 0;

/** How many retrieves run at once.
 *
 * Two rather than one so a small group is not stuck behind a full-org pull, and
 * two rather than many because each is a long-running Metadata API job holding
 * a slot on the org, and every extra one writing into the same working folder
 * is another chance of two processes touching the same file. The rest queue. */
const MAX_CONCURRENT = 2;

/** Finished cards worth keeping so the user can read what happened. Older ones
 * are pruned, oldest first, so a long session cannot grow without bound. */
const KEEP_FINISHED = 8;

function cacheFor(root: string): Cached {
  let c = cache.get(root);
  if (!c) {
    c = { members: new Map() };
    cache.set(root, c);
  }
  return c;
}

function jobsFor(root: string): Job[] {
  return [...jobs.values()].filter((j) => j.root === root);
}

function isActive(j: Job): boolean {
  return j.status === "queued" || j.status === "running";
}

async function guard(rootRaw: unknown): Promise<{ root: string } | { error: NextResponse }> {
  const root = typeof rootRaw === "string" ? path.normalize(rootRaw.trim()) : "";
  if (!root || !(await isAttachableRoot(root))) {
    return {
      error: NextResponse.json({ error: "not an attached Salesforce project" }, { status: 400 }),
    };
  }
  return { root };
}

export async function POST(req: Request) {
  let body: {
    root?: unknown;
    action?: unknown;
    type?: unknown;
    inFolder?: unknown;
    specs?: unknown;
    refresh?: unknown;
    types?: unknown;
    label?: unknown;
    id?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const g = await guard(body.root);
  if ("error" in g) return g.error;
  const { root } = g;
  const action = typeof body.action === "string" ? body.action : "";
  const refresh = body.refresh === true;

  // A retrieve during a run writes into the working tree the run is measuring.
  // Two things break: the run's change list attributes downloaded files to its
  // own steps (measured - a group download mid-run put six unrelated files into
  // a feature run's compare step), and a retrieve can overwrite a file the
  // implement step is about to edit. The chat route already refuses to
  // re-baseline the snapshot store for the same reason.
  if ((action === "retrieve" || action === "retrieve-all") && hasActiveRun(root)) {
    return NextResponse.json(
      { error: "a workflow run is in progress - downloads are paused until it finishes" },
      { status: 409 },
    );
  }

  if (action === "types") {
    const c = cacheFor(root);
    if (refresh) {
      c.types = undefined;
      c.members.clear();
    }
    if (!c.types) c.types = await listTypes(root);
    // An empty list is a real answer: no org authorized, or an sf that cannot
    // reach it. The UI says so rather than showing a broken tree.
    return NextResponse.json({ types: c.types });
  }

  if (action === "members") {
    const type = typeof body.type === "string" ? body.type : "";
    if (!type) return NextResponse.json({ error: "type required" }, { status: 400 });
    const c = cacheFor(root);
    if (refresh) c.members.delete(type);
    let members = c.members.get(type);
    if (!members) {
      members = await listMembers(root, type, body.inFolder === true);
      c.members.set(type, members);
    }
    return NextResponse.json({ members });
  }

  if (action === "retrieve") {
    const specs = (Array.isArray(body.specs) ? body.specs : []).filter(
      (s): s is string => typeof s === "string",
    );
    if (specs.length === 0) return NextResponse.json({ error: "specs required" }, { status: 400 });
    const res = await retrieveMetadata(root, specs, 600_000);
    // A failed retrieve is reported as a normal result, not a 500: the caller
    // renders sf's reason next to the row it belongs to.
    return NextResponse.json(res);
  }

  if (action === "retrieve-all") {
    const only = Array.isArray(body.types)
      ? body.types.filter((t): t is string => typeof t === "string" && isApiName(t))
      : undefined;
    const label =
      typeof body.label === "string" && body.label.trim()
        ? body.label.trim().slice(0, 60)
        : "full org";
    const job: Job = {
      id: "job-" + process.pid + "-" + ++jobSeq,
      root,
      label,
      status: "queued",
      only,
      types: [],
      skipped: [],
      done: 0,
      total: 0,
      files: 0,
      current: "waiting for a slot",
      failed: [],
      queuedAt: Date.now(),
      cancelRequested: false,
    };
    jobs.set(job.id, job);
    prune(root);
    pump(root);
    return NextResponse.json({ id: job.id, status: job.status });
  }

  if (action === "cancel" || action === "dismiss") {
    const id = typeof body.id === "string" ? body.id : "";
    const job = jobs.get(id);
    if (!job || job.root !== root) return NextResponse.json({ ok: false, reason: "no such job" });

    if (action === "cancel") {
      if (job.status === "queued") {
        // Never started, so it can simply go.
        job.status = "cancelled";
        job.current = "cancelled before it started";
        job.finishedAt = Date.now();
        pump(root);
      } else if (job.status === "running") {
        // A batch already in flight is left to finish - killing sf mid-retrieve
        // would leave half-written files. The loop stops before the next one.
        job.cancelRequested = true;
        job.current = "stopping after this batch";
      }
      return NextResponse.json({ ok: true });
    }

    // dismiss - only a finished card can be closed, so a running job cannot be
    // hidden from the person who started it
    if (isActive(job)) return NextResponse.json({ ok: false, reason: "still running" });
    jobs.delete(id);
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "unknown action" }, { status: 400 });
}

export async function GET(req: Request) {
  const root = path.normalize((new URL(req.url).searchParams.get("root") ?? "").trim());
  if (!root || !(await isAttachableRoot(root))) {
    return NextResponse.json({ error: "not an attached Salesforce project" }, { status: 400 });
  }
  // Newest first: the card the user just started belongs at the top.
  const list = jobsFor(root)
    .sort((a, b) => b.queuedAt - a.queuedAt)
    .map((j) => ({
      id: j.id,
      label: j.label,
      status: j.status,
      done: j.done,
      total: j.total,
      files: j.files,
      current: j.current,
      failed: j.failed,
      skipped: j.skipped,
      queuePosition: j.status === "queued" ? queuePosition(root, j) : 0,
    }));
  return NextResponse.json({ jobs: list, maxConcurrent: MAX_CONCURRENT });
}

function queuePosition(root: string, job: Job): number {
  const queued = jobsFor(root)
    .filter((j) => j.status === "queued")
    .sort((a, b) => a.queuedAt - b.queuedAt);
  return queued.findIndex((j) => j.id === job.id) + 1;
}

/** Forget the oldest finished cards once there are more than we keep. */
function prune(root: string): void {
  const finished = jobsFor(root)
    .filter((j) => !isActive(j))
    .sort((a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0));
  for (const j of finished.slice(0, Math.max(0, finished.length - KEEP_FINISHED))) {
    jobs.delete(j.id);
  }
}

/** Start queued jobs while there is a free slot, oldest first. */
function pump(root: string): void {
  const mine = jobsFor(root);
  let running = mine.filter((j) => j.status === "running").length;
  const queued = mine
    .filter((j) => j.status === "queued")
    .sort((a, b) => a.queuedAt - b.queuedAt);
  for (const job of queued) {
    if (running >= MAX_CONCURRENT) break;
    running += 1;
    runJob(job).catch(() => {});
  }
}

/** Retrieve a job's types, batch by batch.
 *
 * Deliberately keeps going after a batch fails. Some types cannot be retrieved
 * by name on some orgs (a feature not enabled, a type this API version does not
 * map), and stopping there would discard everything already pulled. The failed
 * types are named on the job so the user can see exactly what is missing rather
 * than a bare "retrieve failed". */
async function runJob(job: Job): Promise<void> {
  job.status = "running";
  job.startedAt = Date.now();
  job.current = "listing metadata types";

  try {
    const c = cacheFor(job.root);
    if (!c.types) c.types = await listTypes(job.root);

    // The org's list is the authority on what exists, so a scoped request is
    // intersected with it rather than taken at face value. Overlap with an
    // already-running job is computed HERE rather than at queue time, because
    // what is claimed changes while a job waits for its slot.
    const wanted = scopeTypes(
      c.types.map((t) => t.name),
      job.only,
    );
    const claimed = new Set<string>();
    for (const other of jobsFor(job.root)) {
      if (other.id !== job.id && other.status === "running") {
        for (const t of other.types) claimed.add(t);
      }
    }
    const split = excludeClaimed(wanted, claimed);
    job.types = split.types;
    job.skipped = split.skipped;

    const batches = retrieveBatches(job.types);
    job.total = batches.length;
    if (batches.length === 0) {
      job.current = job.skipped.length > 0 ? "already covered by another retrieve" : "nothing to do";
      job.status = "done";
      return;
    }

    for (const batch of batches) {
      if (job.cancelRequested) break;
      job.current = batch.join(", ");
      const res = await retrieveMetadata(job.root, batch, 900_000);
      if (res.ok) job.files += res.files;
      else job.failed.push({ types: batch, reason: res.output.slice(0, 400) });
      job.done += 1;
    }

    if (job.cancelRequested) {
      job.status = "cancelled";
      job.current = "stopped after " + job.done + " of " + job.total + " batches";
    } else {
      job.status = job.failed.length > 0 ? "failed" : "done";
      job.current =
        job.failed.length > 0
          ? job.failed.length + " of " + job.total + " batches failed"
          : "complete";
    }
  } catch (e) {
    job.failed.push({ types: ["*"], reason: String(e).slice(0, 400) });
    job.status = "failed";
    job.current = "failed";
  } finally {
    job.finishedAt = Date.now();
    // A freed slot may let a queued job start.
    pump(job.root);
  }
}
