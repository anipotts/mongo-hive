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
  const beats = !head?.score || better(score, head.score) < 0;
  return beats
    ? { status: "active", activate: true, reason: "passed all hidden cases", score }
    : { status: "rejected", activate: false, reason: "passed, but does not beat the current head", score };
}

// the leaderboard: a tool's versions compete on the hive's hidden cases. no merging; the score decides.
type Score = NonNullable<CapabilityVersion["score"]>;
const ratio = (s?: Score) => (s && s.total ? s.passed / s.total : -1);
// < 0 means a is better than b: pass rate first, then speed
export const better = (a?: Score, b?: Score) => ratio(b) - ratio(a) || (a?.ms ?? Infinity) - (b?.ms ?? Infinity);

export function rank(cap: Capability): CapabilityVersion[] {
  return cap.versions
    .filter((v) => v.status !== "rejected" && v.status !== "unverified" && v.score && v.score.total > 0)
    .sort((a, b) => better(a.score, b.score) || +new Date(a.createdAt) - +new Date(b.createdAt));
}

export const board = (cap: Capability, n = 3) =>
  rank(cap).slice(0, n).map((v, i) => ({ rank: i + 1, v: v.v, author: v.author, harness: v.harness, score: v.score }));

export type Standing =
  | { state: "on_best"; v: number }
  | { state: "better_available"; v: number | null; best: number; author: string; delta: string }
  | { state: "yours_beats_team"; v: number | null; privateV: number; score: Score; head: number }
  | { state: "pinned"; v: number };

const fmt = (s?: Score) => (s ? `${s.passed}/${s.total} in ${s.ms}ms` : "unscored");

// one question per agent per tool: is there a version that beats mine?
export function standing(cap: Capability, current: number | null, pinned: number | null, privateBest?: { v: number; score: Score }): Standing | null {
  if (pinned != null) return { state: "pinned", v: pinned };
  const top = rank(cap)[0];
  if (!top) return null;
  if (privateBest && better(privateBest.score, top.score) < 0)
    return { state: "yours_beats_team", v: current, privateV: privateBest.v, score: privateBest.score, head: top.v };
  const mine = cap.versions.find((v) => v.v === current);
  if (mine && better(mine.score, top.score) <= 0) return { state: "on_best", v: mine.v };
  return { state: "better_available", v: current, best: top.v, author: top.author, delta: `${fmt(mine?.score)} -> ${fmt(top.score)}` };
}

// score a private version on a shared hive's hidden cases, cached by recipe hash in that hive's evaluations
export async function scoreOn(target: Hive, capId: string, ver: CapabilityVersion, cachedOnly = false): Promise<Score | null> {
  const cached = await target.evaluations.findOne({ capId, hash: ver.hash }, { sort: { at: -1 } });
  if (cached) return cached.total ? { passed: cached.passed, total: cached.total, ms: cached.ms } : null;
  if (cachedOnly) return null;
  const v = await validate(target, capId, ver);
  return v.total ? { passed: v.passed, total: v.total, ms: v.ms } : null;
}

// keep the head equal to rank 1 and label the rest, so every writer agrees on who leads
export async function syncHead(h: Hive, id: string) {
  const cap = await h.capabilities.findOne({ _id: id });
  if (!cap) return null;
  const top = rank(cap)[0];
  const versions = cap.versions.map((v) =>
    v.status === "active" || v.status === "superseded" ? { ...v, status: (v.v === top?.v ? "active" : "superseded") as CapabilityVersion["status"] } : v,
  );
  const next = top?.v ?? null;
  if (next !== cap.activeVersion || versions.some((v, i) => v.status !== cap.versions[i].status))
    await h.capabilities.updateOne({ _id: id, updatedAt: cap.updatedAt }, { $set: { versions, activeVersion: next, updatedAt: new Date() } });
  return next;
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
  if (d.activate) await syncHead(h, id);
  return { version, decision: d, previousHead: head?.v ?? null };
}
