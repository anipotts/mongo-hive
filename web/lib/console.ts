import "server-only";
import { hive, hives, type Hive } from "../../src/registry/db";
import type { AnswerKey, Capability, CapabilityVersion, WorkerJob } from "../../src/registry/types";
import { rank, standing } from "../../src/validator/index";
import { eventName, eventTool } from "./events";
import { evalHistory, pinsByVersion, recipeDiff, timeline } from "./versions";

// console-v2 data (#6). every surface speaks one grammar (ui audit on #6):
//   [actor] [verb] [tool · version] [result] · [time]
// the ui renders the same Line as a feed row, table row or badge. nothing here returns hidden case inputs
// except testSuite(), which is for humans in the console only (agents never reach web/).

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
const frac = (s?: Score) => (s ? `${s.passed}/${s.total}` : "unscored");
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
    ? x.supersedes != null ? `${frac(x.score)} on evals, promoted over v${x.supersedes}` : `${frac(x.score)} on evals, promoted`
    : x.status === "rejected" ? `${frac(x.score)}, ${x.reason ?? "rejected"}` : x.status;
  return { id: `${h}/${cap._id}/v${x.v}`, actor: actorOf(x), verb, tool: cap._id, v: x.v, result, at: x.createdAt, hive: h };
}

// mcp-server and console events that change or use the hive. hook events are folded into sessions instead.
function eventLine(h: string, e: any): Line | null {
  const tool = eventTool(e);
  const a = e.args ?? {};
  if (tool === "run_capability") return { id: String(e._id), actor: actorOf(e), verb: "ran", tool: a.id, v: a.v, result: `${e.result?.count ?? 0} result${e.result?.count === 1 ? "" : "s"} in ${e.ms}ms`, outputId: e.result?.outputId ?? e.outputId, at: e.at, hive: h };
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

// F1: hive changes first, each agent session collapsed to one expandable line. newest first.
export async function feed(name: string, opts: { since?: Date; limit?: number } = {}) {
  const h = hive(name);
  const since = opts.since ?? new Date(Date.now() - 24 * 3600_000);
  const limit = opts.limit ?? 60;
  const [caps, events, sessions] = await Promise.all([
    h.capabilities.find().toArray(),
    h.events.find({ at: { $gte: since }, $or: [{ tool: { $in: ["run_capability", "pin_capability", "feedback"] } }, { kind: "feedback" }] }).sort({ at: -1 }).limit(limit).toArray(),
    sessionLines(h, since, 20),
  ]);
  const changes = [
    ...caps.flatMap((c) => c.versions.filter((x) => new Date(x.createdAt) >= since).map((x) => versionLine(name, c, x))),
    ...events.map((e) => eventLine(name, e)).filter((l): l is Line => !!l),
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

// roster: every agent seen in this hive, online from session recency, and its standing on every tool
export async function roster(name: string) {
  const h = hive(name);
  const [agents, caps, sessions] = await Promise.all([
    h.agents.find({}, { projection: { resumeToken: 0 } }).toArray(),
    h.capabilities.find().toArray(),
    h.db.collection("sessions").find({}, { projection: { user: 1, harness: 1, lastEventAt: 1, title: 1 } }).sort({ lastEventAt: -1 }).toArray(),
  ]);
  const now = Date.now();
  const ids = new Set([...agents.map((a) => a._id), ...sessions.map((s: any) => `${s.user}:${s.harness}`)]);
  return [...ids].sort().map((id) => {
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
// the hive's hidden tests with provenance. humans only: this is the one place case inputs leave the database.
export async function testSuite(h: Hive, capId: string) {
  // provenance fields are the contract's AnswerKey extension (#7 writes them); seeded cases predate it
  type Case = AnswerKey["cases"][number] & { source?: CaseSource; addedBy?: string; addedAt?: Date; outputId?: string; provisional?: boolean };
  const key = await h.answerKeys.findOne({ _id: capId });
  return ((key?.cases ?? []) as Case[]).map((c, i) => ({
    n: i + 1, category: c.category, args: c.args, expect: c.expect,
    source: c.source ?? "seed", addedBy: c.addedBy ?? "seed", addedAt: c.addedAt, outputId: c.outputId, provisional: !!c.provisional,
  }));
}

// everything the tool page needs in one call
export async function toolPage(name: string, id: string) {
  const h = hive(name);
  const cap = await h.capabilities.findOne({ _id: id });
  if (!cap) return null;
  const [pins, evals, failing, tests, jobs] = await Promise.all([
    pinsByVersion(h, id), evalHistory(h, cap), failingByVersion(h, cap), testSuite(h, id),
    h.workerJobs.find({ capId: id }).sort({ updatedAt: -1 }).limit(20).toArray(),
  ]);
  return {
    hive: name, id, directive: cap.directive, scope: cap.scope, head: cap.activeVersion,
    leaderboard: rank(cap).map((x, i) => ({ rank: i + 1, v: x.v, author: x.author, harness: x.harness, worker: isWorker(x), score: x.score })),
    versions: timeline(cap).map((t) => ({ ...t, worker: t.harness === "worker", provenance: provenance(cap, cap.versions.find((x) => x.v === t.v)!, failing), evals: evals[t.v] ?? [], pinnedBy: pins.pinned[t.v] ?? [], runningOn: pins.running[t.v] ?? [] })),
    diff: cap.activeVersion != null ? recipeDiff(cap, cap.activeVersion) : null,
    tests,
    worker: jobs.map((j) => workerRow(j, cap)),
  };
}

// S1 stage bar: queued, drafting, testing, done
export type Stage = "queued" | "drafting" | "testing" | "done";
const stageOf = (s: WorkerJob["step"]): Stage => (s === "queued" ? "queued" : s === "drafting" ? "drafting" : s === "validating" ? "testing" : "done");

// R1 row + N1 chip: which tool, new vs improving, whose tool, which version, which stage.
// fromV/toolOwner come from the tool's head (in-flight jobs have no v yet, so v falls back to the next number)
function workerRow(j: WorkerJob, cap?: Capability | null) {
  const head = cap?.versions.find((x) => x.v === cap.activeVersion);
  const kind = !head && j.trigger !== "improve" ? "new tool" : j.trigger === "split" ? "repair" : "improving";
  return {
    id: j._id, hive: j.hive, tool: j.capId, kind, trigger: j.trigger,
    workerOf: j.claimedBy?.split(":")[1] ?? null, // whose worker ran it ("kap's worker")
    toolOwner: head?.author ?? null, // whose tool it improves ("improving · kap's tool")
    fromV: head?.v ?? null, v: j.v ?? cap?.nextVersion ?? null,
    stage: stageOf(j.step), step: j.step, outcome: j.step === "proposed" ? "promoted" : j.step === "rejected" || j.step === "skipped" ? j.step : null,
    verdict: j.verdict, model: j.model, note: j.note, createdAt: j.createdAt, updatedAt: j.updatedAt,
  };
}

// worker activity for a hive: in-flight jobs first, then recent finished ones
export async function workerActivity(name: string, limit = 30) {
  const h = hive(name);
  const jobs = await h.workerJobs.find().sort({ updatedAt: -1 }).limit(limit).toArray();
  const caps = await h.capabilities.find({ _id: { $in: [...new Set(jobs.map((j) => j.capId).filter((x): x is string => !!x))] } }).toArray();
  const rows = jobs.map((j) => workerRow(j, caps.find((c) => c._id === j.capId)));
  return { active: rows.filter((r) => r.stage !== "done"), recent: rows.filter((r) => r.stage === "done") };
}
