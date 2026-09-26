// offline catch-up: ani's agent stops, kap's tool takes the lead in a shared hive, ani comes back and is told on her first reply.
// uses a throwaway shared hive (hive_catchup) so the real team board is untouched.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { client as mongo, ensureHive, hive, hives } from "../src/registry/db.js";

async function as(user: string) {
  const c = new Client({ name: "verify", version: "0" });
  await c.connect(new StdioClientTransport({
    command: "npx", args: ["tsx", "--env-file=.env", "src/mcp/server.ts"],
    env: { ...process.env, HIVE_USER: user, HIVE_HARNESS: "script", HIVE_RUN_ID: `catchup_${user}` } as Record<string, string>,
  }));
  const call = async (name: string, args: object) => {
    const r: any = await c.callTool({ name, arguments: args as any });
    return r.isError ? { error: r.content?.[0]?.text } : JSON.parse(r.content[0].text);
  };
  return { call, close: () => c.close() };
}

const scratch = hive("catchup");
await scratch.db.dropDatabase();
await hives.deleteOne({ _id: "catchup" });
await ensureHive("catchup", "shared", "ani", ["kap"]);
const team = hive("team");
await scratch.answerKeys.insertOne((await team.answerKeys.findOne({ _id: "triage_ci_failure" }))!);
const src = (await team.capabilities.findOne({ _id: "triage_ci_failure" }))!;
const head = src.versions.find((v) => v.v === src.activeVersion)!;

// 1. ani's agent is online once, so the hive remembers where her stream stopped
let ani = await as("ani");
await ani.call("find_capability", { task: "triage failing ci run" });
await ani.close();
const token = (await scratch.agents.findOne({ _id: "ani:script" }))?.resumeToken;
console.log("# ani offline, saved resume token:", token ? JSON.stringify(token).slice(0, 60) + "..." : "none");

// 2. while ani is offline, kap proposes privately and publishes into the shared hive
const kap = await as("kap");
await kap.call("propose_capability", {
  id: "triage_ci_failure", directive: src.directive, scope: src.scope, collection: head.collection,
  params: head.params, pipeline: head.pipeline, whenToUse: head.whenToUse,
});
const pub = await kap.call("publish_capability", { id: "triage_ci_failure", to_hive: "catchup" });
console.log("# kap publishes while ani is offline:", JSON.stringify({ published: pub.published, version: pub.version, score: pub.score }));
await kap.close();

// 3. ani comes back: her very first reply carries what she missed
ani = await as("ani");
const back = await ani.call("find_capability", { task: "triage failing ci run" });
console.log("# ani's first reply after reconnecting:");
console.log("  notices:", JSON.stringify(back.notices ?? []));
const row = back.capabilities?.find((c: any) => c.hive === "catchup");
console.log("  you:", JSON.stringify(row?.you));
await ani.close();

await scratch.db.dropDatabase();
await hives.deleteOne({ _id: "catchup" });
await mongo.close();
