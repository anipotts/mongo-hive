// fill supersedes / supersededBy / replacedReason on versions that led before syncHead started writing them.
// replays each tool's head chain: every version that ever led (active or superseded) replaced the one before it.
// dry run by default. usage: npx tsx --env-file=.env scripts/backfill-accountability.ts --hive team [--write]
import { client, hive } from "../src/registry/db.js";
import type { CapabilityVersion } from "../src/registry/types.js";

const arg = (k: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
const h = hive(arg("--hive") ?? "team");
const write = process.argv.includes("--write");
const fmt = (s?: CapabilityVersion["score"]) => (s ? `${s.passed}/${s.total} in ${s.ms}ms` : "unscored");

try {
  for (const cap of await h.capabilities.find().toArray()) {
    const led = cap.versions.filter((v) => v.status === "active" || v.status === "superseded").sort((a, b) => +new Date(a.createdAt) - +new Date(b.createdAt));
    const patch = new Map<number, Partial<CapabilityVersion>>();
    for (let i = 1; i < led.length; i++) {
      const [prev, next] = [led[i - 1], led[i]];
      if (next.supersedes == null) patch.set(next.v, { ...patch.get(next.v), supersedes: prev.v, replacedReason: `${fmt(next.score)} beat ${fmt(prev.score)}` });
      if (prev.supersededBy == null) patch.set(prev.v, { ...patch.get(prev.v), supersededBy: next.v });
    }
    if (!patch.size) continue;
    for (const [v, p] of patch) console.log(`${h.name}/${cap._id} v${v}`, JSON.stringify(p));
    if (!write) continue;
    const versions = cap.versions.map((v) => ({ ...v, ...patch.get(v.v) }));
    const res = await h.capabilities.updateOne({ _id: cap._id, updatedAt: cap.updatedAt }, { $set: { versions } });
    if (!res.modifiedCount) console.log(`  skipped ${cap._id}: it changed while backfilling, run again`);
  }
  if (!write) console.log("dry run. pass --write to apply.");
} finally {
  await client.close();
}
