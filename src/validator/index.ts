// runs a candidate recipe against a hive's hidden answer key. nothing here is exposed to agents.
import { db, type Hive } from "../registry/db.js";
import type { Capability, CapabilityVersion } from "../registry/types.js";
import { execute } from "../learner/index.js";

// failedCategories names the rules a version gets wrong (from the case's `category`), never the case inputs
export interface Verdict { passed: number; total: number; ms: number; failures: string[]; failedCategories: Record<string, number> }

const matches = (got: any, expect: Record<string, unknown>) =>
  Object.entries(expect).every(([k, v]) => JSON.stringify(got?.[k]) === JSON.stringify(v));

export async function validate(h: Hive, capId: string, version: CapabilityVersion): Promise<Verdict> {
  const key = await h.answerKeys.findOne({ _id: capId });
  const t0 = Date.now();
  if (!key || key.cases.length === 0) return { passed: 0, total: 0, ms: 0, failures: [], failedCategories: {} };
  const failures: string[] = [];
  const failedCategories: Record<string, number> = {};
  let passed = 0;
  for (const c of key.cases) {
    let ok = false;
    try {
      const out = await execute(db, version, c.args);
      ok = out.length === 1 && matches(out[0], c.expect);
      if (!ok) failures.push(out.length === 1 ? "wrong result" : `expected 1 result doc, got ${out.length}`);
    } catch (e) {
      failures.push(`error: ${(e as Error).message}`);
    }
    if (ok) passed++;
    else failedCategories[c.category ?? "uncategorized"] = (failedCategories[c.category ?? "uncategorized"] ?? 0) + 1;
  }
  const verdict = { passed, total: key.cases.length, ms: Date.now() - t0, failures, failedCategories };
  await h.evaluations.insertOne({ capId, v: version.v, hash: version.hash, ...verdict, at: new Date() });
  return verdict;
}

export interface Decision { status: CapabilityVersion["status"]; activate: boolean; reason: string; score: CapabilityVersion["score"] }

// a version needs at least this pass rate to lead a hive at all; above it, the leaderboard decides
export const MIN_PASS_RATE = 0.5;

// one accept rule for proposals and publishes. private hives without tests keep tools as "unverified".
// a partial version can lead (and advertise what it still gets wrong) until something beats it.
export function decide(verdict: Verdict, head: CapabilityVersion | undefined, allowUnverified: boolean): Decision {
  const score = { passed: verdict.passed, total: verdict.total, ms: verdict.ms };
  if (verdict.total === 0)
    return allowUnverified
      ? { status: "unverified", activate: false, reason: "no hidden cases in this hive yet: usable by you, not trusted by others", score }
      : { status: "rejected", activate: false, reason: "this hive has no hidden cases for this capability id", score };
  const err = verdict.failures.find((f) => f.startsWith("error") || f.startsWith("expected"));
  const missed = verdict.passed < verdict.total ? `failed ${verdict.total - verdict.passed} of ${verdict.total} hidden cases${err ? ` (${err})` : ""}` : "passed all hidden cases";
  if (verdict.passed / verdict.total < MIN_PASS_RATE)
    return { status: "rejected", activate: false, reason: `${missed}; below the ${MIN_PASS_RATE * 100}% floor to lead`, score };
  const beats = !head?.score || better(score, head.score) < 0;
  return beats
    ? { status: "active", activate: true, reason: head ? `${missed}; beats the head` : `${missed}; first tested version leads`, score }
    : { status: "rejected", activate: false, reason: `${missed}; does not beat the current head`, score };
}

const frac = (s?: CapabilityVersion["score"]) => (s ? `${s.passed}/${s.total}` : "unscored");

// "v3 9/10 vs head v2 7/10: published" — the one line every surface shows for a proposal or publish
export function summarize(version: CapabilityVersion, head: CapabilityVersion | undefined, d: Decision): string {
  const vs = head ? ` vs head v${head.v} ${frac(head.score)}` : " (no head yet)";
  const outcome = d.activate ? "published, took the lead" : d.status === "unverified" ? "saved unverified" : "rejected";
  return `v${version.v} ${frac(d.score)}${vs}: ${outcome}`;
}

// what the head still gets wrong, from its latest evaluation in this hive. categories only, never inputs.
export async function improveHint(h: Hive, cap: Capability): Promise<string | undefined> {
  const head = cap.versions.find((v) => v.v === cap.activeVersion);
  if (!head?.score || head.score.total === 0 || head.score.passed >= head.score.total) return undefined;
  const ev = await h.evaluations.findOne({ capId: cap._id, hash: head.hash }, { sort: { at: -1 } });
  const cats = Object.keys(ev?.failedCategories ?? {});
  return `head v${head.v} passes ${head.score.passed}/${head.score.total}${cats.length ? `; failing: ${cats.join(", ")}` : ""}; propose a better version`;
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
  return { version, decision: d, previousHead: head?.v ?? null, summary: summarize(version, head, d) };
}
