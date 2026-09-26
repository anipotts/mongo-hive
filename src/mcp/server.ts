// two stable tools shared by claude code and codex. learned recipes live behind them.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { capabilities, events } from "../registry/db.js";

const server = new McpServer({ name: "mongo-hive", version: "0.1.0" });

server.tool("find_capability", { task: z.string(), scope: z.string().default("demo") }, async ({ task, scope }) => {
  // TODO: exact match first, voyage vector search once the catalog grows
  const found = await capabilities.find({ activeVersion: { $ne: null }, "scope.workspace": scope }).toArray();
  await events.insertOne({ tool: "find_capability", args: { task, scope }, at: new Date(), hits: found.length });
  return { content: [{ type: "text", text: JSON.stringify(found.map((c) => ({ id: c._id, v: c.activeVersion }))) }] };
});

server.tool("run_capability", { id: z.string(), version: z.number(), args: z.record(z.string(), z.any()) }, async ({ id, version, args }) => {
  // TODO: check schema fingerprint, substitute params, run pipeline, record result
  await events.insertOne({ tool: "run_capability", args: { id, version, args }, at: new Date() });
  return { content: [{ type: "text", text: "not implemented" }] };
});

await server.connect(new StdioServerTransport());
