// restores a hive to a saved demo snapshot so every rehearsal and take starts identically.
// work data is re-seeded, tools/evals/agents are restored exactly, and traces from earlier takes are cleared.
// usage: npm run demo:reset -- [name=baseline] [--private]   (--private also empties hive_ani and hive_kap tools + traces)
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { BSON, type Document } from "mongodb";
import { client } from "../src/registry/db.js";

const args = process.argv.slice(2);
const name = args.find((a) => !a.startsWith("--")) ?? "baseline";
const snap = BSON.EJSON.parse(readFileSync(`fixtures/demo/${name}.json`, "utf8"), { relaxed: false }) as Record<string, Document[]> & { hive: string };
if (snap.hive === "live") throw new Error("refusing to reset the live hive: it holds real work");

execFileSync("npx", ["tsx", "--env-file=.env", "scripts/seed.ts"], { stdio: "inherit" });

const db = client.db(`hive_${snap.hive}`);
const TRACES = ["events", "runs", "sessions", "evaluations", "worker_jobs", "outputs"];
for (const c of TRACES) await db.collection(c).deleteMany({});
for (const c of ["capabilities", "answer_keys", "agents"]) {
  await db.collection(c).deleteMany({});
  if (snap[c]?.length) await db.collection(c).insertMany(snap[c]);
}
if (args.includes("--private"))
  for (const h of ["hive_ani", "hive_kap"])
    for (const c of ["capabilities", "answer_keys", "agents", ...TRACES]) await client.db(h).collection(c).deleteMany({});

console.log(`reset hive ${snap.hive} to snapshot ${name}: ${snap.capabilities.length} tools, ${snap.answer_keys.length} eval sets, ${snap.agents.length} agents; traces cleared${args.includes("--private") ? "; private hives emptied" : ""}`);
await client.close();
