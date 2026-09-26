// the worker: drafts new tools and improves weak ones. every step is a worker_jobs doc the console can narrate;
// every candidate goes through the same commitVersion/decide path as any teammate, so the hidden cases stay the judge.
import { randomUUID } from "node:crypto";
import { HIVE_USER, db, type Hive } from "../registry/db.js";
import type { Capability, CapabilityVersion, WorkerJob } from "../registry/types.js";
import { assertAllowedCollection, assertReadOnly, findDataLiterals, hashRecipe } from "../learner/index.js";
import { commitVersion, decide, validate } from "../validator/index.js";
import { workerLlm, parseJson, type Llm } from "./llm.js";

const WORKER = `worker:${HIVE_USER}:${process.pid}`;

export async function enqueue(h: Hive, job: Pick<WorkerJob, "trigger" | "capId" | "note" | "sessionId">) {
  const now = new Date();
  const doc: WorkerJob = { _id: `job_${randomUUID().slice(0, 8)}`, hive: h.name, step: "queued", createdAt: now, updatedAt: now, ...job };
  await h.workerJobs.insertOne(doc);
  return doc;
}

// claim the oldest queued job; atomic, so two workers never work the same job
export async function claim(h: Hive, id?: string) {
  return h.workerJobs.findOneAndUpdate(
    { step: "queued", ...(id ? { _id: id } : {}) },
    { $set: { step: "drafting", claimedBy: WORKER, updatedAt: new Date() } },
    { sort: { createdAt: 1 }, returnDocument: "after" },
  );
}

const step = (h: Hive, id: string, set: Partial<WorkerJob>) => h.workerJobs.updateOne({ _id: id }, { $set: { ...set, updatedAt: new Date() } });

// a small, real look at the work data: two docs per collection in the tool's domain (same prefix)
export async function schemaSample(collection: string) {
  const prefix = collection.split("_")[0] + "_";
  const names = (await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name).filter((n) => n.startsWith(prefix));
  const out: Record<string, unknown[]> = {};
  for (const n of names) {
    assertAllowedCollection(n);
    out[n] = await db.collection(n).find({}, { projection: { _id: 0 } }).limit(2).toArray();
  }
  return out;
}

const SYSTEM = `You are the MongoHive worker. You write one read-only MongoDB aggregation pipeline that implements a team tool.
Rules: output ONLY a JSON object {"collection": string, "pipeline": [...], "whenToUse": string, "notes": string}.
Use "{{param}}" string placeholders for parameters (a whole-string placeholder is replaced by the raw value).
Allowed: $match, $lookup (with pipeline), $unwind, $group, $project, $addFields, $set, $sort, $facet, $limit, $unionWith on work-data collections.
Never use $out, $merge, $function, $accumulator, $where. The pipeline must return exactly ONE document with exactly the output fields asked for, arrays sorted ascending.`;

interface Draft { collection: string; pipeline: object[]; whenToUse: string; notes?: string }

export interface Attempt { v: number; summary: string; passed: number; total: number; failing: string[] }

// ask the model for a recipe and commit it through the shared accept logic
export async function draftAndCommit(opts: {
  h: Hive; cap: Pick<Capability, "_id" | "directive" | "scope">; params: CapabilityVersion["params"]; collection: string;
  output: string; base?: CapabilityVersion; failing?: string[]; history?: Attempt[]; job: WorkerJob; llm?: Llm;
}) {
  const { h, cap, params, collection, job } = opts;
  const llm = opts.llm ?? (await workerLlm());
  await step(h, job._id, { model: llm.model });
  const user = [
    `tool id: ${cap._id}`,
    `directive: ${cap.directive}`,
    `params: ${JSON.stringify(params)}`,
    `output document fields: ${opts.output}`,
    `start collection (suggested): ${collection}`,
    `work-data sample (2 docs per collection): ${JSON.stringify(await schemaSample(collection))}`,
    opts.base ? `current head recipe (v${opts.base.v}, ${opts.base.score?.passed}/${opts.base.score?.total}): ${JSON.stringify({ collection: opts.base.collection, pipeline: opts.base.pipeline })}` : "",
    opts.failing?.length ? `hidden test categories the head still fails: ${opts.failing.join(", ")}. You will not see the test inputs; reason about what rule each category names and fix it without breaking passing cases.` : "",
    opts.history?.length ? `previous worker attempts this run: ${opts.history.map((a) => `${a.summary} (failing: ${a.failing.join(", ") || "none"})`).join(" | ")}` : "",
  ].filter(Boolean).join("\n");
  let draft: Draft;
  try {
    draft = parseJson<Draft>(await llm.complete(SYSTEM, user));
    assertAllowedCollection(draft.collection);
    assertReadOnly(draft.pipeline);
    // the model saw real work-data samples, so hold drafts to the same no-hard-coded-values rule as publish
    const leaked = findDataLiterals(draft.pipeline);
    if (leaked.length) throw new Error(`pipeline hard-codes data values (${[...new Set(leaked)].slice(0, 3).join(", ")})`);
  } catch (e) {
    // first line only: a failed cli call's message embeds the whole prompt
    await step(h, job._id, { step: "skipped", note: `draft unusable: ${(e as Error).message.split("\n")[0].slice(0, 200)}` });
    return null;
  }
  await step(h, job._id, { step: "validating" });
  let failing: string[] = [];
  const { version, decision, summary, previousHead } = await commitVersion(
    h, cap._id, { directive: cap.directive, scope: cap.scope },
    (v) => ({
      v, status: "rejected", collection: draft.collection, params, pipeline: draft.pipeline, whenToUse: draft.whenToUse || cap.directive,
      author: HIVE_USER, harness: "worker", hash: hashRecipe(draft.collection, draft.pipeline), createdAt: new Date(),
    }),
    async (ver, head) => {
      const verdict = await validate(h, cap._id, ver);
      failing = Object.keys(verdict.failedCategories);
      return decide(verdict, head, false);
    },
  );
  const headV = previousHead != null ? (await h.capabilities.findOne({ _id: cap._id }))?.versions.find((x) => x.v === previousHead) : undefined;
  await step(h, job._id, {
    step: decision.activate ? "proposed" : "rejected", capId: cap._id, v: version.v,
    verdict: { passed: decision.score!.passed, total: decision.score!.total, ...(headV?.score ? { headPassed: headV.score.passed } : {}) },
    note: summary,
  });
  return { version, decision, summary, failing, attempt: { v: version.v, summary, passed: decision.score!.passed, total: decision.score!.total, failing } as Attempt };
}

// the output field list, read from the hidden key's shape (field names only, never values)
export async function outputFields(h: Hive, capId: string) {
  const key = await h.answerKeys.findOne({ _id: capId });
  return Object.keys(key?.cases[0]?.expect ?? {}).join(", ");
}

// latest failing categories for a version in this hive
export async function failingFor(h: Hive, capId: string, ver?: CapabilityVersion) {
  if (!ver) return [];
  const ev = await h.evaluations.findOne({ capId, hash: ver.hash }, { sort: { at: -1 } });
  return Object.keys(ev?.failedCategories ?? {});
}
