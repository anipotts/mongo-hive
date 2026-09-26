// the always-on worker: watches worker_jobs in every hive, claims queued jobs one at a time, improves the tool
// and narrates each step. a change stream per hive wakes it instantly; a sweep every 30s catches anything missed.
// usage: npm run worker [-- --rounds 2] [--hives live,team]
import { HIVE_USER, client, hive, hives, type Hive } from "../src/registry/db.js";
import type { WorkerJob } from "../src/registry/types.js";
import { WORKER_ID, claim, judgeableEvals } from "../src/worker/index.js";
import { frac, improveTool, ownerOf } from "../src/worker/improve.js";
import { workerLlm } from "../src/worker/llm.js";
import { draftNewTool } from "../src/worker/newtool.js";

const arg = (k: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
const rounds = Number(arg("--rounds") ?? process.env.WORKER_ROUNDS ?? 2);
// optional allow-list, e.g. --hives live,team; default is every hive in the honeycomb
const only = arg("--hives")?.split(",").map((s) => s.trim()).filter(Boolean);
// only hives this person owns or belongs to: never a hive they aren't in, never someone else's private hive
const inScope = () => hives.find({ ...(only ? { _id: { $in: only } } : {}), $or: [{ owner: HIVE_USER }, { members: HIVE_USER }] }).toArray();
const clock = () => new Date().toTimeString().slice(0, 5);
const say = (line: string) => console.log(`${clock()} worker · ${line}`);

const llm = await workerLlm();
const watched = new Map<string, { close(): Promise<void> }>();
let busy = false;
const passed = new Set<string>(); // jobs this worker can't be judged on; a teammate's worker takes them
let stopping = false;
let again = false;

// one job at a time across all hives: the model call is the bottleneck, and the narration stays readable
async function drain() {
  if (busy) { again = true; return; }
  busy = true;
  try {
    do {
      again = false;
      for (const info of await inScope()) {
        if (stopping) return;
        const h = hive(info._id);
        let job: WorkerJob | null;
        while (!stopping && (job = await claim(h, undefined, [...passed]))) await work(h, job);
      }
    } while (again && !stopping);
  } finally {
    busy = false;
  }
}

async function work(h: Hive, job: WorkerJob) {
  // a session's investigation with no tool yet: draft a brand-new one into this hive
  if (!job.capId && (job.trigger === "repetition" || job.trigger === "session_end")) {
    say(`${h.name} · drafting a new tool from run ${job.sessionId}'s investigation`);
    try {
      const r = await draftNewTool(h, job, llm);
      await h.workerJobs.updateOne({ _id: job._id }, { $set: r.ok
        ? { step: "proposed", capId: r.id, v: r.v, verdict: { passed: 0, total: 0 }, model: llm.model, note: `saved as untested draft v${r.v}: no evals yet`, updatedAt: new Date() }
        : { step: "skipped", model: llm.model, note: r.reason, updatedAt: new Date() } });
      say(r.ok ? `${h.name} · drafted new tool ${r.id} v${r.v} (unverified; ${r.rows} row(s) on ${JSON.stringify(r.example)})` : `${h.name} · no new tool: ${r.reason}`);
    } catch (e) {
      const note = (e as Error).message.split("\n")[0].slice(0, 200);
      await h.workerJobs.updateOne({ _id: job._id }, { $set: { step: "rejected", note: `worker error: ${note}`, updatedAt: new Date() } });
      say(`${h.name} · new-tool draft error: ${note}`);
    }
    return;
  }
  const cap = job.capId ? await h.capabilities.findOne({ _id: job.capId }) : null;
  if (!cap) {
    await h.workerJobs.updateOne({ _id: job._id }, { $set: { step: "skipped", note: `no tool ${job.capId ?? "(none)"} in hive ${h.name}`, updatedAt: new Date() } });
    say(`skipped ${job._id}: no tool ${job.capId ?? "(none)"} in hive ${h.name}`);
    return;
  }
  const who = `${ownerOf(cap)}'s ${cap._id}`;
  // every eval so far is this person's own feedback, so this worker's drafts can't be scored: hand it back
  if (job.trigger === "improve" && (await judgeableEvals(h, cap._id)) === 0) {
    await h.workerJobs.updateOne({ _id: job._id, claimedBy: WORKER_ID }, { $set: { step: "queued", updatedAt: new Date() }, $unset: { claimedBy: "" } });
    passed.add(job._id);
    say(`${h.name} · ${who} · left for a teammate's worker: every eval is ${HIVE_USER}'s own feedback`);
    return;
  }
  try {
    const res = await improveTool(h, cap._id, {
      rounds, llm, firstJob: job,
      on: (e) => {
        if (!e.result && !e.skipped)
          say(`${h.name} · ${who} · improving v${e.base.v} → v${e.nextV} · testing on ${e.evals} evals`);
        else if (e.skipped)
          say(`${h.name} · ${who} · skipped v${e.nextV}: ${e.skipped}`);
        else if (e.result!.promoted)
          say(`${h.name} · ${who} · promoted v${e.result!.v} · ${frac(e.result!.score)} beat ${frac(e.result!.headScore)}`);
        else
          say(`${h.name} · ${who} · rejected v${e.result!.v} · ${frac(e.result!.score)} does not beat ${frac(e.result!.headScore)}`);
      },
    });
    if ("reason" in res && res.reason) {
      await h.workerJobs.updateOne({ _id: job._id }, { $set: { step: "skipped", note: res.reason, updatedAt: new Date() } });
      say(`${h.name} · ${who} · skipped: ${res.reason}`);
    }
  } catch (e) {
    const note = (e as Error).message.split("\n")[0].slice(0, 200);
    await h.workerJobs.updateOne({ _id: job._id, step: { $in: ["drafting", "validating"] } }, { $set: { step: "rejected", note: `worker error: ${note}`, updatedAt: new Date() } });
    say(`${h.name} · ${who} · error, job closed: ${note}`);
  }
}

// a change stream on each hive's worker_jobs; new hives are picked up by the sweep
async function watchHives() {
  for (const info of await inScope()) {
    if (watched.has(info._id)) continue;
    const stream = hive(info._id).workerJobs.watch([{ $match: { operationType: "insert", "fullDocument.step": "queued" } }]);
    stream.on("change", () => void drain());
    stream.on("error", () => { watched.delete(info._id); });
    watched.set(info._id, stream);
  }
}

async function stop() {
  if (stopping) return;
  stopping = true;
  say("stopping");
  clearInterval(timer);
  for (const s of watched.values()) await s.close().catch(() => {});
  while (busy) await new Promise((r) => setTimeout(r, 200));
  await client.close();
  process.exit(0);
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

await watchHives();
say(`${WORKER_ID} on ${llm.model} · watching ${watched.size} hives · ${rounds} round${rounds === 1 ? "" : "s"} per job`);
const timer = setInterval(() => { void watchHives().then(drain); }, 30_000);
await drain();
