// one publish path for every surface (mcp server, console). only the recipe travels; the target hive's
// hidden cases decide whether it leads there.
import { hives, type Hive } from "../registry/db.js";
import type { Capability, CapabilityVersion } from "../registry/types.js";
import { findDataLiterals } from "../learner/index.js";
import { commitVersion, decide, validate } from "../validator/index.js";

// what a publish would send: a chosen version, else the private head, else the latest kept/unverified draft
export function publishable(cap: Capability, v?: number): CapabilityVersion | undefined {
  if (v != null) return cap.versions.find((x) => x.v === v && x.status !== "rejected" && x.status !== "archived");
  if (cap.activeVersion != null) return cap.versions.find((x) => x.v === cap.activeVersion);
  return [...cap.versions].reverse().find((x) => x.status === "unverified");
}

export type PublishResult =
  | { ok: false; error: string }
  | { ok: true; id: string; from: string; to: string; version: number | null; published: boolean; previousHead: number | null; score?: CapabilityVersion["score"]; reason: string; summary?: string };

export async function publishCapability(opts: { home: Hive; target: Hive; id: string; user: string; harness: string; v?: number }): Promise<PublishResult> {
  const { home, target, id, user, harness } = opts;
  const info = await hives.findOne({ _id: target.name });
  if (info?.visibility !== "shared") return { ok: false, error: `hive ${target.name} is private; publish into a shared hive` };
  if (!(info.owner === user || info.members.includes(user))) return { ok: false, error: `you (${user}) are not a member of hive ${target.name}` };
  const src = await home.capabilities.findOne({ _id: id });
  const ver = src && publishable(src, opts.v);
  if (!src || !ver) return { ok: false, error: `no publishable version of ${id} in your private hive ${home.name}` };
  const leaked = findDataLiterals(ver.pipeline);
  if (leaked.length)
    return {
      ok: true, id, from: `${home.name} v${ver.v}`, to: target.name, version: null, published: false, previousHead: null,
      reason: `pipeline hard-codes data values (${[...new Set(leaked)].slice(0, 3).join(", ")}); turn them into {{params}} before publishing`,
    };
  const { version, decision, previousHead, summary } = await commitVersion(
    target, id, { directive: src.directive, scope: src.scope },
    (v) => ({
      v, status: "rejected", collection: ver.collection, params: ver.params, pipeline: ver.pipeline, whenToUse: ver.whenToUse,
      author: user, harness, hash: ver.hash, publishedFrom: { hive: home.name, v: ver.v }, createdAt: new Date(),
    }),
    async (v, head) => decide(await validate(target, id, v), head, false),
  );
  if (decision.activate)
    await target.agents.updateOne(
      { _id: `${user}:${harness}` },
      { $set: { user, harness, lastSeen: new Date(), [`pulled.${id}`]: version.v }, $setOnInsert: { pinned: {} } },
      { upsert: true },
    );
  return { ok: true, id, from: `${home.name} v${ver.v}`, to: target.name, version: version.v, published: decision.activate, previousHead, score: decision.score, reason: decision.reason, summary };
}
