// the recursive loop, one command: pick a hive's weakest tool, let the worker propose v+1 from the failing
// eval categories, let the evals judge, repeat until perfect or two rounds without gain.
// usage: npm run improve -- --hive team [--id advisory_owners] [--rounds 5]
import { HIVE_USER, client, hive } from "../src/registry/db.js";
import type { Capability } from "../src/registry/types.js";
import { baseOf, frac, improveTool, ratio } from "../src/worker/improve.js";
import { workerLlm } from "../src/worker/llm.js";

const arg = (k: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
const h = hive(arg("--hive") ?? "team");
const rounds = Number(arg("--rounds") ?? 5);

async function pick(): Promise<Capability | null> {
  const id = arg("--id");
  if (id) return h.capabilities.findOne({ _id: id });
  const keyed = new Set((await h.answerKeys.find({}, { projection: { _id: 1 } }).toArray()).map((k) => k._id));
  const caps = (await h.capabilities.find().toArray()).filter((c) => keyed.has(c._id) && baseOf(c) && ratio(baseOf(c)!.score) < 1);
  return caps.sort((a, b) => ratio(baseOf(a)!.score) - ratio(baseOf(b)!.score))[0] ?? null;
}

const cap = await pick();
if (!cap) {
  console.log(`hive ${h.name}: every tool already passes all its evals. nothing to improve.`);
  await client.close();
  process.exit(0);
}
const llm = await workerLlm();
console.log(`${HIVE_USER}'s worker (${llm.model}) improving ${h.name}/${cap._id}: promoted v${cap.activeVersion ?? "-"} ${frac(baseOf(cap)?.score)}`);
await improveTool(h, cap._id, {
  rounds, llm,
  on: (e) => {
    if (e.skipped) console.log(`round ${e.round}: ${HIVE_USER}'s worker draft was unusable, skipped`);
    else if (e.result) console.log(`round ${e.round}: ${HIVE_USER}'s worker drafted ${e.result.summary}${e.result.failing.length ? ` (still failing: ${e.result.failing.join(", ")})` : ""}`);
  },
});
const end = (await h.capabilities.findOne({ _id: cap._id }))!;
console.log(`done: ${h.name}/${cap._id} promoted v${end.activeVersion ?? "-"} ${frac(baseOf(end)?.score)}`);
await client.close();
