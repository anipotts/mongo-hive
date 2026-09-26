// prints the honeycomb: each hive's tools and heads, who is behind or ahead, recent events.
import { client, hive, hives } from "../src/registry/db.js";
import type { Capability } from "../src/registry/types.js";

const all = await hives.find().sort({ visibility: -1, _id: 1 }).toArray();
const caps = new Map<string, Capability[]>();
for (const info of all) caps.set(info._id, await hive(info._id).capabilities.find().toArray());

for (const info of all) {
  const h = hive(info._id);
  console.log(`\nhive ${info._id} (${info.visibility}, members: ${info.members.join(",")})`);
  for (const c of caps.get(info._id)!)
    console.log(`  ${c._id} head=v${c.activeVersion ?? "-"} ${c.versions.map((v) => `v${v.v}:${v.status}(${v.author}/${v.harness})`).join(" ")}`);
  for (const a of await h.agents.find().toArray()) {
    const behind = caps.get(info._id)!.filter((c) => c.activeVersion && (a.pulled?.[c._id] ?? 0) < c.activeVersion).map((c) => c._id);
    console.log(`  agent ${a._id} behind=${behind.join(",") || "none"} pinned=${JSON.stringify(a.pinned ?? {})}`);
  }
  // ahead: your private hive has a newer, different recipe than this shared hive's head
  if (info.visibility === "shared")
    for (const m of info.members) {
      for (const mine of caps.get(m) ?? []) {
        const shared = caps.get(info._id)!.find((c) => c._id === mine._id);
        const head = shared?.versions.find((v) => v.v === shared.activeVersion);
        const latest = [...mine.versions].reverse().find((v) => v.status !== "rejected");
        if (latest && (!head || (latest.hash !== head.hash && latest.createdAt > head.createdAt)))
          console.log(`  ${m} is AHEAD on ${mine._id}: private v${latest.v} (${latest.status}) not in ${info._id}${head ? ` (head v${head.v})` : ""}`);
      }
    }
  for (const e of await h.events.find().sort({ at: -1 }).limit(Number(process.argv[2] ?? 4)).toArray())
    console.log(`  ${e.at.toISOString().slice(11, 19)} ${e.user}/${e.harness} ${e.tool} ${JSON.stringify(e.result)}`);
}
await client.close();
