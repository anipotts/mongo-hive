import "server-only";
import { hive, hives, type Hive } from "../../src/registry/db";
import type { AnswerKey, Capability, CapabilityVersion, WorkerJob } from "../../src/registry/types";
import { rank, standing } from "../../src/validator/index";
import { eventName, eventTool } from "./events";
import { evalHistory, pinsByVersion, recipeDiff, timeline } from "./versions";

// console-v2 data (#6). every surface speaks one grammar (ui audit on #6):
//   [actor] [verb] [tool · version] [result] · [time]
// the ui renders the same Line as a feed row, table row or badge. nothing here returns hidden case inputs
// (not even evalSuite: web/ json is reachable by any local process, agents included).

export type Verb =
  | "drafted" | "tested" | "promoted" | "rejected" | "published" | "pinned" | "ran" | "gave feedback"
  // worker job outcomes, so worker work shows in activity next to what people did
  | "checked" | "improved" | "tried to improve" | "drafted new tool";
export type Tone = "good" | "bad" | "warn" | "info";
export interface Actor { user: string; worker: boolean; harness?: string }
export interface Line {
  id: string;
  actor: Actor;
  verb: Verb;
  tool?: string;
  v?: number;
  result?: string;
  tone?: Tone;
  outputId?: string; // on "ran" lines: what the console's ✓/✗ buttons pass to giveFeedback (#18)
  judged?: "correct" | "wrong"; // set once a person has given feedback on that run
  // on "ran" lines: a worker's check disagreed with this run and no person has judged it yet
  needsJudgment?: boolean;
  checked?: "agrees" | "disagrees";
  at: Date;
  hive: string;
}
export interface SessionLine {
  id: string;
  actor: Actor;
  kind: "session";
  title?: string;
  lastPrompt?: string; // the newest prompt (redacted preview), not the first one
  machine?: string;
  project?: string; // last path segment of the session's cwd; never the full path
  worktree?: boolean;
  toolCalls: number;
  prompts: number;
  online: boolean;
  startedAt: Date;
  lastEventAt: Date;
  hive: string;
}

type Score = NonNullable<CapabilityVersion["score"]>;
// no x/10 anywhere (ani, #46): "passes 685 ms" or "fails 3 859 ms"
export const evalWord = (s?: { passed: number; total: number; ms?: number } | null) =>
  !s || !s.total ? "no evals" : `${s.passed === s.total ? "passes" : `fails ${s.total - s.passed}`}${s.ms != null ? ` ${s.ms} ms` : ""}`;
// worker notes are free text written by the backend ("v8 7/10 vs head v2 9/10: rejected"); the ui never shows a
// fraction, so a/b becomes "passes" or "fails N" before a note reaches a label
export const noFrac = (s?: string | null) =>
  String(s ?? "").replace(/\b(\d+)\/(\d+)\b/g, (_, a: string, b: string) => (+a === +b ? "passes" : `fails ${+b - +a}`));
export const runsWord = (n: number) => `${n} run${n === 1 ? "" : "s"}`;
const ONLINE_MS = 5 * 60_000; // Stop fires after every turn, so endedAt can't be trusted; recency decides
const isWorker = (x: { harness?: string }) => x.harness === "worker";
const actorOf = (x: { user?: string; actor?: string; author?: string; harness?: string }): Actor => ({
  user: x.user ?? x.actor ?? x.author ?? "unknown", worker: isWorker(x), harness: x.harness,
});

// one line per version: what happened to it when it was committed
function versionLine(h: string, cap: Capability, x: CapabilityVersion): Line {
  const led = x.status === "active" || x.status === "superseded";
  const verb: Verb = x.status === "rejected" ? "rejected" : x.publishedFrom ? "published" : led ? "promoted" : "drafted";
  const result = led
    ? x.supersedes != null ? `${evalWord(x.score)}, promoted over v${x.supersedes}` : `${evalWord(x.score)}, promoted`
    : x.status === "rejected" ? `${evalWord(x.score)}, not promoted` : x.status === "unverified" ? "untested" : x.status;
  const tone: Tone | undefined = verb === "rejected" ? "bad" : verb === "promoted" || (verb === "published" && led) ? "good" : undefined;
  return { id: `${h}/${cap._id}/v${x.v}`, actor: actorOf(x), verb, tool: cap._id, v: x.v, result, tone, at: x.createdAt, hive: h };
}

// mcp-server and console events that change or use the hive. hook events are folded into sessions instead.
function eventLine(h: string, e: any): Line | null {
  const tool = eventTool(e);
  const a = e.args ?? {};
  if (tool === "pin_capability") return { id: String(e._id), actor: actorOf(e), verb: "pinned", tool: a.id, v: a.version ?? undefined, result: a.version == null ? "unpinned" : undefined, at: e.at, hive: h };
  // #18: { kind: "feedback", tool: "feedback", actor, args: {id, v, outputId, verdict} }
  if (e.kind === "feedback" || tool === "feedback") return { id: String(e._id), actor: actorOf(e), verb: "gave feedback", tool: a.id, v: a.v, result: a.verdict ?? e.result?.verdict, outputId: a.outputId, at: e.at, hive: h };
  return null;
}

async function sessionLines(h: Hive, since: Date, limit: number): Promise<SessionLine[]> {
  const sessions = await h.db.collection("sessions").find({ lastEventAt: { $gte: since } }).sort({ lastEventAt: -1 }).limit(limit).toArray();
  if (!sessions.length) return [];
  const ids = sessions.map((s) => s._id);
  const [counts, latest] = await Promise.all([
    h.events.aggregate<{ _id: { s: string; k: string }; n: number }>([
      { $match: { sessionId: { $in: ids } } },
      { $group: { _id: { s: "$sessionId", k: "$kind" }, n: { $sum: 1 } } },
    ]).toArray(),
    // the newest prompt per session, so the roster shows what someone is doing now, not how they started
    h.events.aggregate<{ _id: string; text: string }>([
      { $match: { sessionId: { $in: ids }, kind: "prompt" } },
      { $sort: { at: -1 } },
      { $group: { _id: "$sessionId", text: { $first: "$argsPreview" } } },
    ]).toArray(),
  ]);
  const promptOf = new Map(latest.map((l) => [String(l._id), l.text]));
  const segs = (cwd?: string) => String(cwd ?? "").split("/").filter(Boolean);
  const n = (s: unknown, k: string) => counts.find((c) => c._id.s === s && c._id.k === k)?.n ?? 0;
  const now = Date.now();
  return sessions.map((s: any) => ({
    id: String(s._id), actor: actorOf(s), kind: "session", title: s.title, lastPrompt: promptOf.get(String(s._id)) ?? s.title,
    machine: s.machine ? String(s.machine).replace(/\.local$/, "") : undefined, project: segs(s.cwd).at(-1),
    worktree: segs(s.cwd).includes("worktrees"), toolCalls: n(s._id, "tool"), prompts: n(s._id, "prompt"),
    online: now - +new Date(s.lastEventAt) < ONLINE_MS, startedAt: s.startedAt, lastEventAt: s.lastEventAt, hive: h.name,
  }));
}

// every run is an `outputs` doc (run_capability and native tools alike), so "ran" lines come from there,
// with the feedback verdict if a person already judged it. result rows stay server-side; only the count leaves.
async function runLines(h: Hive, since: Date, limit: number, tool?: string): Promise<Line[]> {
  // one round trip (kap, #54): the row count is computed in atlas, the rows themselves never leave it
  const outs = await h.outputs.aggregate<any>([
    { $match: { at: { $gte: since }, ...(tool ? { capId: tool } : {}) } }, { $sort: { at: -1 } }, { $limit: limit },
    { $project: { user: 1, actor: 1, author: 1, harness: 1, capId: 1, v: 1, at: 1, feedback: 1, check: 1, n: { $size: { $ifNull: ["$result", []] } } } },
  ]).toArray();
  const n = new Map(outs.map((o) => [o._id, o.n as number]));
  return outs.map((o): Line => {
    // outputs.check is the backend branch's field (shared design item 2); read optionally so this compiles either way
    const check = o.check as { agree?: boolean } | undefined;
    const checked = check?.agree === true ? "agrees" : check?.agree === false ? "disagrees" : undefined;
    const needsJudgment = checked === "disagrees" && !o.feedback;
    return {
      id: String(o._id), actor: actorOf(o), verb: "ran", tool: o.capId, v: o.v,
      result: `${n.get(o._id) ?? 0} result${n.get(o._id) === 1 ? "" : "s"}${o.feedback ? ` · judged ${o.feedback.verdict} by ${o.feedback.by}` : checked === "agrees" ? " · a worker's check agrees" : ""}`,
      tone: needsJudgment ? "warn" : undefined,
      outputId: String(o._id), judged: o.feedback?.verdict, needsJudgment, checked, at: o.at, hive: h.name,
    };
  });
}

// finished worker jobs as activity lines, with the same label the worker card shows. a new-tool or improve job
// also made a version; its job line replaces that version's own line (see feed), so each outcome reads once.
async function jobLines(h: Hive, since: Date, limit: number, caps: Capability[], privateOwner: string | null, tool?: string): Promise<Line[]> {
  const jobs = await h.workerJobs.find({ updatedAt: { $gte: since }, step: { $in: ["proposed", "rejected", "skipped"] }, capId: tool ?? { $exists: true } }).sort({ updatedAt: -1 }).limit(limit).toArray();
  return jobs.map((j): Line => {
    const r = workerRow(j, { cap: caps.find((c) => c._id === j.capId), privateOwner, isPrivate: !!privateOwner });
    const verb: Verb =
      r.kind === "checking" ? "checked" :
      r.kind === "new tool" ? "drafted new tool" :
      r.outcome === "promoted" ? "improved" : "tried to improve";
    const tone: Tone | undefined = r.outcome === "promoted" ? "good" : r.outcome === "rejected" ? "bad" : r.needsPerson ? "warn" : undefined;
    return {
      id: `job/${j._id}`, actor: { user: r.workerOf ?? "someone", worker: true, harness: "worker" }, verb, tool: j.capId, v: r.v ?? undefined,
      result: r.label, tone, at: j.updatedAt, hive: h.name,
    };
  });
}

// activity (was "hive changes"): versions, runs, pins, feedback and finished worker jobs, one chronological
// list, newest first. agent sessions come back separately (the person chips show them).
export async function feed(name: string, opts: { since?: Date; limit?: number; tool?: string } = {}) {
  const h = hive(name);
  const since = opts.since ?? new Date(Date.now() - 24 * 3600_000);
  const limit = opts.limit ?? 200; // raw lines; bursts of runs collapse into one row, so this is ~a screen of rows
  const [info, caps, events, runs, sessions] = await Promise.all([
    hives.findOne({ _id: name }, { projection: { visibility: 1, owner: 1 } }),
    h.capabilities.find(opts.tool ? { _id: opts.tool } : {}).toArray(),
    h.events.find({ at: { $gte: since }, ...(opts.tool ? { "args.id": opts.tool } : {}), $or: [{ tool: { $in: ["pin_capability", "feedback"] } }, { kind: "feedback" }] }).sort({ at: -1 }).limit(limit).toArray(),
    runLines(h, since, limit, opts.tool),
    opts.tool ? Promise.resolve([] as SessionLine[]) : sessionLines(h, since, 20),
  ]);
  const jobs = await jobLines(h, since, limit, caps, info?.visibility === "private" ? info.owner : null, opts.tool);
  const byJob = new Set(jobs.filter((l) => l.verb !== "checked").map((l) => `${l.tool}:${l.v}`));
  const changes = [
    ...caps.flatMap((c) => c.versions
      .filter((x) => new Date(x.createdAt) >= since)
      .filter((x) => !(x.harness === "worker" && byJob.has(`${c._id}:${x.v}`)))
      .map((x) => versionLine(name, c, x))),
    ...events.map((e) => eventLine(name, e)).filter((l): l is Line => !!l),
    ...runs,
    ...jobs,
  ].sort((a, b) => +new Date(b.at) - +new Date(a.at)).slice(0, limit);
  return { changes, groups: collapse(changes), sessions };
}

// one activity row: a single line, or a burst of the same actor + verb + tool + version within 3 minutes
// ("ani ran calculator v1 ×26 · 2:56–2:57 PM"). lines stay inside, so every run keeps its own ✓/✗.
export interface ActivityRow { key: string; lines: Line[]; first: Date; last: Date }
const BURST_MS = 3 * 60_000;
export function collapse(lines: Line[]): ActivityRow[] {
  const rows: ActivityRow[] = [];
  const sig = (l: Line) => `${l.actor.user}:${l.actor.worker}:${l.verb}:${l.tool ?? ""}:${l.v ?? ""}`;
  for (const l of lines) { // newest first, so a row's first line is its newest
    const cur = rows.at(-1);
    if (cur && sig(cur.lines[0]) === sig(l) && +cur.last - +new Date(l.at) <= BURST_MS) {
      cur.lines.push(l);
      cur.first = new Date(l.at);
      cur.key = l.id; // keyed by its oldest line: a new run joining the burst keeps the row (and its open state)
    } else rows.push({ key: l.id, lines: [l], first: new Date(l.at), last: new Date(l.at) });
  }
  return rows;
}

// the hook events behind one collapsed session line, for when the ui expands it
export async function sessionDetail(name: string, sessionId: string, limit = 100) {
  const rows = await hive(name).events.find({ sessionId }, { projection: { argsPreview: 1, kind: 1, tool: 1, at: 1 } }).sort({ at: 1 }).limit(limit).toArray();
  return rows.map((e) => ({ at: e.at, label: eventName(e), tool: eventTool(e) || undefined, preview: e.argsPreview as string | undefined }));
}

// U1 standing words from docs/glossary.md
export const standingLabel = (s: ReturnType<typeof standing>) =>
  !s ? null : s.state === "on_best" ? "up to date" : s.state === "better_available" ? `update available · v${s.best}` : s.state === "yours_beats_team" ? "yours is better, publish it" : `pinned v${s.v}`;

// roster: one row per member (owner/member, last seen = latest of their agents), their agents nested beneath
// with standing per tool. members with no agents still show. a person's worker nests under them too.
export async function roster(name: string) {
  const h = hive(name);
  const [info, agents, caps, sessions, workerUsers] = await Promise.all([
    hives.findOne({ _id: name }),
    h.agents.find({}, { projection: { resumeToken: 0 } }).toArray(),
    h.capabilities.find().toArray(),
    h.db.collection("sessions").find({}, { projection: { user: 1, harness: 1, lastEventAt: 1, title: 1 } }).sort({ lastEventAt: -1 }).toArray(),
    h.workerJobs.distinct("claimedBy"),
  ]);
  const now = Date.now();
  const workers = new Set([
    ...workerUsers.map((c) => String(c).split(":")[1]).filter(Boolean),
    ...caps.flatMap((c) => c.versions.filter((x) => x.harness === "worker").map((x) => x.author)),
  ]);
  const ids = new Set([...agents.map((a) => a._id), ...sessions.map((s: any) => `${s.user}:${s.harness}`), ...[...workers].map((u) => `${u}:worker`)]);
  const agentRows = [...ids].sort().map((id) => {
    const a = agents.find((x) => x._id === id);
    const [user, harness] = id.split(":");
    const last = sessions.find((s: any) => `${s.user}:${s.harness}` === id) as any;
    const lastSeen = [a?.lastSeen, last?.lastEventAt].filter(Boolean).map((d) => +new Date(d)).sort((x, y) => y - x)[0];
    return {
      id, user, harness, worker: harness === "worker",
      online: lastSeen != null && now - lastSeen < ONLINE_MS,
      lastSeen: lastSeen ? new Date(lastSeen) : null,
      session: last?.title as string | undefined,
      standings: caps.map((c) => {
        const st = a ? standing(c, a.pulled?.[c._id] ?? null, a.pinned?.[c._id] ?? null) : null;
        return { tool: c._id, standing: st, label: standingLabel(st) };
      }),
    };
  });
  const people = [...new Set([info?.owner, ...(info?.members ?? []), ...agentRows.map((r) => r.user)].filter((u): u is string => !!u))].sort();
  return people.map((user) => {
    const mine = agentRows.filter((r) => r.user === user);
    const seen = mine.map((r) => r.lastSeen).filter((d): d is Date => !!d).sort((x, y) => +y - +x)[0] ?? null;
    return {
      user, role: info?.owner === user ? "owner" : "member",
      online: mine.some((r) => r.online), lastSeen: seen,
      agents: mine, // empty = "no agents connected"
    };
  });
}

// honeycomb catalog: every tool in every hive the viewer can see, with its #1
export async function catalog(user: string) {
  const list = await hives.find({ $or: [{ owner: user }, { members: user }] }).sort({ visibility: -1, _id: 1 }).toArray();
  const rows = await Promise.all(list.map(async (info) => {
    const caps = await hive(info._id).capabilities.find().toArray();
    return caps.map((c) => {
      const top = rank(c)[0];
      return {
        hive: info._id, visibility: info.visibility, tool: c._id, directive: c.directive, scope: c.scope,
        head: top ? { v: top.v, author: top.author, harness: top.harness, score: top.score } : null,
        versions: c.versions.length, updatedAt: c.updatedAt,
      };
    });
  }));
  return rows.flat();
}

// failing categories per version, from its latest evaluation (category names only, never inputs)
async function failingByVersion(h: Hive, cap: Capability) {
  const out: Record<number, string[]> = {};
  for (const x of cap.versions) {
    const ev = await h.evaluations.findOne({ capId: cap._id, hash: x.hash }, { sort: { at: -1 }, projection: { failedCategories: 1 } });
    if (ev?.failedCategories) out[x.v] = Object.keys(ev.failedCategories);
  }
  return out;
}

// V1 provenance line under each version row:
// "replaced v1 (6/10) · fixed: archived, multi_copy · still fails: archived_only_team"
function provenance(cap: Capability, x: CapabilityVersion, failing: Record<number, string[]>) {
  const prev = cap.versions.find((p) => p.v === x.supersedes);
  const now = failing[x.v] ?? [];
  const before = prev ? failing[prev.v] ?? [] : [];
  return {
    replaced: prev ? { v: prev.v, score: prev.score } : null,
    fixed: before.filter((c) => !now.includes(c)),
    stillFails: now,
  };
}

export type CaseSource = "seed" | "accepted_run" | "corrected_run" | "worker_agreement";
// the hive's evals with provenance only: category, source, who and when. never args/expect: this json is
// reachable by any local process (a coding agent with a shell included), so eval inputs never leave through it.
export async function evalSuite(h: Hive, capId: string) {
  // provenance fields are the contract's AnswerKey extension (#18 writes them); seeded cases predate it
  type Case = AnswerKey["cases"][number] & { source?: CaseSource; addedBy?: string; addedAt?: Date; outputId?: string; provisional?: boolean };
  const key = await h.answerKeys.findOne({ _id: capId }, { projection: { "cases.args": 0, "cases.expect": 0 } });
  return ((key?.cases ?? []) as Case[]).map((c, i) => ({
    n: i + 1, category: c.category,
    source: c.source ?? "seed", addedBy: c.addedBy ?? "seed", addedAt: c.addedAt, outputId: c.outputId, provisional: !!c.provisional,
  }));
}

// everything the tool page needs in one call
export async function toolPage(name: string, id: string) {
  const h = hive(name);
  const cap = await h.capabilities.findOne({ _id: id });
  if (!cap) return null;
  const [pins, evals, failing, tests, jobs, info, states] = await Promise.all([
    pinsByVersion(h, id), evalHistory(h, cap), failingByVersion(h, cap), evalSuite(h, id),
    h.workerJobs.find({ capId: id }).sort({ updatedAt: -1 }).limit(20).toArray(),
    hives.findOne({ _id: name }, { projection: { visibility: 1, owner: 1 } }),
    toolStates(name, [cap]),
  ]);
  const privateOwner = info?.visibility === "private" ? info.owner : null;
  const runs = await checkRuns(h, jobs);
  return {
    state: states[id],
    hive: name, id, directive: cap.directive, scope: cap.scope, head: cap.activeVersion,
    leaderboard: rank(cap).map((x, i) => ({ rank: i + 1, v: x.v, author: x.author, harness: x.harness, worker: isWorker(x), score: x.score })),
    versions: timeline(cap).map((t) => ({ ...t, worker: t.harness === "worker", provenance: provenance(cap, cap.versions.find((x) => x.v === t.v)!, failing), evals: evals[t.v] ?? [], pinnedBy: pins.pinned[t.v] ?? [], runningOn: pins.running[t.v] ?? [] })),
    diff: cap.activeVersion != null ? recipeDiff(cap, cap.activeVersion) : null,
    evals: tests,
    worker: groupCards(jobs.map((j) => workerRow(j, { cap, privateOwner, isPrivate: !!privateOwner, runs: runs.get(j._id) }))).cards,
  };
}

// S1 stage bar: queued, drafting, testing, done
export type Stage = "queued" | "drafting" | "testing" | "done";
const stageOf = (s: WorkerJob["step"]): Stage => (s === "queued" ? "queued" : s === "drafting" ? "drafting" : s === "validating" ? "testing" : "done");
const OPEN_STEPS: WorkerJob["step"][] = ["queued", "drafting", "validating"];

export type Outcome = "promoted" | "draft" | "rejected" | "skipped" | null;
export type WorkerKind = "new tool" | "repair" | "improving" | "checking";
export type WorkerCard = ReturnType<typeof workerRow> & { older: ReturnType<typeof workerRow>[] };

// trigger "check" arrives with the backend branch (shared design item 1). compared as a string so this compiles on
// main before WorkerJob["trigger"] gains it, and keeps working after.
const kindOf = (trigger: string): WorkerKind =>
  trigger === "repetition" || trigger === "session_end" ? "new tool" : trigger === "split" ? "repair" : trigger === "check" ? "checking" : "improving";
const newestUntested = (cap?: Capability | null) => cap ? [...cap.versions].sort((a, b) => b.v - a.v).find((x) => x.status === "unverified") : undefined;
const nextV = (cap?: Capability | null) => (cap ? (cap.nextVersion ?? cap.versions.length) + 1 : null); // nextVersion is the last v handed out

// runs a check job covers: the version's runs that no earlier check covered, plus the ones this job already checked,
// so K holds still while the job writes outputs.check one run at a time
async function checkRuns(h: Hive, jobs: WorkerJob[]) {
  const out = new Map<string, number>();
  await Promise.all(jobs.filter((j) => kindOf(j.trigger) === "checking" && j.capId && j.v != null && OPEN_STEPS.includes(j.step)).map(async (j) => {
    out.set(j._id, await h.outputs.countDocuments({ capId: j.capId!, v: j.v!, $or: [{ check: { $exists: false } }, { "check.jobId": j._id }] } as any));
  }));
  return out;
}

// one worker job as a card (#46 A). kind comes from the trigger only; fromV is the job's real base, not today's head;
// title is never empty; label/outcome follow the #46 outcome table, plus the check rows of the shared design.
function workerRow(j: WorkerJob, ctx: { cap?: Capability | null; privateOwner?: string | null; isPrivate?: boolean; runs?: number } = {}) {
  const { cap, privateOwner = null, isPrivate = false } = ctx;
  const head = cap?.versions.find((x) => x.v === cap.activeVersion);
  const kind = kindOf(j.trigger);
  const workerOf = j.claimedBy?.split(":")[1] ?? privateOwner ?? null;
  const fromV = kind === "new tool" || kind === "checking" ? null : cap?.versions.find((x) => x.v === j.v)?.supersedes ?? head?.v ?? null;
  const v = j.v ?? (kind === "new tool" ? 1 : kind === "checking" ? newestUntested(cap)?.v ?? null : nextV(cap));
  const stage = stageOf(j.step);
  const vd = j.verdict;
  const frac = vd && vd.total ? ` · ${evalWord(vd)}` : "";
  // notes can carry a whole worker error (cli flags, stderr); labels keep the first line, clipped
  const fullNote = noFrac(j.note);
  const firstLine = fullNote.split("\n")[0];
  const note = firstLine.length > 120 ? `${firstLine.slice(0, 117).trimEnd()}…` : firstLine;

  // a check: the worker writes its own reference implementation of vN, replays the version's runs and compares
  const checkedV = cap?.versions.find((x) => x.v === v);
  const promotedByCheck = !isPrivate && (checkedV?.status === "active" || checkedV?.status === "superseded");
  const K = vd?.total ?? ctx.runs ?? null;
  const agreed = vd?.passed ?? 0;
  const needPerson = vd ? vd.total - vd.passed : 0;
  const onRuns = K == null ? "its runs" : runsWord(K);

  const outcome: Outcome =
    j.step === "proposed" ? (kind === "checking" ? (promotedByCheck ? "promoted" : "draft") : vd && vd.total > 0 ? "promoted" : "draft") :
    j.step === "rejected" ? "rejected" : j.step === "skipped" ? "skipped" : null;
  const label =
    stage === "queued" ? (kind === "checking" ? `queued · check v${v ?? "?"} on ${onRuns}` : "queued") :
    kind === "checking" && stage === "drafting" ? `checking v${v} on ${onRuns} · writing a reference` :
    kind === "checking" && stage === "testing" ? `checking v${v} on ${onRuns} · replaying runs` :
    kind === "checking" && outcome !== "skipped" && outcome !== "rejected" ? (
      isPrivate ? `agrees on ${agreed} of ${runsWord(vd?.total ?? 0)} (record only)` :
      promotedByCheck ? `agrees on ${runsWord(agreed)}, promoted v${v}` :
      needPerson > 0 ? `agrees on ${runsWord(agreed)}, ${needPerson} need${needPerson === 1 ? "s" : ""} a person` :
      `agrees on ${runsWord(agreed)}`) :
    stage === "drafting" ? (kind === "new tool" ? "drafting" : `drafting v${v}`) :
    stage === "testing" ? (kind === "new tool" ? "smoke test on the session's example" : `testing on ${vd?.total ?? "the"} evals`) :
    outcome === "draft" ? `saved untested draft v${v}` :
    outcome === "promoted" ? `promoted v${v}${frac}` :
    outcome === "rejected" ? (vd && vd.total && kind !== "checking" ? `rejected v${v}${frac}` : `stopped: ${note || "worker error"}`) :
    `skipped: ${note || "no reason given"}`;
  return {
    id: j._id, hive: j.hive, tool: j.capId ?? null, kind, trigger: j.trigger as string,
    title: j.capId ?? `reading ${workerOf ?? "a"}'s session`,
    workerOf, toolOwner: head?.author ?? null, fromV, v,
    stage, step: j.step, outcome, label,
    // a finished check that left runs for a person (shared hive only): tints the card and its activity line
    needsPerson: kind === "checking" && j.step === "proposed" && !isPrivate && !promotedByCheck && needPerson > 0,
    verdict: vd, model: j.model, note: fullNote, createdAt: j.createdAt, updatedAt: j.updatedAt,
  };
}

// cards for a hive (#46 A): hidden rows dropped (done without a capId), one card per tool (an in-flight job wins,
// else the newest; the rest are `older`), in-flight cards first then done ones newest first.
// running / queued count jobs, not cards, so two open jobs on one tool both show in the header.
function groupCards(rows: ReturnType<typeof workerRow>[]): { cards: WorkerCard[]; running: number; queued: number } {
  const shown = rows.filter((r) => !(r.stage === "done" && !r.tool));
  const live = (r: { stage: Stage }) => Number(r.stage !== "done");
  const by = new Map<string, WorkerCard>();
  for (const r of shown.sort((a, b) => live(b) - live(a) || +new Date(b.updatedAt) - +new Date(a.updatedAt))) {
    const key = r.tool ?? r.id;
    const card = by.get(key);
    if (!card) by.set(key, { ...r, older: [] });
    else card.older.push(r);
  }
  const cards = [...by.values()].sort((a, b) => live(b) - live(a) || +new Date(b.updatedAt) - +new Date(a.updatedAt));
  return {
    cards,
    running: shown.filter((r) => r.stage === "drafting" || r.stage === "testing").length,
    queued: shown.filter((r) => r.stage === "queued").length,
  };
}

export async function workerActivity(name: string, limit = 60) {
  const h = hive(name);
  const [info, jobs] = await Promise.all([hives.findOne({ _id: name }), h.workerJobs.find().sort({ updatedAt: -1 }).limit(limit).toArray()]);
  const privateOwner = info?.visibility === "private" ? info.owner : null;
  const [caps, runs] = await Promise.all([
    h.capabilities.find({ _id: { $in: [...new Set(jobs.map((j) => j.capId).filter((x): x is string => !!x))] } }).toArray(),
    checkRuns(h, jobs),
  ]);
  return groupCards(jobs.map((j) => workerRow(j, { cap: caps.find((c) => c._id === j.capId), privateOwner, isPrivate: !!privateOwner, runs: runs.get(j._id) })));
}

// ---- one state per tool (shared design item 4) ----
// the ONLY place a tool's state is decided. the honeycomb queue, the tool page header and the worker/activity
// copy all read this, so solo and shared hives, drafts and promoted tools move through one lifecycle.
export type ToolStateName = "drafting" | "checking" | "improving" | "needs-judgment" | "failing" | "untested" | "passing";
export const STATE_ORDER: ToolStateName[] = ["drafting", "checking", "improving", "needs-judgment", "failing", "untested", "passing"];
export const STATE_TONE: Record<ToolStateName, Tone> = {
  drafting: "info", checking: "info", improving: "info", "needs-judgment": "warn", untested: "warn", failing: "bad", passing: "good",
};
export const stateWord = (s: ToolStateName) => (s === "needs-judgment" ? "needs judgment" : s);

export interface ToolState {
  capId: string;
  state: ToolStateName;
  word: string;
  tone: Tone;
  next: string; // the next step, short
  detail: string; // the next step, explained (tooltip)
  openJob?: { id: string; kind: WorkerKind; step: WorkerJob["step"]; v: number | null; runs: number | null };
  checkedRuns: number; // runs a worker's check has covered
  disagreeRuns: number; // runs the check disagreed with that no person has judged yet
  evals: number;
  promotedV: number | null;
  promotedScore: CapabilityVersion["score"] | null;
  draftV: number | null;
  private: boolean;
}

export async function toolStates(name: string, given?: Capability[]): Promise<Record<string, ToolState>> {
  const h = hive(name);
  const [info, caps, open, outs, keys] = await Promise.all([
    hives.findOne({ _id: name }, { projection: { visibility: 1 } }),
    given ?? h.capabilities.find().toArray(),
    h.workerJobs.find({ step: { $in: OPEN_STEPS } }).sort({ createdAt: 1 }).toArray(),
    // counts only; outputs.check is optional (backend branch), so missing fields count as zero
    h.outputs.aggregate<{ _id: string; checked: number; disagree: number }>([
      ...(given ? [{ $match: { capId: { $in: given.map((c) => c._id) } } }] : []),
      { $group: {
        _id: "$capId",
        checked: { $sum: { $cond: [{ $eq: [{ $type: "$check" }, "object"] }, 1, 0] } },
        disagree: { $sum: { $cond: [{ $and: [{ $eq: ["$check.agree", false] }, { $ne: [{ $type: "$feedback" }, "object"] }] }, 1, 0] } },
      } },
    ]).toArray(),
    // how many evals, never which: only the array size leaves the database
    h.answerKeys.aggregate<{ _id: string; n: number }>([{ $project: { n: { $size: { $ifNull: ["$cases", []] } } } }]).toArray(),
  ]);
  const isPrivate = info?.visibility === "private";
  const runs = await checkRuns(h, open);
  const out: Record<string, ToolState> = {};
  for (const cap of caps) {
    const promoted = rank(cap)[0] ?? null;
    const draft = newestUntested(cap) ?? null;
    const o = outs.find((x) => x._id === cap._id);
    const evals = keys.find((k) => k._id === cap._id)?.n ?? 0;
    const checkedRuns = o?.checked ?? 0;
    const disagreeRuns = o?.disagree ?? 0;
    const jobs = open.filter((j) => j.capId === cap._id).map((j) => ({ j, kind: kindOf(j.trigger) }));
    const pick = (k: WorkerKind | WorkerKind[]) => jobs.find((x) => ([] as WorkerKind[]).concat(k).includes(x.kind));
    const job = pick("new tool") ?? pick("checking") ?? pick(["improving", "repair"]);
    const fails = promoted?.score ? promoted.score.total - promoted.score.passed : 0;

    const state: ToolStateName =
      job?.kind === "new tool" ? "drafting" :
      job?.kind === "checking" ? "checking" :
      job ? "improving" :
      !promoted && disagreeRuns > 0 ? "needs-judgment" :
      promoted && fails > 0 ? "failing" :
      !promoted ? "untested" : "passing";

    const jobV = job ? job.j.v ?? (job.kind === "new tool" ? 1 : job.kind === "checking" ? draft?.v ?? null : nextV(cap)) : null;
    const jobRuns = job ? runs.get(job.j._id) ?? null : null;
    const [next, detail] = ((): [string, string] => {
      switch (state) {
        case "drafting": return [`a worker is drafting v${jobV ?? 1}`, "a worker turned a repeated investigation into this tool and is smoke testing it on the session's example."];
        case "checking": return [
          `a worker is checking ${jobRuns == null ? "its runs" : runsWord(jobRuns)}`,
          `a worker writes its own implementation of v${jobV ?? "?"}, replays ${jobRuns == null ? "its runs" : runsWord(jobRuns)} and compares answers. ${isPrivate
            ? "in a private hive the agreement is only recorded."
            : "runs where both implementations agree become provisional evals; the rest go to a person."}`,
        ];
        case "improving": return [`a worker is drafting v${jobV ?? "?"}`, `${promoted ? `promoted v${promoted.v} ${fails ? `fails ${fails} eval${fails === 1 ? "" : "s"}` : "is being reworked"}. ` : ""}a worker is drafting v${jobV ?? "?"}; it is promoted only if it beats the current version on evals its author didn't add.`];
        case "needs-judgment": return [`judge ${runsWord(disagreeRuns)}`, `a worker's check disagreed with ${runsWord(disagreeRuns)}. open them in activity and mark each ✓ or ✗; a person's answer becomes an eval.`];
        case "failing": return ["waiting for a worker", `promoted v${promoted!.v} fails ${fails} eval${fails === 1 ? "" : "s"}. the next feedback queues a worker to improve it.`];
        case "untested": return isPrivate
          ? ["yours to try; publish it to share", `only you run ${draft ? `draft v${draft.v}` : "it"} here. publish it to a shared hive, where evals decide.`]
          : ["run it; a teammate's worker checks it", `no evals yet, so nothing is promoted. every run is kept; a teammate's worker checks them, and a person's ✓ or ✗ becomes an eval.`];
        case "passing": return ["up to date", `promoted v${promoted!.v} passes every eval${evals ? ` (${evals} in the hive)` : ""}.`];
      }
    })();

    out[cap._id] = {
      capId: cap._id, state, word: stateWord(state), tone: STATE_TONE[state], next, detail,
      openJob: job ? { id: job.j._id, kind: job.kind, step: job.j.step, v: jobV, runs: jobRuns } : undefined,
      checkedRuns, disagreeRuns, evals,
      promotedV: promoted?.v ?? null, promotedScore: promoted?.score ?? null, draftV: draft?.v ?? null, private: isPrivate,
    };
  }
  return out;
}

// the honeycomb as a queue: in-flight and needs-you first, passing last; ties keep the given order (newest first)
export function byState<T extends { _id: string }>(caps: T[], states: Record<string, ToolState>): T[] {
  const i = (c: T) => STATE_ORDER.indexOf(states[c._id]?.state ?? "passing");
  return caps.map((c, n) => ({ c, n })).sort((a, b) => i(a.c) - i(b.c) || a.n - b.n).map((x) => x.c);
}

// eval provenance words for the tool page: seeded, human feedback and worker agreement stay distinguished (direction.md)
export const evalSource = (s: CaseSource) =>
  s === "worker_agreement" ? { label: "auto-check (two implementations agree)", tone: "info" as Tone } :
  s === "accepted_run" ? { label: "feedback: marked correct", tone: "good" as Tone } :
  s === "corrected_run" ? { label: "feedback: corrected", tone: "good" as Tone } :
  { label: "seeded", tone: undefined };
