// MongoHive tool server. same tools for claude code, codex, or any mcp client.
// honeycomb = the cluster; each hive is its own database. you propose into your private hive,
// then publish into shared hives, where the hive's own hidden cases decide what goes live.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { AGENT_ID, HIVE_HARNESS, HIVE_HOME, HIVE_USER, canAccess, db, ensureHive, hive, hives, myHives, type Hive } from "../registry/db.js";
import type { Capability, CapabilityVersion } from "../registry/types.js";
import { assertAllowedCollection, assertReadOnly, execute, fromEjson, hashRecipe } from "../learner/index.js";
import { board, commitVersion, decide, improveHint, scoreOn, standing, validate } from "../validator/index.js";
import { publishCapability } from "../hive/publish.js";
import { nativeTools } from "./native.js";
import { enqueue, queueCheck } from "../worker/index.js";

const runId = process.env.HIVE_RUN_ID ?? `run_${randomUUID().slice(0, 8)}`;
// a session bound to a project (HIVE_SCOPE) uses exactly one existing hive and never creates one. if the bound hive
// is gone or you left it, fall back to your newest shared hive instead of failing, and say so on stderr.
let homeName = HIVE_HOME;
if (process.env.HIVE_SCOPE) {
  if (!canAccess(await hives.findOne({ _id: HIVE_HOME }), HIVE_USER)) {
    const alt = await hives.find({ visibility: "shared", $or: [{ owner: HIVE_USER }, { members: HIVE_USER }] }).sort({ createdAt: -1 }).limit(1).next();
    if (alt) {
      console.error(`mongo-hive: this project is bound to ${HIVE_HOME}, which you can't use; using your newest shared hive ${alt._id}. run \`npm run -s mongo-hive -- connect <invite>\` to rebind`);
      homeName = alt._id;
      process.env.HIVE_SCOPE = alt._id;
    } else {
      console.error(`mongo-hive: you're not in any shared hive yet; run \`npm run -s mongo-hive -- connect <invite>\``);
      process.exit(1);
    }
  }
} else await ensureHive(HIVE_HOME, "private", HIVE_USER);
const home = hive(homeName);

// only real agent harnesses belong on a hive's roster; scripts, tests and the console act without joining it
const ON_ROSTER = !["script", "console", "unknown", ""].includes(HIVE_HARNESS);

async function touchAgent(h: Hive) {
  if (!ON_ROSTER) return;
  await h.agents.updateOne(
    { _id: AGENT_ID },
    { $set: { user: HIVE_USER, harness: HIVE_HARNESS, lastSeen: new Date() }, $setOnInsert: { pulled: {}, pinned: {} } },
    { upsert: true },
  );
}
await home.runs.updateOne({ _id: runId as any }, { $setOnInsert: { user: HIVE_USER, harness: HIVE_HARNESS, startedAt: new Date() } }, { upsert: true });
await touchAgent(home);

// live notices: a change stream per hive tells this agent the moment a teammate's tool takes the lead there.
// the stream position is saved per agent, so an agent that was offline gets every head move it missed.
const notices: string[] = [];
const seenDrafts = new Set<string>();
let onHeadMove = () => {}; // set once native tools are registered
const watchPipeline = [{ $match: { operationType: { $in: ["insert", "update", "replace"] } } }];

function onChange(h: Hive, c: any) {
  const moved = c.operationType !== "update" || "activeVersion" in (c.updateDescription?.updatedFields ?? {});
  const cap = c.fullDocument as Capability | undefined;
  // the worker's first version of a brand-new tool in your own hive: tell the agent it can use it now
  const fresh = cap?.versions.length === 1 && cap.versions[0].harness === "worker" && cap.versions[0].status === "unverified";
  if (fresh && h.name === home.name && !seenDrafts.has(cap!._id)) {
    seenDrafts.add(cap!._id);
    onHeadMove();
    notices.push(`your worker drafted a new tool from this session: ${cap!._id}(${Object.keys(cap!.versions[0].params).join(", ")}): ${cap!.directive} (unverified: yours to try; publish it to share)`);
  }
  if (moved) onHeadMove(); // promotions and demotions both change which native tools exist
  if (!moved || !cap?.activeVersion) return;
  const head = cap.versions.find((v) => v.v === cap.activeVersion);
  if (head && head.author !== HIVE_USER)
    notices.push(`hive ${h.name}: ${head.harness === "worker" ? `${head.author}'s worker` : `${head.author} (${head.harness})`} took the lead on ${cap._id} with v${head.v} (${head.score?.passed}/${head.score?.total})`);
}

async function follow(h: Hive) {
  await touchAgent(h);
  const me = await h.agents.findOne({ _id: AGENT_ID });
  const open = (token?: unknown) =>
    h.capabilities.watch(watchPipeline, { fullDocument: "updateLookup", maxAwaitTimeMS: 1000, ...(token ? { resumeAfter: token as any } : {}) });
  let stream = open(me?.resumeToken);
  let saved = JSON.stringify(me?.resumeToken ?? null);
  const save = async () => {
    const t = stream.resumeToken;
    if (t && JSON.stringify(t) !== saved) {
      saved = JSON.stringify(t);
      await h.agents.updateOne({ _id: AGENT_ID }, { $set: { resumeToken: t } }).catch(() => {});
    }
  };
  const next = async () => {
    try {
      return await stream.tryNext();
    } catch {
      // token too old or invalid: start fresh rather than fail the agent
      await stream.close().catch(() => {});
      stream = open();
      return null;
    }
  };
  // drain whatever this agent missed while offline before serving any tool call
  for (let c = await next(); c; c = await next()) onChange(h, c);
  await save();
  (async () => {
    for (;;) {
      const c = await next();
      if (c) onChange(h, c);
      await save();
    }
  })().catch(() => {});
}
for (const info of await myHives()) await follow(hive(info._id));

async function record(h: Hive, tool: string, args: unknown, result: unknown, ms: number) {
  const r = await h.events.insertOne({ runId, user: HIVE_USER, harness: HIVE_HARNESS, hive: h.name, tool, args, result, ms, at: new Date() });
  return r.insertedId;
}

const reply = (payload: unknown) => {
  const body = notices.length ? { notices: notices.splice(0), ...(payload as object) } : payload;
  return { content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }] };
};

// server-side enforcement: you only ever touch hives you own or belong to
async function openHive(name: string): Promise<Hive> {
  const info = await hives.findOne({ _id: name.replace(/^hive_/, "") });
  if (!canAccess(info, HIVE_USER)) throw new Error(`you (${HIVE_USER}) are not a member of hive ${name}`);
  return hive(info!._id);
}

// the version this user would run: pin, else team head, else (own private hive only) latest unverified
function runnable(cap: Capability, h: Hive, pinned?: number): CapabilityVersion | undefined {
  const want = pinned ?? cap.activeVersion;
  if (want != null) return cap.versions.find((x) => x.v === want && x.status !== "rejected" && x.status !== "archived");
  // no tested head yet: the latest unverified version is runnable on trial (private drafts, or a shared hive
  // collecting its first evals through feedback)
  return [...cap.versions].reverse().find((x) => x.status === "unverified");
}

// one run path for run_capability and every native tool: resolves pin ?? promoted version at call time,
// records the event and the full output (so a person can judge it later), and never exposes evals.
async function runTool(h: Hive, cap: Capability, args: Record<string, unknown>, version: number | undefined, via: string) {
  const t0 = Date.now();
  const id = cap._id;
  const me = await h.agents.findOne({ _id: AGENT_ID });
  const ver = version != null ? cap.versions.find((x) => x.v === version && x.status !== "rejected") : runnable(cap, h, me?.pinned?.[id]);
  if (!ver) return { error: `no runnable version of ${id} in hive ${h.name}` };
  const prev = me?.pulled?.[id] ?? null;
  const out = await execute(db, ver, args);
  await touchAgent(h);
  await h.agents.updateOne({ _id: AGENT_ID }, { $set: { [`pulled.${id}`]: ver.v } });
  const eventId = await record(h, via, { id, v: ver.v, args }, { count: out.length }, Date.now() - t0);
  // kept so a person can judge it later (/mongo-hive:accept or reject, or the console); agents can't grade
  const outputId = `out_${randomUUID().slice(0, 8)}`;
  await h.outputs.insertOne({ _id: outputId, eventId, capId: id, v: ver.v, args, result: out, user: HIVE_USER, harness: HIVE_HARNESS, at: new Date() });
  // an untested version's run in a shared hive: queue a teammate's worker to check it. fire and forget, never
  // blocks or fails the agent's call, and nothing about the check comes back in this reply.
  if (ver.status === "unverified")
    void hives.findOne({ _id: h.name })
      .then((info) => (info?.visibility === "shared" ? queueCheck(h, id, ver.v, `new run of untested v${ver.v}`) : false))
      .catch(() => {});
  return {
    id, hive: h.name, version: ver.v, status: ver.status, outputId, console: toolUrl(h.name, id),
    feedback: `only the person can judge this answer: /mongo-hive:accept ${outputId} or /mongo-hive:reject ${outputId} <right answer>`,
    // live status lives in the result, never in the (cached) tool definition
    ran: `ran ${ver.v === cap.activeVersion ? "promoted" : ver.status === "unverified" ? "unverified" : version == null && me?.pinned?.[id] === ver.v ? "pinned" : "requested"} v${ver.v} · ${ver.score?.total ? `${ver.score.passed}/${ver.score.total} evals` : "no evals yet"}`,
    updated: prev !== null && prev !== ver.v
      ? `updated since you last ran it: v${prev} → v${ver.v} by ${ver.harness === "worker" ? `${ver.author}'s worker` : `${ver.author} (${ver.harness})`}`
      : undefined,
    improve: await improveHint(h, cap),
    result: out,
  };
}

// a clickable page in the hive console for the moments worth a look (terminals auto-link plain urls)
const CONSOLE = (process.env.HIVE_CONSOLE_URL ?? "http://localhost:3000").replace(/\/+$/, "");
const toolUrl = (hiveName: string, id: string) => `${CONSOLE}/hive/${encodeURIComponent(hiveName)}/tool/${encodeURIComponent(id)}`;

const STOP = new Set(["which", "what", "that", "this", "with", "from", "have", "does", "should", "about", "their", "there", "into", "each", "them", "they", "will", "when", "were"]);

const server = new McpServer({ name: "mongo-hive", version: "0.3.0" });

// the work-data collections, listed in explore's description so agents use real names instead of guessing
const WORK = (await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name)
  .filter((n) => { try { assertAllowedCollection(n); return !n.startsWith("system.") && n !== "ping"; } catch { return false; } }).sort();

server.tool(
  "explore",
  `Run a read-only aggregation on a work-data collection to investigate. Every call is recorded in your hive's trace. Collections: ${WORK.join(", ")}.`,
  { collection: z.string(), pipeline: z.array(z.record(z.string(), z.any())) },
  async ({ collection, pipeline }) => {
    const t0 = Date.now();
    if (!WORK.includes(collection)) return reply({ error: `no work-data collection ${collection}; use one of: ${WORK.join(", ")}` });
    assertAllowedCollection(collection);
    assertReadOnly(pipeline);
    const out = await db.collection(collection).aggregate(fromEjson(pipeline), { maxTimeMS: 10_000 }).limit(50).toArray();
    await record(home, "explore", { collection, pipeline }, { count: out.length }, Date.now() - t0);
    return reply(out);
  },
);

server.tool(
  "distill_investigation",
  "Call this once you have FINISHED an investigation with explore that answered a question you or a teammate will likely ask again (with different ids or names). Your worker turns this session's explore queries into a reusable tool in your private hive; it appears as a named tool when ready (untested until a teammate's evals or feedback judge it). Say what the question was and what answered it.",
  { task: z.string().describe("the question the investigation answered, in general terms"), outcome: z.string().describe("what answered it (which data, which rule)") },
  async ({ task, outcome }) => {
    const n = await home.events.countDocuments({ runId, tool: "explore" } as any);
    if (n < 2) return reply({ error: `only ${n} explore call(s) in this session; distill an investigation after you've done one` });
    // one tool per session's investigation; a second call is a no-op, not a second draft
    const open = await home.workerJobs.findOne({ sessionId: runId, trigger: "session_end" });
    if (open) return reply({ queued: false, job: open._id, step: open.step, note: "already distilled this session's investigation" });
    const job = await enqueue(home, { trigger: "session_end", sessionId: runId, note: `task: ${task.slice(0, 300)} | outcome: ${outcome.slice(0, 300)}` });
    await record(home, "distill_investigation", { task, explores: n }, { job: job._id }, 0);
    return reply({ queued: true, job: job._id, hive: home.name, note: `your worker will draft a tool from ${n} explore calls; you'll get a notice and a new named tool when it's ready`, console: `${CONSOLE}/hive/${encodeURIComponent(home.name)}` });
  },
);

server.tool(
  "find_capability",
  "ALWAYS call this first. Searches your private hive and every shared hive you belong to for learned, tested tools that may already solve the task. Each tool comes with its leaderboard (versions ranked by the hive's hidden cases) and your standing: on_best, better_available, yours_beats_team (publish it), or pinned.",
  { task: z.string(), scope: z.string().optional() },
  async ({ task, scope }) => {
    const t0 = Date.now();
    // scope is a soft hint: agents describe scopes loosely, so rank instead of filtering them out
    const words = `${task} ${scope ?? ""}`.toLowerCase().split(/\W+/).filter((w) => w.length > 3 && !STOP.has(w));
    const found: any[] = [];
    for (const info of await myHives()) {
      const h = hive(info._id);
      const me = await h.agents.findOne({ _id: AGENT_ID });
      for (const c of await h.capabilities.find().toArray()) {
        const pinned = me?.pinned?.[c._id] ?? null;
        const ver = runnable(c, h, pinned ?? undefined);
        if (!ver) continue;
        const text = `${c._id} ${c.directive} ${c.scope} ${ver.whenToUse}`.toLowerCase().replace(/_/g, " ");
        const s = words.filter((w) => text.includes(w)).length;
        if (!s) continue;
        // does my private hive hold a version that beats this shared hive's leader on its own hidden cases?
        let privateBest: { v: number; score: NonNullable<CapabilityVersion["score"]> } | undefined;
        if (info.visibility === "shared" && h.name !== home.name) {
          const mine = await home.capabilities.findOne({ _id: c._id });
          for (const pv of mine?.versions.filter((x) => x.status !== "rejected") ?? []) {
            if (c.versions.some((x) => x.hash === pv.hash)) continue;
            const sc = await scoreOn(h, c._id, pv, true); // only versions already scored there (on publish or status)
            if (sc && (!privateBest || sc.passed / sc.total > privateBest.score.passed / privateBest.score.total)) privateBest = { v: pv.v, score: sc };
          }
        }
        found.push({
          s, id: c._id, hive: h.name, visibility: info.visibility, directive: c.directive, version: ver.v, status: ver.status,
          params: ver.params, whenToUse: ver.whenToUse, author: ver.author,
          you: standing(c, me?.pulled?.[c._id] ?? null, pinned, privateBest) ?? { state: ver.status },
          leaderboard: board(c),
          improve: await improveHint(h, c),
        });
      }
    }
    found.sort((a, b) => b.s - a.s || (a.visibility === "shared" ? -1 : 1));
    const out = found.slice(0, 6).map(({ s, ...rest }) => rest);
    await record(home, "find_capability", { task, scope }, { hits: out.map((o) => `${o.hive}/${o.id}`) }, Date.now() - t0);
    return reply({ capabilities: out, hint: out.length ? "call run_capability with the matching id and hive" : "none yet: explore, then propose_capability" });
  },
);

server.tool(
  "run_capability",
  "Run a hive tool. Tested versions already passed their hive's hidden cases, so trust the result and answer from it; do not re-derive it with explore. Pass the hive from find_capability; version defaults to your pin, else the hive's head.",
  { id: z.string(), args: z.record(z.string(), z.any()), hive: z.string().optional(), version: z.number().optional() },
  async ({ id, args, hive: hiveName, version }) => {
    let h: Hive | undefined;
    let cap: Capability | null = null;
    if (hiveName) {
      h = await openHive(hiveName);
      cap = await h.capabilities.findOne({ _id: id });
    } else {
      for (const info of await myHives()) {
        const cand = hive(info._id);
        const c = await cand.capabilities.findOne({ _id: id });
        if (c && runnable(c, cand)) { h = cand; cap = c; break; }
      }
    }
    if (!h || !cap) return reply({ error: `no capability ${id} in your hives` });
    return reply(await runTool(h, cap, args, version, "run_capability"));
  },
);

server.tool(
  "propose_capability",
  "After solving a task with explore, save the procedure as a reusable, parameterized, read-only tool in YOUR PRIVATE hive. Use {{param}} placeholders for every value that came from the data. If your hive has hidden cases for this id it must pass them; otherwise it stays unverified until you publish it to a shared hive.",
  {
    id: z.string().regex(/^[a-z][a-z0-9_]*$/),
    directive: z.string(),
    scope: z.string(),
    collection: z.string(),
    params: z.record(z.string(), z.enum(["string", "number"])),
    pipeline: z.array(z.record(z.string(), z.any())),
    whenToUse: z.string(),
  },
  async ({ id, directive, scope, collection, params, pipeline, whenToUse }) => {
    const t0 = Date.now();
    assertAllowedCollection(collection);
    assertReadOnly(pipeline);
    const { version, decision, summary } = await commitVersion(
      home, id, { directive, scope },
      (v) => ({ v, status: "rejected", collection, params, pipeline, whenToUse, author: HIVE_USER, harness: HIVE_HARNESS, sourceRunId: runId, hash: hashRecipe(collection, pipeline), createdAt: new Date() }),
      async (ver, head) => decide(await validate(home, id, ver), head, true),
    );
    if (decision.status !== "rejected") await home.agents.updateOne({ _id: AGENT_ID }, { $set: { [`pulled.${id}`]: version.v } });
    await record(home, "propose_capability", { id, v: version.v }, { status: decision.status, score: decision.score }, Date.now() - t0);
    return reply({ id, hive: home.name, version: version.v, summary, status: decision.status, score: decision.score, reason: decision.reason, console: toolUrl(home.name, id) });
  },
);

server.tool(
  "publish_capability",
  "Share a tool from your private hive into a shared hive you belong to. Only the recipe travels (never your trace). The shared hive's own hidden cases decide whether it becomes that hive's head.",
  { id: z.string(), to_hive: z.string() },
  async ({ id, to_hive }) => {
    const t0 = Date.now();
    const target = await openHive(to_hive);
    const r = await publishCapability({ home, target, id, user: HIVE_USER, harness: HIVE_HARNESS });
    if (!r.ok) return reply({ error: r.error });
    if (r.published) await touchAgent(target);
    await record(target, "publish_capability", { id, from: r.from, v: r.version }, { status: r.published ? "active" : "rejected", score: r.score }, Date.now() - t0);
    const { ok: _ok, ...rest } = r;
    const out = { ...rest, console: toolUrl(target.name, id) };
    return reply(out);
  },
);

server.tool(
  "pin_capability",
  "Pin yourself to a specific version of a tool in a hive (or unpin with version omitted). Does not change the hive's head.",
  { id: z.string(), hive: z.string(), version: z.number().optional() },
  async ({ id, hive: hiveName, version }) => {
    const h = await openHive(hiveName);
    await touchAgent(h);
    await h.agents.updateOne({ _id: AGENT_ID }, version ? { $set: { [`pinned.${id}`]: version } } : { $unset: { [`pinned.${id}`]: "" } });
    await record(h, "pin_capability", { id, version }, {}, 0);
    return reply({ id, hive: h.name, pinned: version ?? null });
  },
);

// every promoted tool the agent can see also becomes its own native MCP tool, refreshed live
const native = nativeTools({
  server,
  reserved: ["explore", "distill_investigation", "find_capability", "run_capability", "propose_capability", "publish_capability", "pin_capability"],
  run: (h, cap, args) => runTool(h, cap, args, undefined, "run_capability"),
  reply,
  notify: (line) => notices.push(line),
});
await native.sync();
onHeadMove = native.schedule;
setInterval(native.schedule, 20_000).unref(); // picks up hives you were invited to after startup

await server.connect(new StdioServerTransport());
