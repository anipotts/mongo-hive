// prints deps runs from events and the advisory_impact capability (read-only).
import { capabilities, client, events } from "../../src/registry/db.js";
for (const run of process.argv.slice(2)) {
  const ev = await events.find({ runId: run }).sort({ at: 1 }).toArray();
  const counts: Record<string, number> = {};
  for (const e of ev) counts[e.tool] = (counts[e.tool] ?? 0) + 1;
  const span = ev.length ? (ev.at(-1)!.at.getTime() - ev[0].at.getTime()) / 1000 : 0;
  console.log(run, JSON.stringify(counts), `span=${span}s`, "seq=" + ev.map((e) => e.tool[0] + e.tool.split("_")[0].slice(1, 3)).join(","));
  for (const e of ev) if (e.tool !== "explore") console.log("   ", e.tool, JSON.stringify(e.args).slice(0, 160), JSON.stringify(e.result));
}
const cap = await capabilities.findOne({ _id: "advisory_impact" });
if (cap) {
  console.log("head", cap.activeVersion, cap.scope);
  for (const v of cap.versions) console.log(`v${v.v} ${v.status} ${v.author}/${v.harness} ${JSON.stringify(v.score)} ${v.reason} ${v.collection}`);
  if (process.env.SHOW) console.log(JSON.stringify(cap.versions.find((v) => v.v === Number(process.env.SHOW))?.pipeline));
}
await client.close();
