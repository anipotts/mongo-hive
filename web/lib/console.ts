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

export type Verb = "drafted" | "tested" | "promoted" | "rejected" | "published" | "pinned" | "ran" | "gave feedback";
export interface Actor { user: string; worker: boolean; harness?: string }
export interface Line {
  id: string;
  actor: Actor;
  verb: Verb;
  tool?: string;
  v?: number;
  result?: string;
  outputId?: string; // on "ran" lines: what the console's ✓/✗ buttons pass to giveFeedback (#18)
  judged?: "correct" | "wrong"; // set once a person has given feedback on that run
  at: Date;
  hive: string;
}
export interface SessionLine {
  id: string;
  actor: Actor;
  kind: "session";
  title?: string;
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
    : x.status === "rejected" ? `${evalWord(x.score)}, not promoted` : x.status;
  return { id: `${h}/${cap._id}/v${x.v}`, actor: actorOf(x), verb, tool: cap._id, v: x.v, result, at: x.createdAt, hive: h };
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
  const sessions = await h.db.collection("sessions").find({ lastEventAt: { $gte: since } }, { projection: { cwd: 0 } }).sort({ lastEventAt: -1 }).limit(limit).toArray();
  if (!sessions.length) return [];
  const counts = await h.events.aggregate<{ _id: { s: string; k: string }; n: number }>([
    { $match: { sessionId: { $in: sessions.map((s) => s._id) } } },
    { $group: { _id: { s: "$sessionId", k: "$kind" }, n: { $sum: 1 } } },
  ]).toArray();
  const n = (s: unknown, k: string) => counts.find((c) => c._id.s === s && c._id.k === k)?.n ?? 0;
  const now = Date.now();
  return sessions.map((s: any) => ({
    id: String(s._id), actor: actorOf(s), kind: "session", title: s.title, toolCalls: n(s._id, "tool"), prompts: n(s._id, "prompt"),
    online: now - +new Date(s.lastEventAt) < ONLINE_MS, startedAt: s.startedAt, lastEventAt: s.lastEventAt, hive: h.name,
  }));
}

// every run is an `outputs` doc (run_capability and native tools alike), so "ran" lines come from there,
// with the feedback verdict if a person already judged it. result rows stay server-side; only the count leaves.
async function runLines(h: Hive, since: Date, limit: number): Promise<Line[]> {
  const outs = await h.outputs
    .find({ at: { $gte: since } }, { projection: { args: 0, "result": { $slice: 0 } } as any })
    .sort({ at: -1 }).limit(limit).toArray() as any[];
  const counts = await h.outputs.aggregate<{ _id: string; n: number }>([
    { $match: { _id: { $in: outs.map((o) => o._id) } } },
    { $project: { n: { $size: { $ifNull: ["$result", []] } } } },
  ]).toArray();
  const n = new Map(counts.map((c) => [c._id, c.n]));
  return outs.map((o) => ({
    id: String(o._id), actor: actorOf(o), verb: "ran" as Verb, tool: o.capId, v: o.v,
    result: `${n.get(o._id) ?? 0} result${n.get(o._id) === 1 ? "" : "s"}${o.feedback ? ` · judged ${o.feedback.verdict} by ${o.feedback.by}` : ""}`,
    outputId: String(o._id), judged: o.feedback?.verdict as "correct" | "wrong" | undefined, at: o.at, hive: h.name,
  }));
}

// F1/F2: hive changes (versions, runs, pins, feedback) and agent sessions collapsed to one line each. newest first.
export async function feed(name: string, opts: { since?: Date; limit?: number } = {}) {
  const h = hive(name);
  const since = opts.since ?? new Date(Date.now() - 24 * 3600_000);
  const limit = opts.limit ?? 60;
  const [caps, events, runs, sessions] = await Promise.all([
    h.capabilities.find().toArray(),
    h.events.find({ at: { $gte: since }, $or: [{ tool: { $in: ["pin_capability", "feedback"] } }, { kind: "feedback" }] }).sort({ at: -1 }).limit(limit).toArray(),
    runLines(h, since, limit),
    sessionLines(h, since, 20),
  ]);
  const changes = [
    ...caps.flatMap((c) => c.versions.filter((x) => new Date(x.createdAt) >= since).map((x) => versionLine(name, c, x))),
    ...events.map((e) => eventLine(name, e)).filter((l): l is Line => !!l),
    ...runs,
  ].sort((a, b) => +new Date(b.at) - +new Date(a.at)).slice(0, limit);
  return { changes, sessions };
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
  const [pins, evals, failing, tests, jobs] = await Promise.all([
    pinsByVersion(h, id), evalHistory(h, cap), failingByVersion(h, cap), evalSuite(h, id),
    h.workerJobs.find({ capId: id }).sort({ updatedAt: -1 }).limit(20).toArray(),
  ]);
  return {
    hive: name, id, directive: cap.directive, scope: cap.scope, head: cap.activeVersion,
    leaderboard: rank(cap).map((x, i) => ({ rank: i + 1, v: x.v, author: x.author, harness: x.harness, worker: isWorker(x), score: x.score })),
    versions: timeline(cap).map((t) => ({ ...t, worker: t.harness === "worker", provenance: provenance(cap, cap.versions.find((x) => x.v === t.v)!, failing), evals: evals[t.v] ?? [], pinnedBy: pins.pinned[t.v] ?? [], runningOn: pins.running[t.v] ?? [] })),
    diff: cap.activeVersion != null ? recipeDiff(cap, cap.activeVersion) : null,
    evals: tests,
    worker: groupCards(jobs.map((j) => workerRow(j, cap))).cards,
  };
}

// S1 stage bar: queued, drafting, testing, done
export type Stage = "queued" | "drafting" | "testing" | "done";
const stageOf = (s: WorkerJob["step"]): Stage => (s === "queued" ? "queued" : s === "drafting" ? "drafting" : s === "validating" ? "testing" : "done");

export type Outcome = "promoted" | "draft" | "rejected" | "skipped" | null;
export type WorkerCard = ReturnType<typeof workerRow> & { older: ReturnType<typeof workerRow>[] };

// one worker job as a card (#46 A). kind comes from the trigger only; fromV is the job's real base, not today's head;
// title is never empty; label/outcome follow the #46 outcome table exactly.
function workerRow(j: WorkerJob, cap?: Capability | null, privateOwner?: string | null) {
  const head = cap?.versions.find((x) => x.v === cap.activeVersion);
  const kind = j.trigger === "repetition" || j.trigger === "session_end" ? "new tool" : j.trigger === "split" ? "repair" : "improving";
  const workerOf = j.claimedBy?.split(":")[1] ?? privateOwner ?? null;
  const fromV = kind === "new tool" ? null : cap?.versions.find((x) => x.v === j.v)?.supersedes ?? head?.v ?? null;
  const v = j.v ?? (kind === "new tool" ? 1 : cap?.nextVersion ?? null);
  const stage = stageOf(j.step);
  const vd = j.verdict;
  const frac = vd && vd.total ? ` · ${evalWord(vd)}` : "";
  const outcome: Outcome =
    j.step === "proposed" ? (vd && vd.total > 0 ? "promoted" : "draft") :
    j.step === "rejected" ? "rejected" : j.step === "skipped" ? "skipped" : null;
  const label =
    stage === "queued" ? "queued" :
    stage === "drafting" ? (kind === "new tool" ? "drafting" : `drafting v${v}`) :
    stage === "testing" ? (kind === "new tool" ? "smoke test on the session's example" : `testing on ${vd?.total ?? "the"} evals`) :
    outcome === "draft" ? `saved untested draft v${v}` :
    outcome === "promoted" ? `promoted v${v}${frac}` :
    outcome === "rejected" ? (vd && vd.total ? `rejected v${v}${frac}` : `rejected: ${j.note ?? "worker error"}`) :
    `skipped: ${j.note ?? ""}`;
  return {
    id: j._id, hive: j.hive, tool: j.capId ?? null, kind, trigger: j.trigger,
    title: j.capId ?? `reading ${workerOf ?? "a"}'s session`,
    workerOf, toolOwner: head?.author ?? null, fromV, v,
    stage, step: j.step, outcome, label,
    verdict: vd, model: j.model, note: j.note, createdAt: j.createdAt, updatedAt: j.updatedAt,
  };
}

// cards for a hive (#46 A): hidden rows dropped (done without a capId), one card per tool (newest job wins, the rest
// are `older`), in-flight cards first then done ones newest first. `running` counts in-flight cards.
function groupCards(rows: ReturnType<typeof workerRow>[]): { cards: WorkerCard[]; running: number } {
  const shown = rows.filter((r) => !(r.stage === "done" && !r.tool));
  const by = new Map<string, WorkerCard>();
  for (const r of shown.sort((a, b) => +new Date(b.updatedAt) - +new Date(a.updatedAt))) {
    const key = r.tool ?? r.id;
    const card = by.get(key);
    if (!card) by.set(key, { ...r, older: [] });
    else card.older.push(r);
  }
  const cards = [...by.values()].sort((a, b) => Number(b.stage !== "done") - Number(a.stage !== "done") || +new Date(b.updatedAt) - +new Date(a.updatedAt));
  const running = cards.filter((c) => c.stage !== "done").length;
  return { cards, running };
}

export async function workerActivity(name: string, limit = 60) {
  const h = hive(name);
  const [info, jobs] = await Promise.all([hives.findOne({ _id: name }), h.workerJobs.find().sort({ updatedAt: -1 }).limit(limit).toArray()]);
  const privateOwner = info?.visibility === "private" ? info.owner : null;
  const caps = await h.capabilities.find({ _id: { $in: [...new Set(jobs.map((j) => j.capId).filter((x): x is string => !!x))] } }).toArray();
  return groupCards(jobs.map((j) => workerRow(j, caps.find((c) => c._id === j.capId), privateOwner)));
}
