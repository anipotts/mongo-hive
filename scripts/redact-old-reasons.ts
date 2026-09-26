// one-off: old rejection reasons echoed hidden case inputs; replace them with a count-free summary
import { MongoClient } from "mongodb";
const c = new MongoClient(process.env.MONGODB_URI!);
for (const name of (await c.db().admin().listDatabases()).databases.map((d) => d.name).filter((n) => n.startsWith("hive_") || n === "harness")) {
  const r = await c.db(name).collection("capabilities").updateMany(
    { "versions.reason": { $regex: "case \\{" } },
    { $set: { "versions.$[v].reason": "failed hidden cases (details withheld)" } },
    { arrayFilters: [{ "v.reason": { $regex: "case \\{" } }] },
  );
  if (r.modifiedCount) console.log(name, "redacted", r.modifiedCount);
}
await c.close();
