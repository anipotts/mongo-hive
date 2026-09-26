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
import { board, commitVersion, decide, scoreOn, standing, validate } from "../validator/index.js";
import { publishCapability } from "../hive/publish.js";

const runId = process.env.HIVE_RUN_ID ?? `run_${randomUUID().slice(0, 8)}`;
await ensureHive(HIVE_HOME, "private", HIVE_USER);
const home = hive(HIVE_HOME);

async function touchAgent(h: Hive) {
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
const watchPipeline = [{ $match: { operationType: { $in: ["insert", "update", "replace"] } } }];

function onChange(h: Hive, c: any) {
  const moved = c.operationType !== "update" || "activeVersion" in (c.updateDescription?.updatedFields ?? {});
  const cap = c.fullDocument as Capability | undefined;
  if (!moved || !cap?.activeVersion) return;
  const head = cap.versions.find((v) => v.v === cap.activeVersion);
  if (head && head.author !== HIVE_USER)
    notices.push(`hive ${h.name}: ${head.author} (${head.harness}) took the lead on ${cap._id} with v${head.v} (${head.score?.passed}/${head.score?.total})`);
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
  await h.events.insertOne({ runId, user: HIVE_USER, harness: HIVE_HARNESS, hive: h.name, tool, args, result, ms, at: new Date() });
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
  if (h.name === HIVE_HOME) return [...cap.versions].reverse().find((x) => x.status === "unverified");
  return undefined;
}

const STOP = new Set(["which", "what", "that", "this", "with", "from", "have", "does", "should", "about", "their", "there", "into", "each", "them", "they", "will", "when", "were"]);

const server = new McpServer({ name: "mongo-hive", version: "0.3.0" });

server.tool(
  "explore",
  "Run a read-only aggregation on a work-data collection to investigate. Every call is recorded in your private hive's trace.",
  { collection: z.string(), pipeline: z.array(z.record(z.string(), z.any())) },
  async ({ collection, pipeline }) => {
    const t0 = Date.now();
    assertAllowedCollection(collection);
    assertReadOnly(pipeline);
    const out = await db.collection(collection).aggregate(fromEjson(pipeline), { maxTimeMS: 10_000 }).limit(50).toArray();
    await record(home, "explore", { collection, pipeline }, { count: out.length }, Date.now() - t0);
    return reply(out);
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
    const t0 = Date.now();
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
    const me = await h.agents.findOne({ _id: AGENT_ID });
    const ver = version != null ? cap.versions.find((x) => x.v === version && x.status !== "rejected") : runnable(cap, h, me?.pinned?.[id]);
    if (!ver) return reply({ error: `no runnable version of ${id} in hive ${h.name}` });
    const prev = me?.pulled?.[id] ?? null;
    const out = await execute(db, ver, args);
    await touchAgent(h);
    await h.agents.updateOne({ _id: AGENT_ID }, { $set: { [`pulled.${id}`]: ver.v } });
    await record(h, "run_capability", { id, v: ver.v, args }, { count: out.length }, Date.now() - t0);
    return reply({
      id, hive: h.name, version: ver.v, status: ver.status,
      synced: prev !== null && prev !== ver.v ? `synced ${id} v${prev} -> v${ver.v}` : undefined,
      result: out,
    });
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
    const { version, decision } = await commitVersion(
      home, id, { directive, scope },
      (v) => ({ v, status: "rejected", collection, params, pipeline, whenToUse, author: HIVE_USER, harness: HIVE_HARNESS, sourceRunId: runId, hash: hashRecipe(collection, pipeline), createdAt: new Date() }),
      async (ver, head) => decide(await validate(home, id, ver), head, true),
    );
    if (decision.status !== "rejected") await home.agents.updateOne({ _id: AGENT_ID }, { $set: { [`pulled.${id}`]: version.v } });
    await record(home, "propose_capability", { id, v: version.v }, { status: decision.status, score: decision.score }, Date.now() - t0);
    return reply({ id, hive: home.name, version: version.v, status: decision.status, score: decision.score, reason: decision.reason });
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
    const { ok: _ok, ...out } = r;
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

await server.connect(new StdioServerTransport());
