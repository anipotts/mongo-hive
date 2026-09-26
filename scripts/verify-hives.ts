// drives the real mcp server as different users to check hive rules end to end.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { client as mongo, hive } from "../src/registry/db.js";

async function as(user: string) {
  const c = new Client({ name: "verify", version: "0" });
  await c.connect(new StdioClientTransport({
    command: "npx", args: ["tsx", "--env-file=.env", "src/mcp/server.ts"],
    env: { ...process.env, HIVE_USER: user, HIVE_HARNESS: "script", HIVE_RUN_ID: `verify_${user}` } as Record<string, string>,
  }));
  const call = async (name: string, args: object) => {
    const r: any = await c.callTool({ name, arguments: args as any });
    return r.isError ? { error: r.content?.[0]?.text } : JSON.parse(r.content[0].text);
  };
  return { call, close: () => c.close() };
}

const teamHead = await hive("team").capabilities.findOne({ _id: "advisory_impact" });
const head = teamHead!.versions.find((v) => v.v === teamHead!.activeVersion)!;

const ani = await as("ani");
const show = (label: string, x: any) => console.log(`\n# ${label}\n${JSON.stringify(x.result ? { ...x, result: x.result } : x)}`);

show("ani proposes a copy of the team recipe into her private hive", await ani.call("propose_capability", {
  id: "advisory_impact", directive: teamHead!.directive, scope: "deps", collection: head.collection,
  params: head.params, pipeline: head.pipeline, whenToUse: head.whenToUse,
}));
show("ani publishes it to team", await ani.call("publish_capability", { id: "advisory_impact", to_hive: "team" }));

const leaky = JSON.parse(JSON.stringify(head.pipeline).replaceAll('"{{advisory_id}}"', '"ADV-001"'));
show("ani proposes a version that hard-codes ADV-001", await ani.call("propose_capability", {
  id: "advisory_impact", directive: teamHead!.directive, scope: "deps", collection: head.collection,
  params: {}, pipeline: leaky, whenToUse: head.whenToUse,
}));
show("ani tries to publish the leaky version", await ani.call("publish_capability", { id: "advisory_impact", to_hive: "team" }));
await ani.close();

const kap = await as("kap");
show("kap (not a member of hive ani) tries to run ani's private tool", await kap.call("run_capability", { id: "advisory_impact", hive: "ani", args: { advisory_id: "ADV-002" } }));
show("kap tries to publish into ani's private hive", await kap.call("publish_capability", { id: "advisory_impact", to_hive: "ani" }));
await kap.close();
await mongo.close();
