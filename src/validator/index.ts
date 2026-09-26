// runs a candidate recipe against a hive's hidden answer key. nothing here is exposed to agents.
import { db, type Hive } from "../registry/db.js";
import type { Capability, CapabilityVersion } from "../registry/types.js";
import { execute } from "../learner/index.js";

// failedCategories names the rules a version gets wrong (from the case's `category`), never the case inputs
export interface Verdict { passed: number; total: number; ms: number; failures: string[]; failedCategories: Record<string, number> }

// the one comparison rule: every expected field equal as json. exported so the auto-check compares runs the same way
export const matches = (got: any, expect: Record<string, unknown>) =>
  Object.entries(expect).every(([k, v]) => JSON.stringify(got?.[k]) === JSON.stringify(v));

// a list answer (one doc per team, say) is judged whole: its eval expects { __rows: [...] }, same rows in the same order
export const ROWS = "__rows";
export const toExpect = (result: Record<string, unknown>[]): Record<string, unknown> =>
  result.length === 1 ? result[0] : { [ROWS]: result };
export function sameAnswer(got: Record<string, unknown>[], expect: Record<string, unknown>) {
  const rows = expect[ROWS];
  if (!Array.isArray(rows) || Object.keys(expect).length !== 1) return got.length === 1 && matches(got[0], expect);
  return got.length === rows.length && rows.every((r, i) => matches(got[i], r));
}

export async function validate(h: Hive, capId: string, version: CapabilityVersion): Promise<Verdict> {
  const key = await h.answerKeys.findOne({ _id: capId });
  const t0 = Date.now();
  // no self-certifying: cases a person added through feedback never score that same person's versions
  const cases = (key?.cases ?? []).filter((c) => !c.addedBy || c.addedBy !== version.author);
  if (cases.length === 0) return { passed: 0, total: 0, ms: 0, failures: [], failedCategories: {} };
  const failures: string[] = [];
  const failedCategories: Record<string, number> = {};
  let passed = 0;
  for (const c of cases) {
    let ok = false;
    try {
      const out = await execute(db, version, c.args);
      ok = sameAnswer(out, c.expect);
      if (!ok) failures.push(out.length === 1 || Array.isArray(c.expect[ROWS]) ? "wrong result" : `expected 1 result doc, got ${out.length}`);
    } catch (e) {
      failures.push(`error: ${(e as Error).message}`);
    }
    if (ok) passed++;
    else failedCategories[c.category ?? "uncategorized"] = (failedCategories[c.category ?? "uncategorized"] ?? 0) + 1;
  }
  const verdict = { passed, total: cases.length, ms: Date.now() - t0, failures, failedCategories };
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
  // raw errors can echo bound hidden-case args (e.g. conversion failures), so agents only see a count
  const errored = verdict.failures.filter((f) => f.startsWith("error") || f.startsWith("expected")).length;
  const missed = verdict.passed < verdict.total ? `failed ${verdict.total - verdict.passed} of ${verdict.total} hidden cases${errored ? ` (${errored} errored)` : ""}` : "passed all hidden cases";
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

// keep the head equal to rank 1 and label the rest, so every writer agrees on who leads.
// every head change passes through here, so this is also where versions record what replaced what, and why.
export async function syncHead(h: Hive, id: string) {
  const cap = await h.capabilities.findOne({ _id: id });
  if (!cap) return null;
  const top = rank(cap)[0];
  // displaced heads are still labelled active until this write (commitVersion pushes each newcomer as active,
  // so concurrent promotions can leave several). every loser is stamped; the new head names the best of them.
  const losers = new Set(cap.versions.filter((v) => v.status === "active" && v.v !== top?.v).map((v) => v.v));
  const prev = [...rank(cap), ...cap.versions].find((v) => losers.has(v.v));
  const handover = top && prev ? { from: prev.v, to: top.v, reason: `${fmt(top.score)} beat ${fmt(prev.score)}` } : null;
  const versions = cap.versions.map((v) => {
    const out = v.status === "active" || v.status === "superseded" ? { ...v, status: (v.v === top?.v ? "active" : "superseded") as CapabilityVersion["status"] } : v;
    if (handover && losers.has(v.v)) return { ...out, supersededBy: handover.to };
    if (handover?.to !== v.v) return out;
    const { supersededBy: _, ...back } = out; // a head that wins its place back is no longer superseded
    return { ...back, supersedes: handover.from, replacedReason: handover.reason };
  });
  const next = top?.v ?? null;
  if (handover || next !== cap.activeVersion || versions.some((v, i) => v.status !== cap.versions[i].status))
    await h.capabilities.updateOne({ _id: id, updatedAt: cap.updatedAt }, { $set: { versions, activeVersion: next, updatedAt: new Date() } });
  return next;
}

// atomic: reserve a version number, then push it and (if accepted) move the head in one write
// a tool's contract: the params its promoted (else first usable) version takes; null for a brand-new tool
export function toolContract(cap: Pick<Capability, "versions" | "activeVersion">): CapabilityVersion["params"] | null {
  const head = cap.versions.find((x) => x.v === cap.activeVersion);
  return (head ?? cap.versions.find((x) => x.status !== "rejected" && x.status !== "archived"))?.params ?? null;
}
export const sameParams = (a: CapabilityVersion["params"], b: CapabilityVersion["params"]) =>
  JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());
const fmtParams = (p: CapabilityVersion["params"]) => `(${Object.entries(p).map(([k, t]) => `${k}: ${t}`).join(", ")})`;

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
  // a tool's inputs are its frozen contract (tool id + params): agents cache tool definitions, so a version
  // with different params would break every caller. new inputs mean a new tool name.
  const contract = toolContract(cap);
  const d: Decision = contract && !sameParams(contract, version.params)
    ? { status: "rejected", activate: false, score: undefined, reason: `inputs changed (tool takes ${fmtParams(contract)}, this version takes ${fmtParams(version.params)}): publish it under a new tool name` }
    : await judge(version, head);
  Object.assign(version, { status: d.status, score: d.score, reason: d.reason });
  await h.capabilities.updateOne(
    { _id: id },
    { $push: { versions: version }, $set: { updatedAt: new Date(), ...(d.activate ? { activeVersion: v } : {}) } },
  );
  if (d.activate) await syncHead(h, id);
  return { version, decision: d, previousHead: head?.v ?? null, summary: summarize(version, head, d) };
}
