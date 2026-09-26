// auto-check: a teammate's worker independently re-implements an untested tool from its description alone
// (never the author's implementation, never any stored answer), replays the tool's real runs through that
// reference and compares answers with the same rule validate() uses. agreeing runs become provisional evals
// (source worker_agreement, added by the checker, so they can score the author's version); a disagreement is
// left for a person to judge. in a private hive the owner's worker only records agreement: no evals, no promotion.
import { HIVE_USER, canAccess, db, hives, type Hive } from "../registry/db.js";
import type { EvalCase, HiveOutput, WorkerJob } from "../registry/types.js";
import { assertAllowedCollection, assertReadOnly, execute, findDataLiterals } from "../learner/index.js";
import { sameAnswer, toExpect } from "../validator/index.js";
import { rescore } from "../hive/feedback.js";
import { schemaSample } from "./index.js";
import { parseJson, type Llm } from "./llm.js";

export const MAX_CHECK_RUNS = 12;

const SYSTEM = `You are a MongoHive worker checking a teammate's untested tool. Write your OWN read-only MongoDB aggregation
pipeline that implements the tool from its description alone; you will not see the teammate's implementation or any of its answers.
Output ONLY a JSON object {"collection": string, "pipeline": [...]}.
Use "{{param}}" string placeholders for parameters (a whole-string placeholder is replaced by the raw value); use every param.
Allowed: $match, $lookup (with pipeline), $unwind, $group, $project, $addFields, $set, $sort, $facet, $limit, $unionWith on work-data collections.
Never use $out, $merge, $function, $accumulator, $where, and never hard-code ids or names from the sample data.
The work-data sample shows how records are keyed (_id). The pipeline must return exactly ONE document with exactly the output
fields listed, each of the JSON type given (no _id), arrays sorted ascending.`;

interface Reference { collection: string; pipeline: object[] }

export type CheckResult =
  | { ok: false; handBack: true; reason: string } // not this worker's job: leave it queued for a teammate's worker
  | { ok: false; handBack: false; reason: string } // job closed as skipped, note says why
  | {
      ok: true; capId: string; v: number; runs: number; agree: number; disagree: number; evalsAdded: number;
      promoted: boolean; recordOnly: boolean; note: string;
    };

export interface CheckStart { capId: string; v: number; author: string; runs: number }

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const step = (h: Hive, id: string, set: Partial<WorkerJob>) => h.workerJobs.updateOne({ _id: id }, { $set: { ...set, updatedAt: new Date() } });

// the prompt holds only what anyone could know about the tool: its id, directive, when-to-use, params, the names
// of its output fields with their json types (never values) and a sample of the work data. exported so the verify script can assert that on real inputs.
export async function referencePrompt(opts: { capId: string; directive: string; whenToUse: string; params: Record<string, string>; fields: string[]; collection: string }) {
  return [
    `tool id: ${opts.capId}`,
    `directive: ${opts.directive}`,
    `when to use: ${opts.whenToUse}`,
    `params: ${JSON.stringify(opts.params)}`,
    `output document fields: ${opts.fields.join(", ")}`,
    `work-data sample (2 docs per collection): ${JSON.stringify(await schemaSample(opts.collection, true))}`,
  ].join("\n");
}

export async function checkTool(h: Hive, job: WorkerJob, llm: Llm, checker = HIVE_USER, on?: (e: CheckStart) => void): Promise<CheckResult> {
  const t0 = Date.now();
  const skip = async (reason: string): Promise<CheckResult> => {
    await step(h, job._id, { step: "skipped", note: reason });
    return { ok: false, handBack: false, reason };
  };
  const cap = job.capId ? await h.capabilities.findOne({ _id: job.capId }) : null;
  if (!cap) return skip(`no tool ${job.capId ?? "(none)"} in hive ${h.name}`);
  const ver = job.v != null ? cap.versions.find((x) => x.v === job.v) : [...cap.versions].reverse().find((x) => x.status === "unverified");
  if (!ver) return skip(job.v != null ? `${cap._id} has no v${job.v}` : `${cap._id} has no untested version to check`);
  if (ver.status === "rejected" || ver.status === "archived") return skip(`v${ver.v} is ${ver.status}; nothing to check`);

  // eligibility, before the job is touched: a hand-back leaves it exactly as another worker would find it
  const info = await hives.findOne({ _id: h.name });
  const shared = info?.visibility === "shared";
  if (shared) {
    if (!canAccess(info, checker)) return { ok: false, handBack: true, reason: `${checker} is not a member of hive ${h.name}` };
    if (ver.author === checker) return { ok: false, handBack: true, reason: "can't check your own tool: left for a teammate's worker" };
  } else if (info?.owner !== checker) {
    return { ok: false, handBack: true, reason: "a private hive's tools are checked only by its owner's worker" };
  }

  // runs nobody has checked or judged yet, newest first, one reference answer per distinct input
  const pending = await h.outputs
    .find({ capId: cap._id, v: ver.v, check: { $exists: false }, feedback: { $exists: false } })
    .sort({ at: -1 }).limit(500).toArray();
  const byArgs = new Map<string, HiveOutput[]>();
  for (const o of pending) {
    const k = JSON.stringify(o.args);
    if (!byArgs.has(k)) { if (byArgs.size >= MAX_CHECK_RUNS) continue; byArgs.set(k, []); }
    byArgs.get(k)!.push(o);
  }
  const runs = [...byArgs.values()].flat();
  if (!runs.length) return skip("no runs to check yet");

  await step(h, job._id, { step: "drafting", capId: cap._id, v: ver.v, model: llm.model });
  on?.({ capId: cap._id, v: ver.v, author: ver.author, runs: runs.length });

  // output field names and json types only, never values
  const kind = (x: unknown) => (x === null ? "null" : Array.isArray(x) ? "array" : x instanceof Date ? "date" : typeof x);
  const fields = Object.entries(runs.find((o) => o.result.length)?.result[0] ?? {}).map(([k, x]) => `${k} (${kind(x)})`);
  let ref: Reference | null = null;
  if (fields.length) {
    try {
      const prompt = await referencePrompt({ capId: cap._id, directive: cap.directive, whenToUse: ver.whenToUse, params: ver.params, fields, collection: ver.collection });
      ref = parseJson<Reference>(await llm.complete(SYSTEM, prompt));
      if (typeof ref.collection !== "string" || !Array.isArray(ref.pipeline)) throw new Error("reply needs a collection and a pipeline");
      assertAllowedCollection(ref.collection);
      assertReadOnly(ref.pipeline);
      const leaked = findDataLiterals(ref.pipeline);
      if (leaked.length) throw new Error(`pipeline hard-codes data values (${[...new Set(leaked)].slice(0, 3).join(", ")})`);
      const text = JSON.stringify(ref.pipeline);
      for (const p of Object.keys(ver.params)) if (!text.includes(`{{${p}}}`)) throw new Error(`param ${p} is never used`);
    } catch (e) {
      // first line only: a failed cli call's message embeds the whole prompt
      return skip(`reference unusable: ${(e as Error).message.split("\n")[0].slice(0, 200)}`);
    }
  }

  await step(h, job._id, { step: "validating" });
  const marks: { o: HiveOutput; agree: boolean }[] = [];
  let refAnswered = 0;
  for (const outs of byArgs.values()) {
    let refOut: Record<string, unknown>[] | null = null;
    if (ref) try { refOut = await execute(db, ref, outs[0].args); } catch { refOut = null; }
    if (refOut?.length) refAnswered++;
    for (const o of outs) marks.push({ o, agree: !!refOut?.length && sameAnswer(o.result, toExpect(refOut)) });
  }
  // a reference that answers nothing tells us nothing about the tool: don't send its runs to a person on that basis
  if (ref && refAnswered === 0) return skip(`reference unusable: it gave no answer for any of the ${plural(byArgs.size, "input")}`);

  const at = new Date();
  await h.outputs.bulkWrite(marks.map(({ o, agree }) => ({
    updateOne: { filter: { _id: o._id, check: { $exists: false } }, update: { $set: { check: { agree, by: checker, at, jobId: job._id } } } },
  })));
  const agree = marks.filter((m) => m.agree).length;
  const disagree = marks.length - agree;

  let evalsAdded = 0;
  let promoted = false;
  let notPromoted = "";
  if (shared) {
    // one provisional eval per agreeing input the tool has no eval for yet
    const key = await h.answerKeys.findOne({ _id: cap._id });
    const have = new Set((key?.cases ?? []).map((c) => JSON.stringify(c.args)));
    const cases: EvalCase[] = [];
    for (const { o, agree: ok } of marks) {
      const k = JSON.stringify(o.args);
      if (!ok || have.has(k)) continue;
      have.add(k);
      cases.push({ args: o.args, expect: toExpect(o.result), category: "auto-check", source: "worker_agreement", addedBy: checker, addedAt: at, outputId: o._id, provisional: true });
    }
    if (cases.length) await h.answerKeys.updateOne({ _id: cap._id }, { $push: { cases: { $each: cases } } }, { upsert: true });
    evalsAdded = cases.length;
    // any disagreement waits for a person: their feedback re-scores the tool. full agreement re-scores now.
    if (disagree === 0 && agree >= 1) {
      const r = await rescore(h, cap._id);
      promoted = r.head?.v === ver.v;
      if (!promoted) notPromoted = (await h.capabilities.findOne({ _id: cap._id }))?.versions.find((x) => x.v === ver.v)?.reason ?? "";
    }
  }

  const note = !shared
    ? `agrees on ${agree} of ${plural(marks.length, "run")} (your private hive: record only)`
    : disagree
      ? `agrees on ${plural(agree, "run")}, ${disagree} ${disagree === 1 ? "needs" : "need"} a person to judge`
      : promoted
        ? `agrees on ${plural(agree, "run")}, promoted v${ver.v}`
        : `agrees on ${plural(agree, "run")}; v${ver.v} not promoted${notPromoted ? `: ${notPromoted}` : ""}`;

  await step(h, job._id, { step: "proposed", capId: cap._id, v: ver.v, verdict: { passed: agree, total: marks.length }, model: llm.model, note });
  await h.events.insertOne({
    runId: "worker", user: checker, harness: "worker", hive: h.name, kind: "worker", tool: "check", actor: checker, verb: "checked",
    args: { id: cap._id, v: ver.v }, result: { agree, disagree, promoted }, ms: Date.now() - t0, at: new Date(),
  });
  return { ok: true, capId: cap._id, v: ver.v, runs: marks.length, agree, disagree, evalsAdded, promoted, recordOnly: !shared, note };
}
