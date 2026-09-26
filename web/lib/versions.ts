import "server-only";
import type { Hive } from "../../src/registry/db";
import type { Capability, CapabilityVersion } from "../../src/registry/types";

// per-version accountability for the tool page: what changed, who runs it, how it scored over time.
// nothing here returns hidden case inputs; evaluations are reduced to scores.

type Score = NonNullable<CapabilityVersion["score"]>;

export interface TimelineEntry {
  v: number;
  status: CapabilityVersion["status"];
  author: string;
  harness: string;
  score?: Score;
  reason?: string;
  supersedes?: number;
  supersededBy?: number;
  replacedReason?: string;
  publishedFrom?: { hive: string; v: number };
  createdAt: Date;
}

// newest first: every version, including rejected ones, with what it replaced and why
export function timeline(cap: Capability): TimelineEntry[] {
  return [...cap.versions]
    .sort((a, b) => b.v - a.v)
    .map((x) => ({
      v: x.v, status: x.status, author: x.author, harness: x.harness, score: x.score, reason: x.reason,
      supersedes: x.supersedes, supersededBy: x.supersededBy, replacedReason: x.replacedReason,
      publishedFrom: x.publishedFrom, createdAt: x.createdAt,
    }));
}

export type DiffLine = { op: "same" | "add" | "del"; text: string };

export interface RecipeDiff {
  from: number | null;
  to: number;
  changed: ("collection" | "params" | "pipeline" | "whenToUse")[];
  lines: DiffLine[]; // line diff of the recipe rendered as json
}

const render = (x: CapabilityVersion) =>
  JSON.stringify({ collection: x.collection, params: x.params, pipeline: x.pipeline, whenToUse: x.whenToUse }, null, 2).split("\n");

// classic lcs line diff; recipes are a few dozen lines, so O(n*m) is fine
function diffLines(a: string[], b: string[]): DiffLine[] {
  const n = a.length, m = b.length;
  const L = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out: DiffLine[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ op: "same", text: a[i] }); i++; j++; }
    else if (L[i + 1][j] >= L[i][j + 1]) out.push({ op: "del", text: a[i++] });
    else out.push({ op: "add", text: b[j++] });
  }
  while (i < n) out.push({ op: "del", text: a[i++] });
  while (j < m) out.push({ op: "add", text: b[j++] });
  return out;
}

// vN against what it replaced (supersedes), else the nearest lower version, else against nothing
export function recipeDiff(cap: Capability, v: number, against?: number): RecipeDiff | null {
  const to = cap.versions.find((x) => x.v === v);
  if (!to) return null;
  const baseV = against ?? to.supersedes ?? Math.max(-1, ...cap.versions.filter((x) => x.v < v).map((x) => x.v));
  const from = cap.versions.find((x) => x.v === baseV);
  const same = (k: "collection" | "params" | "pipeline" | "whenToUse") => JSON.stringify(from?.[k]) === JSON.stringify(to[k]);
  return {
    from: from?.v ?? null,
    to: v,
    changed: (["collection", "params", "pipeline", "whenToUse"] as const).filter((k) => !same(k)),
    lines: diffLines(from ? render(from) : [], render(to)),
  };
}

// { v: ["kap:claude-code", ...] } for pins, and the same shape for what each agent last pulled
export async function pinsByVersion(h: Hive, capId: string) {
  const agents = await h.agents.find({}, { projection: { user: 1, harness: 1, pinned: 1, pulled: 1 } }).toArray();
  const pinned: Record<number, string[]> = {};
  const running: Record<number, string[]> = {};
  for (const a of agents) {
    const who = `${a.user}:${a.harness}`;
    const p = a.pinned?.[capId];
    const r = a.pulled?.[capId];
    if (p != null) (pinned[p] ??= []).push(who);
    if (r != null) (running[r] ??= []).push(who);
  }
  return { pinned, running };
}

export interface EvalPoint { passed: number; total: number; ms: number; at: Date }

// every scoring of every version in this hive, oldest first. scores only: no failures text, no case inputs.
// matched on recipe hash, because scoreOn also logs private versions here under their private v numbers;
// when several versions share a recipe, the row's own v picks among them.
export async function evalHistory(h: Hive, cap: Capability): Promise<Record<number, EvalPoint[]>> {
  const byHash = new Map<string, number[]>();
  for (const x of cap.versions) byHash.set(x.hash, [...(byHash.get(x.hash) ?? []), x.v]);
  const rows = await h.evaluations
    .find({ capId: cap._id }, { projection: { _id: 0, v: 1, hash: 1, passed: 1, total: 1, ms: 1, at: 1 } })
    .sort({ at: 1 })
    .toArray();
  const out: Record<number, EvalPoint[]> = {};
  for (const r of rows) {
    const vs = byHash.get(r.hash) ?? [];
    const v = vs.includes(r.v) ? r.v : vs.length === 1 ? vs[0] : null;
    if (v != null) (out[v] ??= []).push({ passed: r.passed, total: r.total, ms: r.ms, at: r.at });
  }
  return out;
}
