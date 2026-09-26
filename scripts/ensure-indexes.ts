// the indexes the console and pulse sort on, in every hive. idempotent: safe to rerun after a new hive is created.
import { client, hive, hives } from "../src/registry/db.js";

const WANT: [string, Record<string, 1 | -1>][] = [
  ["events", { at: -1 }],
  ["events", { sessionId: 1, at: 1 }],
  ["sessions", { lastEventAt: -1 }],
  ["outputs", { at: -1 }],
  ["worker_jobs", { updatedAt: -1 }],
  ["capabilities", { updatedAt: -1 }],
];

for (const { _id } of await hives.find({}, { projection: { _id: 1 } }).toArray()) {
  const h = hive(_id);
  await Promise.all(WANT.map(([c, key]) => h.db.collection(c).createIndex(key)));
  console.log(`hive_${_id}: ${WANT.length} indexes ok`);
}
await client.close();
