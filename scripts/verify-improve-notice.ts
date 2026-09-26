// end-to-end check for the recursive loop: kap's agent is connected through the real MCP server, sees the
// improve hint, the worker improves the tool in another process, and kap's next reply carries the notice.
// usage: npx tsx --env-file=.env scripts/verify-improve-notice.ts [capId]
import { spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const id = process.argv[2] ?? "advisory_owners";
const mcp = new Client({ name: "kap-check", version: "0" });
await mcp.connect(new StdioClientTransport({
  command: "npx", args: ["tsx", "--env-file=.env", "src/mcp/server.ts"],
  env: { ...(process.env as Record<string, string>), HIVE_USER: "kap", HIVE_HARNESS: "claude-code", HIVE_RUN_ID: "verify_improve" },
}));
const find = async () => JSON.parse(((await mcp.callTool({ name: "find_capability", arguments: { task: "which teams own repos affected by an advisory", scope: "deps" } })) as any).content[0].text);

const before = await find();
const hit = before.capabilities.find((c: any) => c.id === id);
console.log("before:", JSON.stringify({ version: hit?.version, you: hit?.you?.state, improve: hit?.improve }));

const r = spawnSync("npx", ["tsx", "--env-file=.env", "scripts/improve.ts", "--hive", "team", "--id", id, "--rounds", "4"], { stdio: "inherit" });
if (r.status !== 0) console.log("improve exited", r.status);
await new Promise((res) => setTimeout(res, 1500)); // let the change stream deliver

const after = await find();
const hit2 = after.capabilities.find((c: any) => c.id === id);
console.log("notices:", JSON.stringify(after.notices ?? []));
console.log("after:", JSON.stringify({ version: hit2?.version, you: hit2?.you, improve: hit2?.improve ?? null, top: hit2?.leaderboard?.[0] }));
await mcp.close();
