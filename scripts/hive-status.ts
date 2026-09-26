// prints the honeycomb: each tool as a ranked leaderboard, and where every agent stands on it.
import { client, hive, hives } from "../src/registry/db.js";
import type { Capability } from "../src/registry/types.js";
import { board, scoreOn, standing } from "../src/validator/index.js";

const all = await hives.find().sort({ visibility: -1, _id: 1 }).toArray();
const caps = new Map<string, Capability[]>();
for (const info of all) caps.set(info._id, await hive(info._id).capabilities.find().toArray());
const fmt = (s?: { passed: number; total: number; ms: number }) => (s ? `${s.passed}/${s.total} ${s.ms}ms` : "unscored");

for (const info of all) {
  const h = hive(info._id);
  console.log(`\nhive ${info._id} (${info.visibility}, members: ${info.members.join(",")})`);
  const agents = await h.agents.find().toArray();
  for (const c of caps.get(info._id)!) {
    const rows = board(c);
    const pending = c.versions.filter((v) => v.status === "unverified").map((v) => `v${v.v}`);
    console.log(`  ${c._id}${rows.length ? "" : " (no tested versions yet)"}${pending.length ? `  unverified: ${pending.join(",")}` : ""}`);
    for (const r of rows) console.log(`    #${r.rank} v${r.v}  ${fmt(r.score)}  ${r.author}/${r.harness}`);
    for (const a of agents) {
      // a member's private version counts only once it has been scored on this hive's hidden cases
      let privateBest;
      if (info.visibility === "shared" && a.user !== info._id) {
        const mine = caps.get(a.user)?.find((x) => x._id === c._id);
        for (const pv of mine?.versions.filter((x) => x.status !== "rejected") ?? []) {
          if (c.versions.some((x) => x.hash === pv.hash)) continue;
          const sc = await scoreOn(h, c._id, pv);
          if (sc && (!privateBest || sc.passed / sc.total > privateBest.score.passed / privateBest.score.total)) privateBest = { v: pv.v, score: sc };
        }
      }
      const st = standing(c, a.pulled?.[c._id] ?? null, a.pinned?.[c._id] ?? null, privateBest);
      if (!st) continue;
      const detail =
        st.state === "better_available" ? ` v${st.v ?? "-"} -> v${st.best} by ${st.author} (${st.delta})`
        : st.state === "yours_beats_team" ? ` private v${st.privateV} scores ${fmt(st.score)} vs head v${st.head}: publish it`
        : ` v${st.v}`;
      console.log(`      ${a._id.padEnd(18)} ${st.state}${detail}`);
    }
  }
  for (const e of await h.events.find().sort({ at: -1 }).limit(Number(process.argv[2] ?? 3)).toArray())
    console.log(`  ${e.at.toISOString().slice(11, 19)} ${e.user}/${e.harness} ${e.tool} ${JSON.stringify(e.result)}`);
}
await client.close();
