// saves a hive's demo state (tools, evals, agents) to fixtures/demo/<name>.json so demo:reset can restore it exactly.
// usage: npm run demo:snapshot -- [name=baseline] [--hive team]
import { writeFileSync } from "node:fs";
import { BSON } from "mongodb";
import { client } from "../src/registry/db.js";

const args = process.argv.slice(2);
const name = args.find((a) => !a.startsWith("--")) ?? "baseline";
const hiveName = args.includes("--hive") ? args[args.indexOf("--hive") + 1] : "team";
const db = client.db(`hive_${hiveName}`);
const KEEP = ["capabilities", "answer_keys", "agents"] as const;

const snap: Record<string, unknown> = { hive: hiveName, takenAt: new Date() };
for (const c of KEEP) snap[c] = await db.collection(c).find().toArray();
writeFileSync(`fixtures/demo/${name}.json`, BSON.EJSON.stringify(snap, undefined, 1, { relaxed: false }));
console.log(`snapshot ${name}: hive ${hiveName}, ${KEEP.map((c) => `${(snap[c] as unknown[]).length} ${c}`).join(", ")}`);
await client.close();
