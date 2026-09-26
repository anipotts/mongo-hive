// end to end: human feedback turns real runs into evals, re-scores versions, reorders the leaderboard and
// queues the worker. drives the real mcp server (ani runs the tool) and the real cli (kap judges), in a
// throwaway shared hive that is dropped afterwards, so the real `live` hive stays untouched.
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { client as mongo, db, ensureHive, hive, hives } from "../src/registry/db.js";

const HIVE = "fbtest";
const t = hive(HIVE);
await t.db.dropDatabase();
await hives.deleteOne({ _id: HIVE });
await ensureHive(HIVE, "shared", "ani", ["kap"]);
const hadPrivate = !!(await hive("ani").capabilities.findOne({ _id: "triage_ci_failure" }, { projection: { _id: 1 } }));

async function as(user: string) {
  const c = new Client({ name: "verify", version: "0" });
  await c.connect(new StdioClientTransport({
    command: "npx", args: ["tsx", "--env-file=.env", "src/mcp/server.ts"],
    env: { ...process.env, HIVE_USER: user, HIVE_HARNESS: "script", HIVE_RUN_ID: `verify_fb_${user}` } as Record<string, string>,
  }));
  const call = async (name: string, args: object) => {
    const r: any = await c.callTool({ name, arguments: args as any });
    return r.isError ? { error: r.content?.[0]?.text } : JSON.parse(r.content[0].text);
  };
  return { call, close: () => c.close() };
}

// kap judges through the real cli, with kap's identity in a scratch config
const cfgDir = mkdtempSync(join(tmpdir(), "mh-kap-"));
const cfg = join(cfgDir, "config.json");
writeFileSync(cfg, JSON.stringify({ user: "kap", hive: HIVE, repoPath: process.cwd() }));
const judge = (outputId: string, verdict: string, expect?: object) =>
  execFileSync("npx", ["tsx", "bin/mongo-hive.ts", "feedback", outputId, verdict, ...(expect ? ["--expect", JSON.stringify(expect)] : [])],
    { env: { ...process.env, MONGO_HIVE_CONFIG: cfg }, encoding: "utf8" }).trim();

const board = async () => {
  const c = await t.capabilities.findOne({ _id: "triage_ci_failure" });
  return c!.versions.map((v) => `v${v.v} ${v.status} ${v.score ? `${v.score.passed}/${v.score.total}` : "unscored"}`).join(" | ") + `  (promoted: v${c!.activeVersion ?? "-"})`;
};

// the team hive's real triage recipe, and a variant that always says "not retry-safe"
const team = await hive("team").capabilities.findOne({ _id: "triage_ci_failure" });
const real = team!.versions.find((v) => v.v === team!.activeVersion)!;
const cautious = [...real.pipeline, { $set: { retry_safe: false } }];

const ani = await as("ani");
for (const [label, pipeline] of [["real recipe", real.pipeline], ["cautious variant", cautious]] as const) {
  await ani.call("propose_capability", { id: "triage_ci_failure", directive: team!.directive, scope: "ci", collection: real.collection, params: real.params, pipeline, whenToUse: real.whenToUse });
  const p = await ani.call("publish_capability", { id: "triage_ci_failure", to_hive: HIVE });
  console.log(`publish ${label}: ${p.summary ?? p.reason ?? JSON.stringify(p)}`);
}
console.log(`board: ${await board()}`);

// real failed runs: two the recipe calls not retry-safe, two it calls retry-safe
const failed = await db.collection("ci_runs").find({ status: "failed" }).sort({ started_at: 1 }).toArray();
const outs: { id: string; out: any; result: any }[] = [];
for (const r of failed) {
  const res = await ani.call("run_capability", { id: "triage_ci_failure", hive: HIVE, version: 1, args: { run_id: r._id } });
  if (res.result?.length === 1) outs.push({ id: String(r._id), out: res.outputId, result: res.result[0] });
}
const notSafe = outs.filter((o) => o.result.retry_safe === false).slice(0, 2);
const safe = outs.filter((o) => o.result.retry_safe === true).slice(0, 2);
console.log(`ani ran v1 on ${outs.length} failed runs; sample reply field: outputId=${outs[0]?.out}`);
await ani.close();

console.log(`\n# kap marks two answers correct`);
for (const o of notSafe) console.log(`${o.id}: ${judge(o.out, "correct")}`);
console.log(`board: ${await board()}`);
console.log(`\n# kap repeats a judgment (idempotent)`);
console.log(judge(notSafe[0].out, "correct"));
console.log(`\n# kap says ${safe[0].id} is NOT retry-safe (the team's rule), correcting v1`);
console.log(judge(safe[0].out, "wrong", { ...safe[0].result, retry_safe: false }));
console.log(`board: ${await board()}`);
console.log(`\n# kap corrects ${safe[1].id}'s cause, which no version gets right`);
console.log(judge(safe[1].out, "wrong", { ...safe[1].result, cause: "test", retry_safe: false }));
console.log(`board: ${await board()}`);

const jobs = await t.workerJobs.find({}, { projection: { _id: 0, trigger: 1, step: 1, capId: 1, note: 1 } }).toArray();
console.log(`\nworker_jobs: ${JSON.stringify(jobs)}`);
const key = await t.answerKeys.findOne({ _id: "triage_ci_failure" });
console.log(`evals: ${key!.cases.map((c) => `${c.source} by ${c.addedBy}`).join(", ")}`);
const ev = await t.events.find({ kind: "feedback" }).sort({ at: 1 }).toArray();
console.log(`feedback events: ${ev.map((e) => `${e.actor} ${e.verb} ${e.args.id} v${e.args.v} ${e.args.verdict}`).join(" | ")}`);

console.log(`\n# ani (author of both versions) judges her own run: must not score her versions`);
const aniCfg = join(cfgDir, "ani.json");
writeFileSync(aniCfg, JSON.stringify({ user: "ani", hive: HIVE, repoPath: process.cwd() }));
const own = outs.find((o) => ![...notSafe, ...safe].includes(o))!;
console.log(execFileSync("npx", ["tsx", "bin/mongo-hive.ts", "feedback", own.out, "correct"], { env: { ...process.env, MONGO_HIVE_CONFIG: aniCfg }, encoding: "utf8" }).trim());
console.log(`board: ${await board()}`);

await t.db.dropDatabase();
await hives.deleteOne({ _id: HIVE });
// ani's private copies were proposed only for this check; remove them unless ani already had that tool
if (!hadPrivate) await hive("ani").capabilities.deleteOne({ _id: "triage_ci_failure" });
console.log(`\ncleaned up hive ${HIVE}${hadPrivate ? "" : " and ani's scratch copies"}`);
await mongo.close();
