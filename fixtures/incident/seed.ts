// incident domain: services, deploys, per-minute error counts, and the hidden blame_deploy key.
// touches only inc_services, inc_deploys, inc_errors and answer_keys/_id "blame_deploy".
import { answerKeys, client, db } from "../../src/registry/db.js";

const MIN = 60_000;
const T0 = Date.parse("2026-09-22T00:00:00Z");
const DAYS = 3;
const MINUTES = DAYS * 24 * 60;
const at = (iso: string) => new Date(iso);
const off = (iso: string, m: number) => new Date(Date.parse(iso) + m * MIN);

// deterministic prng
let seed = 20260926;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const pick = <T>(xs: T[]) => xs[Math.floor(rnd() * xs.length)];
const sha = () => Array.from({ length: 7 }, () => "0123456789abcdef"[Math.floor(rnd() * 16)]).join("");

const services = [
  { _id: "api-gateway", owner: "team-edge", tier: 1, depends_on: ["auth", "orders", "search"] },
  { _id: "auth", owner: "team-identity", tier: 1, depends_on: ["db-proxy"] },
  { _id: "orders", owner: "team-commerce", tier: 1, depends_on: ["payments", "inventory", "db-proxy"] },
  { _id: "payments", owner: "team-payments", tier: 1, depends_on: ["db-proxy"] },
  { _id: "inventory", owner: "team-commerce", tier: 2, depends_on: ["db-proxy"] },
  { _id: "search", owner: "team-discovery", tier: 2, depends_on: [] },
  { _id: "notifications", owner: "team-growth", tier: 3, depends_on: ["orders"] },
  { _id: "db-proxy", owner: "team-platform", tier: 0, depends_on: [] },
];
const authors = ["maya", "jordan", "li", "sam", "priya", "diego", "kofi"];

type Dep = { service: string; at: Date; kind: "code" | "config"; status: "succeeded" | "failed" };
type Spike = { service: string; start: string; len: number; peak: number; deploys: Dep[]; use: "key" | "learn" | "reuse" | "baseline"; expect: { culprit: number | null; rollback: boolean } };

// designed spikes. expect.culprit is the index into deploys, cross-checked against the rule below.
const spikes: Spike[] = [
  { use: "key", service: "orders", start: "2026-09-22T03:40:00Z", len: 25, peak: 90, expect: { culprit: 0, rollback: true },
    deploys: [{ service: "orders", at: off("2026-09-22T03:40:00Z", -12), kind: "code", status: "succeeded" }] },
  { use: "key", service: "payments", start: "2026-09-22T09:15:00Z", len: 18, peak: 70, expect: { culprit: 0, rollback: false },
    deploys: [{ service: "payments", at: off("2026-09-22T09:15:00Z", -8), kind: "config", status: "succeeded" }] },
  { use: "key", service: "api-gateway", start: "2026-09-22T14:05:00Z", len: 30, peak: 120, expect: { culprit: 0, rollback: true },
    deploys: [
      { service: "auth", at: off("2026-09-22T14:05:00Z", -20), kind: "code", status: "succeeded" },
      { service: "notifications", at: off("2026-09-22T14:05:00Z", -5), kind: "code", status: "succeeded" }, // not a dependency
    ] },
  { use: "key", service: "search", start: "2026-09-22T20:30:00Z", len: 22, peak: 60, expect: { culprit: null, rollback: false },
    deploys: [{ service: "api-gateway", at: off("2026-09-22T20:30:00Z", -10), kind: "code", status: "succeeded" }] }, // downstream, not upstream
  { use: "key", service: "inventory", start: "2026-09-23T02:50:00Z", len: 20, peak: 80, expect: { culprit: 1, rollback: false },
    deploys: [
      { service: "db-proxy", at: off("2026-09-23T02:50:00Z", -25), kind: "code", status: "succeeded" },
      { service: "inventory", at: off("2026-09-23T02:50:00Z", -6), kind: "config", status: "succeeded" }, // latest wins
    ] },
  { use: "key", service: "orders", start: "2026-09-23T08:10:00Z", len: 28, peak: 100, expect: { culprit: 1, rollback: true },
    deploys: [
      { service: "orders", at: off("2026-09-23T08:10:00Z", -9), kind: "code", status: "failed" }, // never went live
      { service: "payments", at: off("2026-09-23T08:10:00Z", -18), kind: "code", status: "succeeded" },
    ] },
  { use: "key", service: "auth", start: "2026-09-23T13:45:00Z", len: 15, peak: 55, expect: { culprit: null, rollback: false },
    deploys: [
      { service: "auth", at: off("2026-09-23T13:45:00Z", -35), kind: "code", status: "succeeded" }, // outside window
      { service: "auth", at: off("2026-09-23T13:45:00Z", 4), kind: "code", status: "succeeded" }, // after spike start
    ] },
  { use: "key", service: "notifications", start: "2026-09-23T19:20:00Z", len: 24, peak: 65, expect: { culprit: 0, rollback: true },
    deploys: [{ service: "orders", at: off("2026-09-23T19:20:00Z", -30), kind: "code", status: "succeeded" }] }, // boundary, inclusive
  // not in the key
  { use: "learn", service: "payments", start: "2026-09-24T04:00:00Z", len: 26, peak: 95, expect: { culprit: 0, rollback: true },
    deploys: [
      { service: "db-proxy", at: off("2026-09-24T04:00:00Z", -14), kind: "code", status: "succeeded" },
      { service: "payments", at: off("2026-09-24T04:00:00Z", -3), kind: "code", status: "failed" },
    ] },
  { use: "reuse", service: "api-gateway", start: "2026-09-24T11:25:00Z", len: 21, peak: 85, expect: { culprit: 0, rollback: false },
    deploys: [
      { service: "search", at: off("2026-09-24T11:25:00Z", -7), kind: "config", status: "succeeded" },
      { service: "orders", at: off("2026-09-24T11:25:00Z", -22), kind: "code", status: "succeeded" },
    ] },
  { use: "baseline", service: "inventory", start: "2026-09-24T17:50:00Z", len: 19, peak: 75, expect: { culprit: 0, rollback: true },
    deploys: [
      { service: "inventory", at: off("2026-09-24T17:50:00Z", -16), kind: "code", status: "succeeded" },
      { service: "orders", at: off("2026-09-24T17:50:00Z", -4), kind: "code", status: "succeeded" }, // downstream
    ] },
];

// background deploys, kept clear of every spike window so they never change a designed answer
const deploys: (Dep & { _id?: string })[] = spikes.flatMap((s) => s.deploys);
const clear = (t: number) => spikes.every((s) => t < Date.parse(s.start) - 50 * MIN || t > Date.parse(s.start) + 15 * MIN);
while (deploys.length < 40) {
  const t = T0 + Math.floor(rnd() * MINUTES) * MIN;
  if (!clear(t)) continue;
  deploys.push({ service: pick(services)._id, at: new Date(t), kind: rnd() < 0.3 ? "config" : "code", status: rnd() < 0.12 ? "failed" : "succeeded" });
}
deploys.sort((a, b) => a.at.getTime() - b.at.getTime());
const deployDocs = deploys.map((d, i) => {
  d._id = `dep_${1001 + i}`;
  return { _id: d._id, service: d.service, at: d.at, kind: d.kind, status: d.status, author: pick(authors), commit: sha(),
    summary: d.kind === "config" ? pick(["bump pool size", "toggle feature flag", "raise timeout", "rotate rate limits"]) : pick(["refactor handler", "upgrade client lib", "new retry policy", "schema change", "perf fix"]) };
});

// error series: quiet baseline plus the spikes
const errorDocs: { service: string; minute: Date; count: number }[] = [];
for (const s of services) {
  const base = 1 + Math.floor(rnd() * 3);
  for (let m = 0; m < MINUTES; m++) {
    const t = T0 + m * MIN;
    let count = Math.max(0, base + Math.floor(rnd() * 4) - 2);
    for (const sp of spikes) {
      if (sp.service !== s._id) continue;
      const k = (t - Date.parse(sp.start)) / MIN;
      if (k >= 0 && k < sp.len) count += Math.round(sp.peak * (k < 3 ? 0.6 + 0.2 * k : Math.exp(-(k - 3) / (sp.len / 2))));
    }
    errorDocs.push({ service: s._id, minute: new Date(t), count });
  }
}

// the rule, implemented independently of the designed expectations
function blame(service: string, spikeStart: string) {
  const svc = services.find((s) => s._id === service)!;
  const scope = new Set([service, ...svc.depends_on]);
  const t = Date.parse(spikeStart);
  const cands = deployDocs
    .filter((d) => scope.has(d.service) && d.status === "succeeded" && d.at.getTime() >= t - 30 * MIN && d.at.getTime() <= t)
    .sort((a, b) => b.at.getTime() - a.at.getTime());
  const c = cands[0] ?? null;
  return { culprit_deploy_id: c ? c._id : null, rollback: !!c && c.kind !== "config" };
}

// cross-check: rule output must equal the designed intent, and the spike must be visible in the series
for (const s of spikes) {
  const got = blame(s.service, s.start);
  const want = { culprit_deploy_id: s.expect.culprit === null ? null : (s.deploys[s.expect.culprit] as any)._id, rollback: s.expect.rollback };
  if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`rule mismatch ${s.service}@${s.start}: ${JSON.stringify(got)} vs ${JSON.stringify(want)}`);
  const first = errorDocs.find((e) => e.service === s.service && e.minute.getTime() === Date.parse(s.start))!;
  const prev = errorDocs.find((e) => e.service === s.service && e.minute.getTime() === Date.parse(s.start) - MIN)!;
  if (!(first.count >= 5 * Math.max(prev.count, 2))) throw new Error(`spike not visible ${s.service}@${s.start}`);
}

await db.collection("inc_services").drop().catch(() => {});
await db.collection("inc_deploys").drop().catch(() => {});
await db.collection("inc_errors").drop().catch(() => {});
await db.collection("inc_services").insertMany(services as any);
await db.collection("inc_deploys").insertMany(deployDocs as any);
for (let i = 0; i < errorDocs.length; i += 5000) await db.collection("inc_errors").insertMany(errorDocs.slice(i, i + 5000));
await db.collection("inc_deploys").createIndex({ service: 1, at: -1 });
await db.collection("inc_errors").createIndex({ service: 1, minute: 1 });

const cases = spikes.filter((s) => s.use === "key").map((s) => ({ args: { service: s.service, spike_start: s.start }, expect: blame(s.service, s.start) }));
await answerKeys.updateOne({ _id: "blame_deploy" }, { $set: { cases } }, { upsert: true });

console.log(`seeded inc_services=${services.length} inc_deploys=${deployDocs.length} inc_errors=${errorDocs.length}`);
console.log(`answer key blame_deploy: ${cases.length} cases`);
for (const s of spikes.filter((x) => x.use !== "key")) console.log(`  ${s.use}: ${s.service} @ ${s.start} -> ${JSON.stringify(blame(s.service, s.start))}`);
if (process.argv.includes("--show-key")) console.log(JSON.stringify(cases, null, 1));
await client.close();
