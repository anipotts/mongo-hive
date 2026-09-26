// the improve loop shared by `npm run improve` and the always-on worker: take a tool's best version, let the
// worker propose v+1 from the failing eval categories, let the evals judge, repeat until perfect or no gain.
import { HIVE_USER, type Hive } from "../registry/db.js";
import type { Capability, CapabilityVersion, WorkerJob } from "../registry/types.js";
import { rank } from "../validator/index.js";
import { draftAndCommit, failingFor, outputFields, startJob, type Attempt } from "./index.js";
import type { Llm } from "./llm.js";

export const ratio = (s?: CapabilityVersion["score"]) => (s && s.total ? s.passed / s.total : 0);
export const frac = (s?: CapabilityVersion["score"]) => (s ? `${s.passed}/${s.total}` : "unscored");

// the version to improve on: the promoted version, else the best scored attempt so far
export const baseOf = (c: Capability) => c.versions.find((v) => v.v === c.activeVersion) ?? rank(c)[0] ??
  [...c.versions].filter((v) => v.score?.total).sort((a, b) => ratio(b.score) - ratio(a.score))[0];

// whose tool this is: the author of its first version
export const ownerOf = (c: Capability) => c.versions[0]?.author ?? "someone";

export interface RoundEvent {
  round: number; job: WorkerJob; base: CapabilityVersion; nextV: number; evals: number;
  result?: { v: number; promoted: boolean; score?: CapabilityVersion["score"]; headScore?: CapabilityVersion["score"]; summary: string; failing: string[] };
  skipped?: string;
}

// runs up to `rounds` improve rounds on one tool. the first round can reuse an already-claimed job.
export async function improveTool(h: Hive, capId: string, opts: { rounds: number; llm: Llm; firstJob?: WorkerJob; on?: (e: RoundEvent) => void }) {
  const cap = await h.capabilities.findOne({ _id: capId });
  if (!cap || !baseOf(cap)) return { improved: false, reason: `no scored version of ${capId} to improve` };
  const evals = (await h.answerKeys.findOne({ _id: capId }))?.cases.length ?? 0;
  const output = await outputFields(h, capId);
  let best = ratio(baseOf(cap)!.score);
  let stale = 0;
  const history: Attempt[] = [];
  for (let r = 1; r <= opts.rounds; r++) {
    const now = (await h.capabilities.findOne({ _id: capId }))!;
    const base = baseOf(now)!;
    const failing = await failingFor(h, capId, base);
    const note = `round ${r}: improve on v${base.v} (${frac(base.score)}); failing ${failing.join(", ") || "none"}`;
    const reuse = r === 1 && opts.firstJob;
    const job = reuse ? opts.firstJob! : await startJob(h, { trigger: "improve", capId, note });
    if (reuse) await h.workerJobs.updateOne({ _id: job._id }, { $set: { note, updatedAt: new Date() } });
    const nextV = (now.nextVersion ?? now.versions.length) + 1;
    opts.on?.({ round: r, job, base, nextV, evals });
    const res = await draftAndCommit({ h, cap: now, params: base.params, collection: base.collection, output, base, failing, history, job, llm: opts.llm });
    if (!res) {
      const j = await h.workerJobs.findOne({ _id: job._id });
      opts.on?.({ round: r, job, base, nextV, evals, skipped: j?.note ?? "draft unusable" });
      stale++;
    } else {
      history.push(res.attempt);
      opts.on?.({
        round: r, job, base, nextV, evals,
        result: { v: res.version.v, promoted: res.decision.activate, score: res.decision.score, headScore: base.score, summary: res.summary, failing: res.failing },
      });
      const got = ratio(res.decision.score);
      if (got > best) { best = got; stale = 0; } else stale++;
      if (got === 1 && res.decision.activate) break;
    }
    if (stale >= 2) break;
  }
  const end = (await h.capabilities.findOne({ _id: capId }))!;
  return { improved: ratio(baseOf(end)?.score) > ratio(baseOf(cap)?.score), head: end.activeVersion, score: baseOf(end)?.score, by: HIVE_USER };
}
