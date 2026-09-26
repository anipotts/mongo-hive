// hive notices: what other people (and workers) did to your tools since you last looked, as short plain lines.
// the detached hook writer drops these into ~/.mongo-hive/inbox.jsonl; the hook shows them in the agent's chat.
// only ids, versions, people and counts leave atlas here: never eval args/expected outputs, answer keys, prompts
// or result rows, and never raw job notes (they can quote a session's task).
import { hive, hives, canAccess } from "../registry/db.js";
import type { Capability, CapabilityVersion, WorkerJob } from "../registry/types.js";

export interface Notice { at: string; hive: string; text: string }

const DAY = 24 * 60 * 60_000;
// names come from other people's writes and land in an agent's context: keep them to plain id characters
const clean = (s: unknown) => String(s ?? "").replace(/[^\w.@-]/g, "").slice(0, 60) || "?";
const consoleBase = () => (process.env.HIVE_CONSOLE_URL ?? "http://localhost:3000").replace(/\/+$/, "");
const toolUrl = (h: string, tool: string) => `${consoleBase()}/hive/${encodeURIComponent(h)}/tool/${encodeURIComponent(tool)}`;

// no x/10 anywhere: "passes all evals" or "fails 2"
const evalWord = (s?: { passed: number; total: number } | null) =>
  !s || !s.total ? "no evals yet" : s.passed === s.total ? "passes all evals" : `fails ${s.total - s.passed}`;
const workerOf = (claimedBy?: string) => (claimedBy?.startsWith("worker:") ? `${clean(claimedBy.split(":")[1])}'s worker` : "a worker");
// first head of a tool: it just became callable by name as a native tool
const callHint = (cap: Pick<Capability, "_id" | "activeVersion" | "versions"> | undefined, v?: number) => {
  const ver = cap?.versions.find((x) => x.v === v);
  return cap && ver && cap.activeVersion === v && ver.supersedes == null ? ` (call it by name: ${clean(cap._id)})` : "";
};

function versionOutcome(x: Pick<CapabilityVersion, "status" | "score" | "reason" | "supersedes">) {
  if (x.status === "active" || x.status === "superseded") return `${evalWord(x.score)}, promoted${x.supersedes != null ? ` over v${x.supersedes}` : ""}`;
  if (x.status === "unverified") return "saved unverified, no evals yet";
  if (x.status !== "rejected") return clean(x.status);
  const r = x.reason ?? "";
  if (r.startsWith("inputs changed")) return "rejected: inputs changed, needs a new tool name";
  if (!x.score?.total) return "rejected: no evals for it in this hive";
  const why = r.includes("floor") ? ", below the floor to lead" : r.includes("does not beat") ? ", does not beat the head" : "";
  return `rejected: ${evalWord(x.score)}${why}`;
}

function jobText(j: WorkerJob, cap?: Capability) {
  const who = workerOf(j.claimedBy);
  const tool = clean(j.capId);
  const v = j.v != null ? ` v${j.v}` : "";
  const vd = j.verdict;
  if (j.step === "skipped") return `${who} looked at ${tool} and left it as it was`;
  const outcome = j.step === "proposed" ? (vd?.total ? `promoted${v}` : `saved untested draft${v}`) : "not promoted";
  const hint = j.step === "proposed" ? callHint(cap, j.v) : "";
  switch (j.trigger as string) {
    case "check": {
      const detail = !vd?.total ? "no runs to compare" : vd.passed === vd.total ? `agrees on ${vd.total} runs` : `agrees on ${vd.passed} runs, disagrees on ${vd.total - vd.passed}`;
      // a check only promotes when nothing disagrees; read the tool, not the job, to say what really happened
      const nowPromoted = cap?.activeVersion != null && cap.activeVersion === j.v;
      const result = !vd?.total ? "nothing to compare yet" : vd.passed < vd.total ? "a person should judge the rest" : nowPromoted ? `promoted${v}` : "not promoted";
      return `${who} checked ${tool}${v}: ${detail}, ${result}${nowPromoted ? hint : ""}`;
    }
    case "improve":
      return `${who} ${j.step === "proposed" ? "improved" : "tried to improve"} ${tool}:${v} ${evalWord(vd)}, ${outcome}${hint}`;
    case "repetition":
    case "session_end":
      return `${who} made a new tool ${tool}: ${evalWord(vd)}, ${outcome}${hint}`;
    default:
      return `${who} worked on ${tool}:${v} ${evalWord(vd)}, ${outcome}${hint}`;
  }
}

const VERSION_FIELDS = { activeVersion: 1, "versions.v": 1, "versions.author": 1, "versions.harness": 1, "versions.status": 1, "versions.score": 1, "versions.reason": 1, "versions.supersedes": 1, "versions.createdAt": 1 };

// notices in one hive for `user` in (since, until]. relevant tools: ones the user authored a version of or ran in the
// last day; in a shared hive, a brand new tool from someone else also counts (it is new to everyone).
export async function hiveNotices(name: string, user: string, since: Date, until: Date, shared: boolean): Promise<Notice[]> {
  const h = hive(name);
  const window = { $gt: since, $lte: until };
  const [authored, ran, changed] = await Promise.all([
    h.capabilities.distinct("_id", { "versions.author": user }),
    h.outputs.distinct("capId", { user, at: { $gt: new Date(until.getTime() - DAY) } }),
    h.capabilities.find({ "versions.createdAt": window }, { projection: VERSION_FIELDS }).toArray(),
  ]);
  const caps = new Map(changed.map((c) => [c._id, c as Capability]));
  const isNew = (c: Capability) => c.versions.every((x) => new Date(x.createdAt) > since);
  const relevant = new Set<string>([...authored, ...ran]);
  if (shared) for (const c of changed) if (isNew(c)) relevant.add(c._id);
  if (!relevant.size) return [];
  const ids = [...relevant];

  const [runs, judged, jobs] = await Promise.all([
    h.outputs.aggregate<{ _id: { user: string; capId: string; v: number }; n: number; at: Date }>([
      { $match: { capId: { $in: ids }, user: { $ne: user }, at: window } },
      { $group: { _id: { user: "$user", capId: "$capId", v: "$v" }, n: { $sum: 1 }, at: { $max: "$at" } } },
    ]).toArray(),
    h.outputs.find(
      { capId: { $in: ids }, "feedback.by": { $exists: true, $ne: user }, "feedback.at": window },
      { projection: { capId: 1, v: 1, user: 1, "feedback.verdict": 1, "feedback.by": 1, "feedback.at": 1 } },
    ).toArray(),
    h.workerJobs.find(
      { capId: { $in: ids }, step: { $in: ["proposed", "rejected", "skipped"] }, updatedAt: window },
      { projection: { note: 0 } },
    ).toArray(),
  ]);
  // a job's promotion and the version it wrote would say the same thing twice
  const missing = jobs.filter((j) => j.capId && !caps.has(j.capId)).map((j) => j.capId!);
  if (missing.length)
    for (const c of await h.capabilities.find({ _id: { $in: missing } }, { projection: VERSION_FIELDS }).toArray()) caps.set(c._id, c as Capability);

  const out: { at: Date; text: string; tool: string }[] = [];
  for (const r of runs)
    out.push({ at: r.at, tool: r._id.capId, text: `${clean(r._id.user)} ran ${clean(r._id.capId)} v${r._id.v}${r.n > 1 ? ` (${r.n} runs)` : ""}` });
  for (const o of judged) {
    const by = clean(o.feedback!.by);
    const whose = o.user === user ? "your" : o.user === o.feedback!.by ? "their own" : `${clean(o.user)}'s`;
    out.push({ at: o.feedback!.at, tool: o.capId, text: `${by} marked ${whose} ${clean(o.capId)} v${o.v} run ${o.feedback!.verdict === "correct" ? "correct" : "wrong"}` });
  }
  const covered = new Set<string>();
  for (const j of jobs) {
    if (j.v != null) covered.add(`${j.capId}/${j.v}`);
    out.push({ at: j.updatedAt, tool: j.capId!, text: jobText(j, caps.get(j.capId!)) });
  }
  for (const c of changed) {
    if (!relevant.has(c._id)) continue;
    const first = Math.min(...c.versions.map((x) => x.v));
    for (const x of c.versions) {
      const at = new Date(x.createdAt);
      if (!(at > since && at <= until) || covered.has(`${c._id}/${x.v}`)) continue;
      const worker = x.harness === "worker";
      if (x.author === user && !worker) continue; // your own agent's publish: you already know
      const who = worker ? `${clean(x.author)}'s worker` : clean(x.author);
      const what = x.v === first ? `a new tool ${clean(c._id)} v${x.v}` : `${clean(c._id)} v${x.v}`;
      out.push({ at, tool: c._id, text: `${who} published ${what}: ${versionOutcome(x)}${callHint(c as Capability, x.v)}` });
    }
  }
  return out
    .sort((a, b) => +new Date(a.at) - +new Date(b.at))
    .map((n) => ({ at: new Date(n.at).toISOString(), hive: name, text: `${n.text}: ${toolUrl(name, clean(n.tool))}` }));
}

// the hives a hook writer looks at: the bound shared hive and the user's private hive, if the user belongs to them
export async function noticeHives(user: string, shared?: string) {
  const names = [...new Set([shared, user].filter(Boolean) as string[])];
  const infos = await hives.find({ _id: { $in: names } }).toArray();
  return infos.filter((i) => canAccess(i, user)).map((i) => ({ name: i._id, shared: i.visibility === "shared" }));
}
