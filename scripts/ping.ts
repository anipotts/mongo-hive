import { client, db } from "../src/registry/db.js";

const r = await db.collection("ping").insertOne({ at: new Date() });
console.log("wrote", r.insertedId, "read", await db.collection("ping").findOne({ _id: r.insertedId }));
await client.close();
