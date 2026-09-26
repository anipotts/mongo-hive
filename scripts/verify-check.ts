// proves the auto-check of untested tools (docs/contract.md, auto-check): a teammate's worker writes its own reference
// from the tool's description alone, replays the tool's runs, and agreement becomes provisional evals that can promote
// it; disagreement waits for a person. deterministic stub models for the rules, the real worker model for one
// end-to-end check, a real mcp client for the agent-facing side and the real worker process for the sweep.
// throwaway hives and users only (never live/team; team is read for one recipe). needs a worker model key.
// run: npx tsx --env-file=.env scripts/verify-check.ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { client, db, hive, hives, honeycomb, type Hive } from "../src/registry/db.js";
import type { CapabilityVersion, WorkerJob } from "../src/registry/types.js";
import { execute, hashRecipe } from "../src/learner/index.js";
import { commitVersion, decide, validate } from "../src/validator/index.js";
import { OPEN_STEPS, claim, queueCheck } from "../src/worker/index.js";
import { checkTool } from "../src/worker/check.js";
import { workerLlm, type Llm } from "../src/worker/llm.js";
import { publishCapability } from "../src/hive/publish.js";

const SHARED = "cktest", PRIV = "ckpriv_test", WORKERHIVE = "ckworker_test", KAPHOME = "ckkap_test";
const ANI = "ck_ani", KAP = "ck_kap";
const ALL = [SHARED, PRIV, WORKERHIVE, KAPHOME];

const drop = async () => {
  for (const n of ALL) { await client.db(`hive_${n}`).dropDatabase(); await hives.deleteOne({ _id: n }); }
  await honeycomb.collection("invites").deleteMany({ hive: { $in: ALL } });
};

let failed = 0;
const check = (ok: unknown, what: string) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) failed++; };
async function scenario(name: string, fn: () => Promise<void>) {
  console.log(`\n# ${name}`);
  try { await fn(); } catch (e) { failed++; console.log(`FAIL ${name} threw: ${(e as Error).stack?.split("\n").slice(0, 3).join(" | ")}`); }
}

// the author's tool: a ci run's repo, branch and status
const COLL = "ci_runs";
const PARAMS: CapabilityVersion["params"] = { run_id: "string" };
const AUTHOR_PIPE = [{ $match: { _id: "{{run_id}}" } }, { $project: { _id: 0, repo: 1, branch: 1, status: 1 } }];
const WRONG_PIPE = [{ $match: { _id: "{{run_id}}" } }, { $project: { _id: 0, repo: 1, branch: 1, status: "$branch" } }];
const MIXED_PIPE = [{ $match: { _id: "{{run_id}}" } }, { $project: { _id: 0, repo: 1, branch: 1, status: { $cond: [{ $eq: ["$status", "failed"] }, "broken", "$status"] } } }];
const DIRECTIVE = "Show a CI run's repository, branch and status.";

async function mkTool(h: Hive, id: string, author: string, pipeline: object[] = AUTHOR_PIPE, collection = COLL, params = PARAMS, directive = DIRECTIVE, whenToUse = "you have a ci run id and need its repo, branch and status") {
  const { version } = await commitVersion(
    h, id, { directive, scope: "ci" },
    (v) => ({ v, status: "rejected", collection, params, pipeline, whenToUse, author, harness: "claude-code", hash: hashRecipe(collection, pipeline), createdAt: new Date() }),
    async (ver, head) => decide(await validate(h, id, ver), head, true),
  );
  return version;
}

async function addRuns(h: Hive, id: string, ver: CapabilityVersion, argsList: Record<string, unknown>[], user = KAP) {
  const outs = [];
  for (const [i, args] of argsList.entries()) {
    const doc = { _id: `out_${randomUUID().slice(0, 8)}`, capId: id, v: ver.v, args, result: await execute(db, ver, args), user, harness: "claude-code", at: new Date(Date.now() - i * 1000) };
    await h.outputs.insertOne(doc);
    outs.push(doc);
  }
  return outs;
}

const prompts: string[] = [];
const stub = (pipeline: object[], collection = COLL): Llm & { calls: number } => {
  const s = { model: "stub", calls: 0, async complete(system: string, user: string) { s.calls++; prompts.push(user); return JSON.stringify({ collection, pipeline }); } };
  return s;
};

// queue + claim, the way the worker gets a job
async function claimed(h: Hive, id: string, v: number) {
  await queueCheck(h, id, v, "verify-check");
  const open = await h.workerJobs.findOne({ capId: id, trigger: "check", step: "queued" });
  return (await claim(h, open!._id))!;
}

await drop();
const t0 = Date.now();
try {
  await hives.insertOne({ _id: SHARED, visibility: "shared", owner: ANI, members: [ANI, KAP], createdAt: new Date() } as any);
  await hives.insertOne({ _id: PRIV, visibility: "private", owner: ANI, members: [ANI], createdAt: new Date() } as any);
  await hives.insertOne({ _id: WORKERHIVE, visibility: "shared", owner: ANI, members: [ANI, KAP], createdAt: new Date() } as any);
  const sh = hive(SHARED), pv = hive(PRIV);

  const failedRuns = (await db.collection(COLL).find({ status: "failed" }, { projection: { _id: 1 } }).limit(2).toArray()).map((r) => ({ run_id: r._id }));
  const passedRuns = (await db.collection(COLL).find({ status: "passed" }, { projection: { _id: 1 } }).limit(2).toArray()).map((r) => ({ run_id: r._id }));
  const FOUR = [...failedRuns, ...passedRuns];
  const allResults: Record<string, unknown>[] = [];

  await scenario("1 reference agrees with every run: evals added, v1 promoted", async () => {
    const ver = await mkTool(sh, "ck_agree", ANI);
    check(ver.status === "unverified", `author's v1 lands ${ver.status}`);
    const outs = await addRuns(sh, "ck_agree", ver, [...FOUR, FOUR[0]]); // a repeated input: one eval, both runs checked
    allResults.push(...outs.flatMap((o) => o.result));
    const job = await claimed(sh, "ck_agree", 1);
    const r = await checkTool(sh, job, stub(AUTHOR_PIPE), KAP);
    check(r.ok && r.agree === 5 && r.disagree === 0 && r.promoted, `check result: ${JSON.stringify(r)}`);
    const cases = (await sh.answerKeys.findOne({ _id: "ck_agree" }))?.cases ?? [];
    check(cases.length === 4, `one eval per distinct input: ${cases.length}`);
    check(cases.every((c) => c.source === "worker_agreement" && c.provisional === true && c.addedBy === KAP && c.category === "auto-check" && c.outputId && c.addedAt),
      "every eval is worker_agreement, provisional, added by the checker, category auto-check, with its outputId");
    check(cases.every((c) => outs.some((o) => o._id === c.outputId && isDeepStrictEqual(c.expect, o.result[0]))), "each eval expects the author's stored answer");
    const cap = await sh.capabilities.findOne({ _id: "ck_agree" });
    check(cap?.activeVersion === 1, `tool promoted: activeVersion ${cap?.activeVersion}, ${cap?.versions[0].reason}`);
    const j = await sh.workerJobs.findOne({ _id: job._id });
    check(j?.step === "proposed" && j.verdict?.passed === 5 && j.verdict.total === 5 && j.v === 1 && j.model === "stub", `job ${j?.step}, verdict ${j?.verdict?.passed} of ${j?.verdict?.total}`);
    check(j?.note === "agrees on 5 runs, promoted v1", `job note: ${j?.note}`);
    const marked = await sh.outputs.find({ capId: "ck_agree" }).toArray();
    check(marked.every((o) => o.check?.agree === true && o.check.by === KAP && o.check.jobId === job._id), "every run carries check.agree true by the checker");
    const ev = await sh.events.findOne({ tool: "check", "args.id": "ck_agree" });
    check(ev?.kind === "worker" && ev.verb === "checked" && ev.actor === KAP && ev.result?.agree === 5 && ev.result.promoted === true, "a checked event is recorded");
  });

  await scenario("2 reference disagrees: no evals, no promotion, runs wait for a person", async () => {
    const ver = await mkTool(sh, "ck_wrong", ANI);
    const outs = await addRuns(sh, "ck_wrong", ver, FOUR);
    allResults.push(...outs.flatMap((o) => o.result));
    const job = await claimed(sh, "ck_wrong", 1);
    const r = await checkTool(sh, job, stub(WRONG_PIPE), KAP);
    check(r.ok && r.agree === 0 && r.disagree === 4 && !r.promoted && r.evalsAdded === 0, `check result: ${JSON.stringify(r)}`);
    check(((await sh.answerKeys.findOne({ _id: "ck_wrong" }))?.cases.length ?? 0) === 0, "no eval for disagreeing runs");
    check((await sh.capabilities.findOne({ _id: "ck_wrong" }))?.activeVersion == null, "not promoted");
    check((await sh.outputs.find({ capId: "ck_wrong" }).toArray()).every((o) => o.check?.agree === false), "every run carries check.agree false");
    const j = await sh.workerJobs.findOne({ _id: job._id });
    check(j?.step === "proposed" && /4 need a person to judge/.test(j.note ?? "") && j.verdict?.passed === 0 && j.verdict.total === 4, `job ${j?.step}: ${j?.note}`);
  });

  await scenario("3 mixed: agreeing runs become evals, disagreeing ones block promotion", async () => {
    if (failedRuns.length < 1 || passedRuns.length < 1) { console.log("skip  no failed + passed ci runs to mix"); return; }
    const ver = await mkTool(sh, "ck_mixed", ANI);
    const outs = await addRuns(sh, "ck_mixed", ver, FOUR);
    allResults.push(...outs.flatMap((o) => o.result));
    const job = await claimed(sh, "ck_mixed", 1);
    const r = await checkTool(sh, job, stub(MIXED_PIPE), KAP);
    const want = { agree: passedRuns.length, disagree: failedRuns.length };
    check(r.ok && r.agree === want.agree && r.disagree === want.disagree && !r.promoted, `check result: ${JSON.stringify(r)}`);
    const cases = (await sh.answerKeys.findOne({ _id: "ck_mixed" }))?.cases ?? [];
    check(cases.length === want.agree && cases.every((c) => passedRuns.some((p) => isDeepStrictEqual(p, c.args))), `evals only for agreeing inputs: ${cases.length}`);
    check((await sh.capabilities.findOne({ _id: "ck_mixed" }))?.activeVersion == null, "not promoted while a run needs a person");
    const j = await sh.workerJobs.findOne({ _id: job._id });
    check(j?.note === `agrees on ${want.agree} runs, ${want.disagree} need a person to judge`, `job note: ${j?.note}`);
  });

  await scenario("4 the author's own worker hands the job back", async () => {
    const ver = await mkTool(sh, "ck_own", ANI);
    await addRuns(sh, "ck_own", ver, FOUR.slice(0, 2));
    await queueCheck(sh, "ck_own", 1, "verify-check");
    const job = (await sh.workerJobs.findOne({ capId: "ck_own", trigger: "check" }))!;
    const s = stub(AUTHOR_PIPE);
    const r = await checkTool(sh, job, s, ANI);
    check(!r.ok && r.handBack && r.reason === "can't check your own tool: left for a teammate's worker", `result: ${JSON.stringify(r)}`);
    const j = await sh.workerJobs.findOne({ _id: job._id });
    check(j?.step === "queued" && !j.claimedBy && j.updatedAt.getTime() === job.updatedAt.getTime(), "job untouched and still queued");
    check(s.calls === 0 && (await sh.outputs.countDocuments({ capId: "ck_own", check: { $exists: true } })) === 0, "no model call, no run marked");
    const outsider = await checkTool(sh, job, s, "ck_nobody");
    check(!outsider.ok && outsider.handBack, `a non-member's worker hands it back too: ${!outsider.ok && outsider.reason}`);
  });

  await scenario("5 private hive: record only", async () => {
    const ver = await mkTool(pv, "ck_priv", ANI);
    const outs = await addRuns(pv, "ck_priv", ver, FOUR.slice(0, 3), ANI);
    allResults.push(...outs.flatMap((o) => o.result));
    await queueCheck(pv, "ck_priv", 1, "verify-check");
    const queued = (await pv.workerJobs.findOne({ capId: "ck_priv" }))!;
    const kapTry = await checkTool(pv, queued, stub(AUTHOR_PIPE), KAP);
    check(!kapTry.ok && kapTry.handBack, "a non-owner's worker never checks a private hive");
    const job = (await claim(pv, queued._id))!;
    const r = await checkTool(pv, job, stub(AUTHOR_PIPE), ANI);
    check(r.ok && r.recordOnly && r.agree === 3 && !r.promoted && r.evalsAdded === 0, `check result: ${JSON.stringify(r)}`);
    check(!(await pv.answerKeys.findOne({ _id: "ck_priv" })), "zero eval cases added");
    check((await pv.capabilities.findOne({ _id: "ck_priv" }))?.activeVersion == null, "no promotion");
    check((await pv.outputs.find({ capId: "ck_priv" }).toArray()).every((o) => o.check?.agree === true && o.check.by === ANI), "outputs.check set");
    const j = await pv.workerJobs.findOne({ _id: job._id });
    check(j?.note === "agrees on 3 of 3 runs (your private hive: record only)", `job note: ${j?.note}`);
  });

  await scenario("6 the reference prompt never sees the implementation or stored answers", async () => {
    check(prompts.length >= 4, `captured ${prompts.length} stub prompts`);
    const pipeJson = [AUTHOR_PIPE, WRONG_PIPE, MIXED_PIPE].map((p) => JSON.stringify(p));
    const values = [...new Set(allResults.flatMap((r) => Object.values(r)).filter((v) => typeof v === "string"))] as string[];
    for (const p of prompts) {
      check(!pipeJson.some((j) => p.includes(j)) && !p.includes("$project") && !p.includes("{{run_id}}"), "prompt holds no pipeline");
      check(!allResults.some((r) => p.includes(JSON.stringify(r))), "prompt holds no stored result doc");
      // work data may coincide with answers; everything outside the work-data sample must hold none of them
      const own = p.split("\n").filter((l) => !l.startsWith("work-data sample")).join("\n");
      check(!values.some((v) => own.includes(v)), "no stored result value outside the work-data sample");
      check(p.includes("output document fields: repo (string), branch (string), status (string)") && p.includes(`directive: ${DIRECTIVE}`), "prompt names the fields and directive");
    }
  });

  await scenario("7 queueCheck keeps one open job per tool", async () => {
    await mkTool(sh, "ck_dedupe", ANI);
    const a = await queueCheck(sh, "ck_dedupe", 1, "first");
    const b = await queueCheck(sh, "ck_dedupe", 1, "second");
    check(a && !b, `first queued ${a}, second queued ${b}`);
    check((await sh.workerJobs.countDocuments({ capId: "ck_dedupe", trigger: "check", step: { $in: OPEN_STEPS } })) === 1, "one open check job");
    const j = await sh.workerJobs.findOne({ capId: "ck_dedupe" });
    check(j?.v === 1 && j.hive === SHARED && j.step === "queued" && j.note === "first", "the job carries v, hive and the first note");
    await sh.workerJobs.updateOne({ _id: j!._id }, { $set: { step: "skipped" } });
    check(await queueCheck(sh, "ck_dedupe", 1, "third"), "a closed job lets the next check queue");
  });

  await scenario("8 no runs yet: skipped with the reason", async () => {
    await mkTool(sh, "ck_empty", ANI);
    const job = await claimed(sh, "ck_empty", 1);
    const s = stub(AUTHOR_PIPE);
    const r = await checkTool(sh, job, s, KAP);
    const j = await sh.workerJobs.findOne({ _id: job._id });
    check(!r.ok && !r.handBack && j?.step === "skipped" && j.note === "no runs to check yet" && s.calls === 0, `job ${j?.step}: ${j?.note}`);
  });

  await scenario("9 real worker model on a correct tool (team's triage recipe as ck_triage)", async () => {
    const team = hive("team"); // read only: the recipe, never its evals
    const src = (await team.capabilities.findOne({ _id: "triage_ci_failure" }))!;
    const v1 = src.versions.find((v) => v.v === 1)!;
    const ver = await mkTool(sh, "ck_triage", ANI, v1.pipeline, v1.collection, v1.params, src.directive, v1.whenToUse);
    const args: Record<string, unknown>[] = [];
    for (const r of await db.collection("ci_runs").find({ status: "failed" }, { projection: { _id: 1 } }).toArray()) {
      if ((await execute(db, ver, { run_id: r._id })).length === 1) args.push({ run_id: r._id });
      if (args.length === 3) break;
    }
    check(args.length === 3, `3 failed runs the recipe answers: ${JSON.stringify(args)}`);
    const outs = await addRuns(sh, "ck_triage", ver, args);
    const real = await workerLlm();
    const seen: string[] = [];
    const spy: Llm = { model: real.model, complete: (s, u) => { seen.push(u); return real.complete(s, u); } };
    const job = await claimed(sh, "ck_triage", 1);
    const r = await checkTool(sh, job, spy, KAP);
    const j = await sh.workerJobs.findOne({ _id: job._id });
    console.log(`     ${real.model}: ${j?.step} · ${j?.note}`);
    check(j?.step === "proposed" || (j?.step === "skipped" && !!j.note), `job finishes proposed or skipped with a reason (${j?.step})`);
    check(seen.length === 1 && !seen[0].includes(JSON.stringify(v1.pipeline)) && !seen[0].includes("OOMKilled|out of memory") && !seen[0].includes("$sortArray"), "real prompt holds no implementation");
    check(!outs.some((o) => seen[0].includes(JSON.stringify(o.result[0]))), "real prompt holds no stored answer");
    const cases = (await sh.answerKeys.findOne({ _id: "ck_triage" }))?.cases ?? [];
    check(cases.every((c) => c.source === "worker_agreement" && c.provisional === true && c.addedBy === KAP), `every added eval is worker_agreement, provisional, by the checker (${cases.length})`);
    const cap = await sh.capabilities.findOne({ _id: "ck_triage" });
    if (r.ok) check((cap?.activeVersion === 1) === (r.disagree === 0 && r.agree >= 1), `promoted (${cap?.activeVersion === 1}) iff zero disagreements and at least one agreement (${r.agree} agree, ${r.disagree} disagree)`);
    else check(cap?.activeVersion == null && cases.length === 0, "skipped check changed nothing");
  });

  await scenario("10 agent-facing replies: publish and runs queue checks, evals never leak", async () => {
    // ani's private tool, published into the shared hive: lands untested and queues a check
    await mkTool(pv, "ck_mcp", ANI);
    const pub = await publishCapability({ home: pv, target: sh, id: "ck_mcp", user: ANI, harness: "script" });
    check(pub.ok && pub.version === 1 && !pub.published, `publish lands untested: ${pub.ok && pub.reason}`);
    const first = await sh.workerJobs.findOne({ capId: "ck_mcp", trigger: "check", step: "queued" });
    check(first?.v === 1, "publish queued a check of v1");
    const j0 = (await claim(sh, first!._id))!;
    const r0 = await checkTool(sh, j0, stub(AUTHOR_PIPE), KAP);
    check(!r0.ok && r0.reason === "no runs to check yet", "that check skips: no runs yet");

    const mcp = new Client({ name: "verify-check-kap", version: "0" });
    await mcp.connect(new StdioClientTransport({
      command: "npx", args: ["tsx", "--env-file=.env", "src/mcp/server.ts"],
      env: { ...(process.env as Record<string, string>), HIVE_USER: KAP, HIVE_HARNESS: "claude-code", HIVE_HOME: KAPHOME, HIVE_RUN_ID: "verify-check-kap" },
    }));
    const texts: string[] = [];
    const call = async (name: string, a: Record<string, unknown>) => {
      const t = ((await mcp.callTool({ name, arguments: a })).content as any)[0].text as string;
      texts.push(t);
      return { t, j: JSON.parse(t) };
    };
    try {
      // three runs on different branches, so each eval's answer is distinct
      const byBranch = new Map<string, Record<string, unknown>>();
      for (const r of await db.collection(COLL).find({}, { projection: { _id: 1, branch: 1 } }).toArray()) if (!byBranch.has(r.branch)) byBranch.set(r.branch, { run_id: r._id });
      const [A, B, C] = [...byBranch.values()];
      const trial = await call("run_capability", { id: "ck_mcp", hive: SHARED, args: A });
      check(trial.j.status === "unverified" && trial.j.result?.length === 1, `kap's trial run: ${trial.j.ran}`);
      let queued = null;
      for (let i = 0; i < 40 && !queued; i++) { queued = await sh.workerJobs.findOne({ capId: "ck_mcp", trigger: "check", step: "queued" }); if (!queued) await new Promise((r) => setTimeout(r, 250)); }
      check(queued?.v === 1, "the run queued a check without blocking the reply");
      await call("run_capability", { id: "ck_mcp", hive: SHARED, args: B });
      await call("run_capability", { id: "ck_mcp", hive: SHARED, args: C });
      check((await sh.workerJobs.countDocuments({ capId: "ck_mcp", trigger: "check", step: { $in: OPEN_STEPS } })) === 1, "three runs, still one open check");
      check(texts.every((t) => !/worker_agreement|auto-check|provisional|answer_keys|"check"|"agree"/.test(t)), "trial replies say nothing about the check");

      const job = (await claim(sh, queued!._id))!;
      const r = await checkTool(sh, job, stub(AUTHOR_PIPE), "ck_third");
      check(!r.ok && r.handBack, "a non-member can't check it"); // ck_third isn't in the hive
      const r2 = await checkTool(sh, job, stub(AUTHOR_PIPE), KAP);
      check(r2.ok && r2.promoted && r2.evalsAdded === 3, `kap's worker checks it: ${r2.ok && r2.note}`);
      const cases = (await sh.answerKeys.findOne({ _id: "ck_mcp" }))!.cases;

      // after promotion: every agent-facing reply for input A must not carry B's or C's expected answer, nor eval metadata
      const others = cases.filter((c) => !isDeepStrictEqual(c.args, A)).map((c) => c.expect);
      const walk = (n: unknown): boolean => (Array.isArray(n) ? n.some(walk) : n && typeof n === "object" ? others.some((e) => isDeepStrictEqual(n, e)) || Object.values(n).some(walk) : false);
      texts.length = 0;
      const run = await call("run_capability", { id: "ck_mcp", hive: SHARED, args: A });
      check(/promoted v1/.test(run.j.ran ?? ""), `run_capability now runs ${run.j.ran}`);
      const find = await call("find_capability", { task: "repository branch status of a ci run" });
      let named = false;
      for (let i = 0; i < 80 && !named; i++) { named = (await mcp.listTools()).tools.some((t) => t.name === "ck_mcp"); if (!named) await new Promise((r) => setTimeout(r, 250)); }
      check(named, "ck_mcp became a named tool for kap");
      if (named) await call("ck_mcp", A);
      for (const t of texts) {
        check(!walk(JSON.parse(t)), "reply carries no other input's eval answer");
        check(!/worker_agreement|auto-check|provisional|answer_keys|"expect"|"check"/.test(t), "reply carries no eval metadata");
      }
      check(!JSON.stringify(find.j).includes(JSON.stringify(A)), "find_capability carries no eval input");
    } finally {
      await mcp.close();
    }
  });

  await scenario("11 the worker process sweeps an untested tool and checks it", async () => {
    const wh = hive(WORKERHIVE);
    const ver = await mkTool(wh, "ck_sweep", ANI);
    await addRuns(wh, "ck_sweep", ver, FOUR.slice(1, 4));
    check(!(await wh.workerJobs.findOne({})), "no job queued before the worker starts");
    const proc = spawn("npx", ["tsx", "--env-file=.env", "scripts/worker.ts", "--hives", WORKERHIVE], {
      env: { ...(process.env as Record<string, string>), HIVE_USER: KAP }, stdio: ["ignore", "pipe", "pipe"],
    });
    let log = "";
    proc.stdout.on("data", (d) => { log += d; });
    proc.stderr.on("data", (d) => { log += d; });
    let done: WorkerJob | null = null;
    for (let i = 0; i < 480 && !done; i++) {
      done = await wh.workerJobs.findOne({ capId: "ck_sweep", trigger: "check", step: { $in: ["proposed", "skipped", "rejected"] } });
      if (!done) await new Promise((r) => setTimeout(r, 500));
    }
    proc.kill("SIGTERM");
    await new Promise((r) => proc.once("exit", r));
    console.log(log.trim().split("\n").map((l) => `     ${l}`).join("\n"));
    check(done?.step === "proposed" || done?.step === "skipped", `sweep-queued check closed: ${done?.step} · ${done?.note}`);
    check(/queued a check of v1 \(3 unchecked runs\)/.test(log) && (done?.step !== "proposed" || /checking v1 on 3 runs/.test(log)), "worker log narrates the sweep and the check");
    if (done?.step === "proposed") {
      const n = await wh.outputs.countDocuments({ capId: "ck_sweep", check: { $exists: true } });
      check(n === 3, `every run checked (${n})`);
    }
  });
} catch (e) {
  failed++;
  console.error("FAIL", e);
} finally {
  await drop();
  await client.close();
}
console.log(`\n${failed ? `${failed} check(s) failed` : "auto-check verified"} in ${Math.round((Date.now() - t0) / 1000)}s`);
process.exit(failed ? 1 : 0);
