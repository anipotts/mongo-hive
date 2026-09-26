// go/no-go: write one doc, read it back, report server facts. never prints the uri.
import { client, db } from "../src/registry/db.js";

const t0 = Date.now();
const admin = db.admin();
await admin.ping();
const build = await admin.buildInfo();
const r = await db.collection("ping").insertOne({ at: new Date(), by: process.env.USER });
const back = await db.collection("ping").findOne({ _id: r.insertedId });
const hosts = client.options.hosts.map((h) => h.host?.split(".")[0]);
console.log({
  ok: !!back,
  mongodb: build.version,
  db: db.databaseName,
  shards: hosts,
  roundTripMs: Date.now() - t0,
});
await client.close();
