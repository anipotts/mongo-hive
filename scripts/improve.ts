// the recursive loop, one command: pick a hive's weakest tool, let the keeper propose v+1 from the failing
// categories, let the hidden cases judge, repeat until perfect or two rounds without gain.
// usage: npm run improve -- --hive team [--id advisory_owners] [--rounds 5]
import { client, hive } from "../src/registry/db.js";
import type { Capability, CapabilityVersion } from "../src/registry/types.js";
import { rank } from "../src/validator/index.js";
import { claim, draftAndCommit, enqueue, failingFor, outputFields, type Attempt } from "../src/keeper/index.js";
import { keeperLlm } from "../src/keeper/llm.js";

const arg = (k: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
const h = hive(arg("--hive") ?? "team");
const rounds = Number(arg("--rounds") ?? 5);
const ratio = (s?: CapabilityVersion["score"]) => (s && s.total ? s.passed / s.total : 0);

// the version to improve on: the head, else the best scored attempt so far
const baseOf = (c: Capability) => c.versions.find((v) => v.v === c.activeVersion) ?? rank(c)[0] ??
  [...c.versions].filter((v) => v.score?.total).sort((a, b) => ratio(b.score) - ratio(a.score))[0];

async function pick(): Promise<Capability | null> {
  const id = arg("--id");
  if (id) return h.capabilities.findOne({ _id: id });
  const keyed = new Set((await h.answerKeys.find({}, { projection: { _id: 1 } }).toArray()).map((k) => k._id));
  const caps = (await h.capabilities.find().toArray()).filter((c) => keyed.has(c._id) && baseOf(c) && ratio(baseOf(c)!.score) < 1);
  return caps.sort((a, b) => ratio(baseOf(a)!.score) - ratio(baseOf(b)!.score))[0] ?? null;
}

const cap = await pick();
if (!cap) {
  console.log(`hive ${h.name}: every tested tool already passes all its hidden cases. nothing to improve.`);
  await client.close();
  process.exit(0);
}
const llm = await keeperLlm();
const frac = (s?: CapabilityVersion["score"]) => (s ? `${s.passed}/${s.total}` : "unscored");
let best = ratio(baseOf(cap)?.score);
let stale = 0;
const history: Attempt[] = [];
console.log(`keeper (${llm.model}) improving ${h.name}/${cap._id}: head v${cap.activeVersion ?? "-"} ${frac(baseOf(cap)?.score)}`);

for (let r = 1; r <= rounds; r++) {
  const now = (await h.capabilities.findOne({ _id: cap._id }))!;
  const base = baseOf(now)!;
  const failing = await failingFor(h, cap._id, base);
  const job = await enqueue(h, { trigger: "improve", capId: cap._id, note: `round ${r}: improve on v${base.v} (${frac(base.score)}); failing ${failing.join(", ") || "none"}` });
  await claim(h, job._id);
  const res = await draftAndCommit({
    h, cap: now, params: base.params, collection: base.collection, output: await outputFields(h, cap._id),
    base, failing, history, job: (await h.keeperJobs.findOne({ _id: job._id }))!, llm,
  });
  if (!res) {
    console.log(`round ${r}: keeper draft was unusable, skipped`);
    stale++;
  } else {
    history.push(res.attempt);
    console.log(`round ${r}: keeper drafted ${res.summary}${res.failing.length ? ` (still failing: ${res.failing.join(", ")})` : ""}`);
    const got = ratio(res.decision.score);
    if (got > best) { best = got; stale = 0; } else stale++;
    if (got === 1 && res.decision.activate) break;
  }
  if (stale >= 2) { console.log("two rounds without gain: stopping"); break; }
}
const end = (await h.capabilities.findOne({ _id: cap._id }))!;
console.log(`done: ${h.name}/${cap._id} head v${end.activeVersion ?? "-"} ${frac(end.versions.find((v) => v.v === end.activeVersion)?.score)}`);
await client.close();
