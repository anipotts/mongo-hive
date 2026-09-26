// human feedback turns a real tool run into an eval. people grade, agents never do: there is no mcp tool for
// this, only the cli (/mongo-hive:accept, /mongo-hive:reject) and the console. every new eval re-scores the
// tool's versions, the leaderboard reorders, and a head that now fails queues an improve job for the worker.
import { canAccess, hives, type Hive } from "../registry/db.js";
import type { CapabilityVersion, EvalCase } from "../registry/types.js";
import { MIN_PASS_RATE, syncHead, toExpect, validate } from "../validator/index.js";
import { queueImprove } from "../worker/index.js";

export type Verdict = "correct" | "wrong";

export type FeedbackResult =
  | { ok: false; error: string }
  | {
      ok: true; outputId: string; capId: string; v: number; verdict: Verdict; repeat: boolean;
      evals: number; head: { v: number; passed: number; total: number } | null; previousHead: number | null;
      queuedImprove: boolean; summary: string;
    };

// statuses a new eval can change. rejected and archived versions stay as they were decided.
const RESCORABLE = new Set<CapabilityVersion["status"]>(["active", "superseded", "unverified", "stale"]);

export async function giveFeedback(opts: {
  h: Hive; outputId: string; by: string; harness?: string; verdict: Verdict; correction?: Record<string, unknown>;
}): Promise<FeedbackResult> {
  const { h, outputId, by, verdict } = opts;
  if (!canAccess(await hives.findOne({ _id: h.name }), by)) return { ok: false, error: `you (${by}) are not a member of hive ${h.name}` };
  const out = await h.outputs.findOne({ _id: outputId });
  if (!out) return { ok: false, error: `no run ${outputId} in hive ${h.name}` };

  let expect: Record<string, unknown>;
  if (verdict === "correct") {
    if (!out.result.length) return { ok: false, error: `run ${outputId} returned nothing; mark it wrong and give the right answer instead` };
    expect = toExpect(out.result);
  } else {
    if (!opts.correction || typeof opts.correction !== "object") return { ok: false, error: "a wrong verdict needs the right answer (--expect '{...}')" };
    expect = opts.correction;
  }

  // claim the run once: a second judgment on the same run is a no-op, never a second eval
  const claimed = await h.outputs.findOneAndUpdate(
    { _id: outputId, feedback: { $exists: false } },
    { $set: { feedback: { verdict, by, at: new Date(), caseIndex: -1 } } },
    { returnDocument: "after" },
  );
  if (!claimed) {
    const cap = await h.capabilities.findOne({ _id: out.capId });
    const head = cap?.versions.find((x) => x.v === cap.activeVersion);
    return {
      ok: true, outputId, capId: out.capId, v: out.v, verdict: out.feedback!.verdict, repeat: true,
      evals: (await h.answerKeys.findOne({ _id: out.capId }))?.cases.length ?? 0,
      head: head?.score ? { v: head.v, passed: head.score.passed, total: head.score.total } : null, previousHead: head?.v ?? null,
      queuedImprove: false, summary: `already judged ${out.feedback!.verdict} by ${out.feedback!.by}`,
    };
  }

  const c: EvalCase = {
    args: out.args, expect, category: "feedback",
    source: verdict === "correct" ? "accepted_run" : "corrected_run", addedBy: by, addedAt: new Date(), outputId,
  };
  const key = await h.answerKeys.findOneAndUpdate({ _id: out.capId }, { $push: { cases: c } }, { upsert: true, returnDocument: "after" });
  const caseIndex = (key?.cases.length ?? 1) - 1;
  await h.outputs.updateOne({ _id: outputId }, { $set: { "feedback.caseIndex": caseIndex } });

  const { previousHead, head, queuedImprove } = await rescore(h, out.capId);
  const evals = key?.cases.length ?? 1;
  const summary =
    `${by} marked ${out.capId} v${out.v} ${verdict}: ${evals} eval${evals === 1 ? "" : "s"}; ` +
    (head ? `promoted v${head.v} ${head.passed}/${head.total}${previousHead !== head.v ? ` (was ${previousHead == null ? "none" : `v${previousHead}`})` : ""}` : "no version can be promoted yet") +
    (queuedImprove ? "; worker queued to improve it" : "");

  await h.events.insertOne({
    runId: "feedback", user: by, harness: opts.harness ?? "cli", hive: h.name, kind: "feedback", tool: "feedback",
    actor: by, verb: "gave feedback", args: { id: out.capId, v: out.v, outputId, verdict },
    result: { verdict, evals, head: head?.v ?? null, score: head ? { passed: head.passed, total: head.total } : null }, ms: 0, at: new Date(),
  });
  return { ok: true, outputId, capId: out.capId, v: out.v, verdict, repeat: false, evals, head, previousHead, queuedImprove, summary };
}

// re-score every version a new eval can change, let the leaderboard pick the head, and queue the worker if
// the head now misses anything. exported for scripts that change evals in bulk.
export async function rescore(h: Hive, capId: string) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const cap = await h.capabilities.findOne({ _id: capId });
    if (!cap) return { previousHead: null, head: null, queuedImprove: false };
    const versions: CapabilityVersion[] = [];
    for (const v of cap.versions) {
      if (!RESCORABLE.has(v.status)) { versions.push(v); continue; }
      const verdict = await validate(h, capId, v);
      if (verdict.total === 0) { versions.push(v); continue; } // every eval so far came from this version's author
      const score = { passed: verdict.passed, total: verdict.total, ms: verdict.ms };
      const pass = verdict.passed / verdict.total >= MIN_PASS_RATE;
      versions.push({
        ...v, score,
        // syncHead promotes rank 1 among candidates; below the floor a version can't lead at all
        status: pass ? (v.status === "active" ? "active" : "superseded") : "rejected",
        reason: `re-scored on feedback evals: ${verdict.passed}/${verdict.total}${pass ? "" : `; below the ${MIN_PASS_RATE * 100}% floor to be promoted`}`,
      });
    }
    const res = await h.capabilities.updateOne({ _id: capId, updatedAt: cap.updatedAt }, { $set: { versions, updatedAt: new Date() } });
    if (res.modifiedCount === 0) continue; // someone else wrote first; re-read and re-score
    const headV = await syncHead(h, capId);
    const after = await h.capabilities.findOne({ _id: capId });
    const hv = after?.versions.find((x) => x.v === headV);
    const head = hv?.score ? { v: hv.v, passed: hv.score.passed, total: hv.score.total } : null;
    let queuedImprove = false;
    if (head && head.passed < head.total) {
      queuedImprove = await queueImprove(h, capId, "promoted version misses feedback evals");
    }
    return { previousHead: cap.activeVersion, head, queuedImprove };
  }
  throw new Error(`could not re-score ${capId}: concurrent writes kept winning`);
}
