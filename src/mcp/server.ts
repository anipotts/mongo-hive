// MongoHive tool server. same five tools for claude code, codex, or any mcp client.
// learned recipes live in atlas behind these tools, so no client ever needs a tool-list refresh.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { AGENT_ID, HIVE_HARNESS, HIVE_USER, agents, capabilities, db, events, runs } from "../registry/db.js";
import type { Capability, CapabilityVersion } from "../registry/types.js";
import { assertReadOnly, execute, hashRecipe } from "../learner/index.js";
import { validate } from "../validator/index.js";

const runId = process.env.HIVE_RUN_ID ?? `run_${randomUUID().slice(0, 8)}`;
await runs.updateOne(
  { _id: runId as any },
  { $setOnInsert: { user: HIVE_USER, harness: HIVE_HARNESS, startedAt: new Date() } },
  { upsert: true },
);
await agents.updateOne(
  { _id: AGENT_ID },
  { $set: { user: HIVE_USER, harness: HIVE_HARNESS, lastSeen: new Date() }, $setOnInsert: { pulled: {}, pinned: {} } },
  { upsert: true },
);

// live notices: the change stream tells this agent the moment a teammate's tool becomes active
const notices: string[] = [];
capabilities
  .watch([{ $match: { operationType: { $in: ["insert", "update", "replace"] } } }], { fullDocument: "updateLookup" })
  .on("change", (c: any) => {
    const cap = c.fullDocument as Capability | undefined;
    if (!cap?.activeVersion) return;
    const head = cap.versions.find((v) => v.v === cap.activeVersion);
    if (head && head.author !== HIVE_USER)
      notices.push(`hive: ${head.author} (${head.harness}) activated ${cap._id} v${head.v}`);
  })
  .on("error", () => {});

async function record(tool: string, args: unknown, result: unknown, ms: number, dbOps = 1) {
  await events.insertOne({ runId, user: HIVE_USER, harness: HIVE_HARNESS, tool, args, result, ms, dbOps, at: new Date() });
}

const reply = (payload: unknown) => {
  const body = notices.length ? { notices: notices.splice(0), ...(payload as object) } : payload;
  return { content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }] };
};

async function staleness(cap: Capability) {
  const me = await agents.findOne({ _id: AGENT_ID });
  const pulled = me?.pulled?.[cap._id] ?? null;
  const pinned = me?.pinned?.[cap._id] ?? null;
  return { pulled, pinned, behind: pulled !== null && cap.activeVersion !== null && pulled < cap.activeVersion };
}

const server = new McpServer({ name: "mongo-hive", version: "0.2.0" });

server.tool(
  "explore",
  "Run a read-only aggregation on a data collection to investigate. Every call is recorded as part of this run's trace.",
  { collection: z.string(), pipeline: z.array(z.record(z.string(), z.any())) },
  async ({ collection, pipeline }) => {
    const t0 = Date.now();
    assertReadOnly(pipeline);
    const out = await db.collection(collection).aggregate(pipeline, { maxTimeMS: 10_000 }).limit(50).toArray();
    await record("explore", { collection, pipeline }, { count: out.length }, Date.now() - t0);
    return reply(out);
  },
);

server.tool(
  "find_capability",
  "ALWAYS call this first. Returns team-learned, tested tools in the hive that may already solve the task, and whether you are behind the team's version.",
  { task: z.string(), scope: z.string().optional() },
  async ({ task, scope }) => {
    const t0 = Date.now();
    const caps = await capabilities.find({ activeVersion: { $ne: null }, ...(scope ? { scope } : {}) }).toArray();
    const out = await Promise.all(
      caps.map(async (c) => {
        const head = c.versions.find((v) => v.v === c.activeVersion)!;
        return { id: c._id, directive: c.directive, activeVersion: c.activeVersion, params: head.params, whenToUse: head.whenToUse, author: head.author, ...(await staleness(c)) };
      }),
    );
    await record("find_capability", { task, scope }, { hits: out.map((o) => o.id) }, Date.now() - t0);
    return reply({ capabilities: out, hint: out.length ? "call run_capability with the matching id" : "none yet: explore, then propose_capability" });
  },
);

server.tool(
  "run_capability",
  "Run a hive tool. Omit version to use your pinned version, else the team's active version.",
  { id: z.string(), args: z.record(z.string(), z.any()), version: z.number().optional() },
  async ({ id, args, version }) => {
    const t0 = Date.now();
    const cap = await capabilities.findOne({ _id: id });
    if (!cap) return reply({ error: `no capability ${id}` });
    const me = await agents.findOne({ _id: AGENT_ID });
    const v = version ?? me?.pinned?.[id] ?? cap.activeVersion;
    const ver = cap.versions.find((x) => x.v === v);
    if (!ver || ver.status === "rejected") return reply({ error: `version ${v} not runnable` });
    const prev = me?.pulled?.[id] ?? null;
    const out = await execute(db, ver, args);
    await agents.updateOne({ _id: AGENT_ID }, { $set: { [`pulled.${id}`]: v, lastSeen: new Date() } });
    await record("run_capability", { id, v, args }, { count: out.length }, Date.now() - t0);
    return reply({ id, version: v, synced: prev !== null && prev !== v ? `synced ${id} v${prev} -> v${v}` : undefined, result: out });
  },
);

server.tool(
  "propose_capability",
  "After solving a task with explore, turn the procedure into a reusable, parameterized, read-only tool. Use {{param}} placeholders. It is tested against hidden cases; it only becomes active if it passes and beats the current version.",
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
    assertReadOnly(pipeline);
    const cap = await capabilities.findOne({ _id: id });
    const v = (cap?.versions.length ?? 0) + 1;
    const version: CapabilityVersion = {
      v, status: "rejected", collection, params, pipeline, whenToUse,
      author: HIVE_USER, harness: HIVE_HARNESS, sourceRunId: runId,
      hash: hashRecipe(collection, pipeline), createdAt: new Date(),
    };
    const verdict = await validate(id, version);
    version.score = { passed: verdict.passed, total: verdict.total, ms: verdict.ms };
    const head = cap?.versions.find((x) => x.v === cap.activeVersion);
    const beatsHead = !head?.score || verdict.passed > head.score.passed || (verdict.passed === head.score.passed && verdict.ms < head.score.ms);
    const accept = verdict.total > 0 && verdict.passed === verdict.total && beatsHead;
    version.status = accept ? "active" : "rejected";
    version.reason = accept ? "passed all hidden cases" : verdict.failures.slice(0, 3).join("; ") || "does not beat current version";

    // one atomic write: append the version and (if accepted) move the team head
    await capabilities.updateOne(
      { _id: id },
      {
        $setOnInsert: { directive, scope, ...(accept ? {} : { activeVersion: null }) },
        $push: { versions: version },
        $set: { updatedAt: new Date(), ...(accept ? { activeVersion: v } : {}) },
      } as any,
      { upsert: true },
    );
    if (accept && head) await capabilities.updateOne({ _id: id, "versions.v": head.v }, { $set: { "versions.$.status": "superseded" } });
    if (accept) await agents.updateOne({ _id: AGENT_ID }, { $set: { [`pulled.${id}`]: v } });
    await record("propose_capability", { id, v }, { accept, score: version.score }, Date.now() - t0);
    return reply({ id, version: v, accepted: accept, score: version.score, reason: version.reason });
  },
);

server.tool(
  "pin_capability",
  "Pin yourself to a specific version of a hive tool (or unpin with version omitted). Does not change the team head.",
  { id: z.string(), version: z.number().optional() },
  async ({ id, version }) => {
    await agents.updateOne({ _id: AGENT_ID }, version ? { $set: { [`pinned.${id}`]: version } } : { $unset: { [`pinned.${id}`]: "" } });
    await record("pin_capability", { id, version }, {}, 0);
    return reply({ id, pinned: version ?? null });
  },
);

await server.connect(new StdioServerTransport());
