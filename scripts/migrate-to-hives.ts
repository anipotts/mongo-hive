// one-off: move hive records out of the flat `harness` db into hive_team (shared: ani, kap).
// domain work data (ci_*, inc_*, dep_*) stays in harness.
import { client, ensureHive, hive } from "../src/registry/db.js";

const src = client.db("harness");
const team = hive("team");
await ensureHive("team", "shared", "ani", ["kap"]);
for (const name of ["capabilities", "answer_keys", "agents", "events", "runs", "evaluations"]) {
  const docs = await src.collection(name).find().toArray();
  if (docs.length) {
    await team.db.collection(name).deleteMany({ _id: { $in: docs.map((d) => d._id) } });
    await team.db.collection(name).insertMany(docs);
  }
  await src.collection(name).drop().catch(() => {});
  console.log(`${name}: moved ${docs.length}`);
}
await client.close();
