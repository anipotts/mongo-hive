// runs a candidate recipe against a hive's hidden answer key. nothing here is exposed to agents.
import { db, type Hive } from "../registry/db.js";
import type { Capability, CapabilityVersion } from "../registry/types.js";
import { execute } from "../learner/index.js";

export interface Verdict { passed: number; total: number; ms: number; failures: string[] }

const matches = (got: any, expect: Record<string, unknown>) =>
  Object.entries(expect).every(([k, v]) => JSON.stringify(got?.[k]) === JSON.stringify(v));

export async function validate(h: Hive, capId: string, version: CapabilityVersion): Promise<Verdict> {
  const key = await h.answerKeys.findOne({ _id: capId });
  const t0 = Date.now();
  if (!key || key.cases.length === 0) return { passed: 0, total: 0, ms: 0, failures: [] };
  const failures: string[] = [];
  let passed = 0;
  for (const c of key.cases) {
    try {
      const out = await execute(db, version, c.args);
      if (out.length === 1 && matches(out[0], c.expect)) passed++;
      else failures.push(out.length === 1 ? "wrong result" : `expected 1 result doc, got ${out.length}`);
    } catch (e) {
      failures.push(`error: ${(e as Error).message}`);
    }
  }
  const verdict = { passed, total: key.cases.length, ms: Date.now() - t0, failures };
  await h.evaluations.insertOne({ capId, v: version.v, hash: version.hash, ...verdict, at: new Date() });
  return verdict;
}

export interface Decision { status: CapabilityVersion["status"]; activate: boolean; reason: string; score: CapabilityVersion["score"] }

// one accept rule for proposals and publishes. private hives without tests keep tools as "unverified".
export function decide(verdict: Verdict, head: CapabilityVersion | undefined, allowUnverified: boolean): Decision {
  const score = { passed: verdict.passed, total: verdict.total, ms: verdict.ms };
  if (verdict.total === 0)
    return allowUnverified
      ? { status: "unverified", activate: false, reason: "no hidden cases in this hive yet: usable by you, not trusted by others", score }
      : { status: "rejected", activate: false, reason: "this hive has no hidden cases for this capability id", score };
  if (verdict.passed < verdict.total) {
    const err = verdict.failures.find((f) => f.startsWith("error") || f.startsWith("expected"));
    return { status: "rejected", activate: false, reason: `failed ${verdict.total - verdict.passed} of ${verdict.total} hidden cases${err ? ` (${err})` : ""}`, score };
  }
  const beats = !head?.score || verdict.passed > head.score.passed || (verdict.passed === head.score.passed && verdict.ms < head.score.ms);
  return beats
    ? { status: "active", activate: true, reason: "passed all hidden cases", score }
    : { status: "rejected", activate: false, reason: "passed, but does not beat the current head", score };
}

// atomic: reserve a version number, then push it and (if accepted) move the head in one write
export async function commitVersion(
  h: Hive,
  id: string,
  meta: Pick<Capability, "directive" | "scope">,
  build: (v: number) => CapabilityVersion,
  judge: (version: CapabilityVersion, head: CapabilityVersion | undefined) => Promise<Decision>,
) {
  const cap = (await h.capabilities.findOneAndUpdate(
    { _id: id },
    { $inc: { nextVersion: 1 }, $setOnInsert: { ...meta, activeVersion: null, versions: [] } } as any,
    { upsert: true, returnDocument: "after" },
  ))!;
  const v = cap.nextVersion!;
  const head = cap.versions.find((x) => x.v === cap.activeVersion);
  const version = build(v);
  const d = await judge(version, head);
  Object.assign(version, { status: d.status, score: d.score, reason: d.reason });
  await h.capabilities.updateOne(
    { _id: id },
    { $push: { versions: version }, $set: { updatedAt: new Date(), ...(d.activate ? { activeVersion: v } : {}) } },
  );
  if (d.activate && head) await h.capabilities.updateOne({ _id: id, "versions.v": head.v }, { $set: { "versions.$.status": "superseded" } });
  return { version, decision: d, previousHead: head?.v ?? null };
}
