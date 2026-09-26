// the worker drafts a brand-new tool from a session's investigation: the agent's explore calls in one run become
// one parameterized, read-only tool in that person's private hive. it lands unverified (no evals exist yet), so it
// is usable by its owner at once and trusted by nobody else until a shared hive's evals or feedback judge it.
import { db, type Hive } from "../registry/db.js";
import type { CapabilityVersion, WorkerJob } from "../registry/types.js";
import { assertAllowedCollection, assertReadOnly, execute, findDataLiterals, hashRecipe } from "../learner/index.js";
import { commitVersion, decide, validate } from "../validator/index.js";
import { HIVE_USER } from "../registry/db.js";
import { parseJson, type Llm } from "./llm.js";
import { schemaSample } from "./index.js";

const SYSTEM = `You are the MongoHive worker. A coding agent just investigated work data with read-only MongoDB aggregations.
Turn that investigation into ONE reusable tool the agent can call next time instead of repeating it.
Output ONLY a JSON object:
{"id": short snake_case string (at most 32 chars), "directive": one sentence saying what the tool answers, "scope": short domain word,
 "whenToUse": one sentence, "collection": string, "params": {"name": "string"|"number"}, "pipeline": [...],
 "example": {param values taken from the investigation}}
Rules: every value that came from the data (ids, names, services, dates) must be a "{{param}}" placeholder (a whole-string
placeholder is replaced by the raw value); keep params minimal (1-2). Allowed stages: $match, $lookup (with pipeline), $unwind,
$group, $project, $addFields, $set, $sort, $facet, $limit, $unionWith on work-data collections. Never $out, $merge, $function,
$accumulator, $where. The pipeline must return exactly ONE document answering the question, arrays sorted ascending.`;

interface Draft { id: string; directive: string; scope: string; whenToUse: string; collection: string; params: CapabilityVersion["params"]; pipeline: object[]; example: Record<string, unknown> }

export type NewToolResult = { ok: true; id: string; v: number; summary: string; example: Record<string, unknown>; rows: number } | { ok: false; reason: string };

export async function draftNewTool(h: Hive, job: WorkerJob, llm: Llm): Promise<NewToolResult> {
  const runId = job.sessionId;
  const trace = await h.events.find({ runId, tool: "explore" } as any).sort({ at: 1 }).limit(12).toArray();
  if (trace.length < 2) return { ok: false, reason: `only ${trace.length} explore call(s) in run ${runId}; nothing to generalize` };
  const calls = trace.map((e: any, i) => `#${i + 1} ${e.args?.collection}: ${JSON.stringify(e.args?.pipeline)} -> ${e.result?.count ?? "?"} docs`);
  const start = (trace.at(-1) as any).args?.collection as string;
  const existing = (await h.capabilities.find({}, { projection: { _id: 1 } }).toArray()).map((c) => c._id);
  const user = [
    job.note ? `what the agent was answering (its own words): ${job.note}` : "",
    `the agent's explore calls, in order:\n${calls.join("\n")}`,
    `work-data sample (2 docs per collection): ${JSON.stringify(await schemaSample(start))}`,
    existing.length ? `tool ids already taken in this hive (pick a new one): ${existing.join(", ")}` : "",
  ].filter(Boolean).join("\n");

  let d: Draft;
  try {
    d = parseJson<Draft>(await llm.complete(SYSTEM, user));
    if (!/^[a-z][a-z0-9_]{2,47}$/.test(d.id ?? "")) throw new Error(`bad tool id ${d.id}`);
    if (existing.includes(d.id)) throw new Error(`tool id ${d.id} already exists`);
    if (!d.params || !Object.keys(d.params).length) throw new Error("no params: the tool would answer one fixed question");
    assertAllowedCollection(d.collection);
    assertReadOnly(d.pipeline);
    const leaked = findDataLiterals(d.pipeline);
    if (leaked.length) throw new Error(`pipeline hard-codes data values (${[...new Set(leaked)].slice(0, 3).join(", ")})`);
    const text = JSON.stringify(d.pipeline);
    for (const p of Object.keys(d.params)) if (!text.includes(`{{${p}}}`)) throw new Error(`param ${p} is never used`);
  } catch (e) {
    // no usable draft means no tool: the job stays nameless and closes as skipped (the console hides these)
    return { ok: false, reason: `draft unusable: ${(e as Error).message.split("\n")[0].slice(0, 200)}` };
  }
  // from here the job has a name: the console shows "new tool <id> · ∅ → v<next>" through testing
  await h.workerJobs.updateOne({ _id: job._id }, { $set: { capId: d.id, step: "validating", model: llm.model, updatedAt: new Date() } });
  // smoke test on the investigation's own values (the agent's data, not evals): a tool that finds nothing is no help
  let rows = 0;
  try { rows = (await execute(db, d, d.example ?? {})).length; } catch (e) {
    return { ok: false, reason: `draft errors on the investigated example: ${(e as Error).message.split("\n")[0].slice(0, 160)}` };
  }
  // one answer document, the same shape feedback needs to turn a run into an eval
  if (rows !== 1) return { ok: false, reason: `draft returns ${rows} documents for the investigated example ${JSON.stringify(d.example)}; a tool answers with exactly one` };

  const { version, summary } = await commitVersion(
    h, d.id, { directive: d.directive, scope: d.scope || "general" },
    (v) => ({
      v, status: "rejected", collection: d.collection, params: d.params, pipeline: d.pipeline, whenToUse: d.whenToUse || d.directive,
      author: HIVE_USER, harness: "worker", sourceRunId: runId, hash: hashRecipe(d.collection, d.pipeline), createdAt: new Date(),
    }),
    async (ver, head) => decide(await validate(h, d.id, ver), head, true),
  );
  return { ok: true, id: d.id, v: version.v, summary, example: d.example, rows };
}
