// prints what the hive knows: tools, heads, who is behind, recent events.
import { agents, capabilities, client, events } from "../src/registry/db.js";

const caps = await capabilities.find().toArray();
console.log("capabilities:");
for (const c of caps)
  console.log(`  ${c._id} head=v${c.activeVersion ?? "-"} versions=${c.versions.map((v) => `v${v.v}:${v.status}(${v.author}/${v.harness})`).join(" ")}`);
console.log("agents:");
for (const a of await agents.find().toArray()) {
  const behind = caps.filter((c) => c.activeVersion && (a.pulled?.[c._id] ?? 0) < c.activeVersion).map((c) => c._id);
  console.log(`  ${a._id} pulled=${JSON.stringify(a.pulled)} pinned=${JSON.stringify(a.pinned)} behind=${behind.join(",") || "none"}`);
}
console.log("recent events:");
for (const e of await events.find().sort({ at: -1 }).limit(Number(process.argv[2] ?? 10)).toArray())
  console.log(`  ${e.at.toISOString().slice(11, 19)} ${e.user}/${e.harness} ${e.tool} ${JSON.stringify(e.result)}`);
await client.close();
