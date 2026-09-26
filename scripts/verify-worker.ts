// end to end for the always-on worker, in a throwaway shared hive (never live or team):
// a promoted tool passes every eval it has, ani runs it on a case it gets wrong, kap gives "wrong" feedback
// through the real cli, the eval drops the promoted version below total, a job is queued, and a separately
// running `npm run worker -- --hives wltest` picks it up. the hive is dropped afterwards.
// usage: npx tsx --env-file=.env scripts/verify-worker.ts   (with the worker already running on wltest)
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { client as mongo, db, ensureHive, hive, hives } from "../src/registry/db.js";
import { execute } from "../src/learner/index.js";
import { rescore } from "../src/hive/feedback.js";

const HIVE = "wltest";
const ID = "advisory_owners";
const t = hive(HIVE);
await t.db.dropDatabase();
await hives.deleteOne({ _id: HIVE });
await ensureHive(HIVE, "shared", "ani", ["kap"]);

// start from the team's real tool: its promoted version and its evals, minus one case it gets wrong
const team = hive("team");
const cap = (await team.capabilities.findOne({ _id: ID }))!;
const head = cap.versions.find((v) => v.v === cap.activeVersion)!;
const key = (await team.answerKeys.findOne({ _id: ID }))!;
const same = (a: any, b: Record<string, unknown>) => Object.entries(b).every(([k, v]) => JSON.stringify(a?.[k]) === JSON.stringify(v));
let heldOut = -1;
for (let i = 0; i < key.cases.length && heldOut < 0; i++) {
  const out = await execute(db, head, key.cases[i].args);
  if (!same(out[0], key.cases[i].expect)) heldOut = i;
}
if (heldOut < 0) throw new Error("team's promoted version passes every case; nothing to hold out");
const missed = key.cases[heldOut];
await t.answerKeys.insertOne({ ...key, cases: key.cases.filter((_, i) => i !== heldOut) });
await t.capabilities.insertOne({
  _id: ID, directive: cap.directive, scope: cap.scope, activeVersion: null, nextVersion: 1, updatedAt: new Date(),
  versions: [{ ...head, v: 1, status: "superseded", author: "ani", harness: "claude-code", createdAt: new Date() }], // ani wrote it, kap judges it (independent)
});
await rescore(t, ID);
const board = async () => {
  const c = (await t.capabilities.findOne({ _id: ID }))!;
  return c.versions.map((v) => `v${v.v} ${v.status} ${v.score ? `${v.score.passed}/${v.score.total}` : "unscored"}`).join(" | ") + `  (promoted: v${c.activeVersion ?? "-"})`;
};
console.log(`start: ${await board()}; open jobs: ${await t.workerJobs.countDocuments({ step: "queued" })}`);

// ani runs the tool through the real mcp server on the case it gets wrong
const c = new Client({ name: "verify", version: "0" });
await c.connect(new StdioClientTransport({
  command: "npx", args: ["tsx", "--env-file=.env", "src/mcp/server.ts"],
  env: { ...process.env, HIVE_USER: "ani", HIVE_HARNESS: "script", HIVE_RUN_ID: "verify_worker" } as Record<string, string>,
}));
const r: any = await c.callTool({ name: "run_capability", arguments: { id: ID, hive: HIVE, args: missed.args } });
const ran = JSON.parse(r.content[0].text);
await c.close();
console.log(`ani ran v${ran.version}: outputId ${ran.outputId}`);

// kap says it's wrong, with the right answer, through the real cli
const cfgDir = mkdtempSync(join(tmpdir(), "mh-kap-"));
const cfg = join(cfgDir, "config.json");
writeFileSync(cfg, JSON.stringify({ user: "kap", hive: HIVE, repoPath: process.cwd() }));
console.log(execFileSync("npx", ["tsx", "bin/mongo-hive.ts", "feedback", ran.outputId, "wrong", "--expect", JSON.stringify(missed.expect)],
  { env: { ...process.env, MONGO_HIVE_CONFIG: cfg }, encoding: "utf8" }).trim());
console.log(`after feedback: ${await board()}`);

// wait for the running worker to finish the queued job
const t0 = Date.now();
let jobs = await t.workerJobs.find().toArray();
while (Date.now() - t0 < 8 * 60_000 && (!jobs.length || jobs.some((j) => ["queued", "drafting", "validating"].includes(j.step)))) {
  await new Promise((res) => setTimeout(res, 3000));
  jobs = await t.workerJobs.find().toArray();
}
for (const j of jobs) console.log(`job ${j._id}: ${j.step} ${j.claimedBy ?? ""} ${j.note ?? ""}`);
console.log(`end: ${await board()}  (${Math.round((Date.now() - t0) / 1000)}s after feedback)`);

await t.db.dropDatabase();
await hives.deleteOne({ _id: HIVE });
await mongo.close();
