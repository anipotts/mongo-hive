// one-off: the background agent was renamed keeper -> worker. moves keeper_jobs to worker_jobs and relabels
// versions it authored as "<user>'s worker" (author = the hive user who ran it, harness = "worker").
import { client, hives, hive } from "../src/registry/db.js";

const owner = process.env.HIVE_USER ?? "ani";
for (const info of await hives.find().toArray()) {
  const h = hive(info._id);
  const names = (await h.db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name);
  if (names.includes("keeper_jobs") && !names.includes("worker_jobs")) {
    await h.db.collection("keeper_jobs").rename("worker_jobs");
    console.log(`${h.name}: keeper_jobs -> worker_jobs`);
  }
  const r = await h.capabilities.updateMany(
    { "versions.author": "keeper" },
    { $set: { "versions.$[k].author": owner, "versions.$[k].harness": "worker" } },
    { arrayFilters: [{ "k.author": "keeper" }] },
  );
  if (r.modifiedCount) console.log(`${h.name}: relabeled worker versions in ${r.modifiedCount} capabilities`);
}
await client.close();
