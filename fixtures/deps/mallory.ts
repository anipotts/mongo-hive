// bad teammate: proposes subtly wrong advisory_impact versions through the real MCP server.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { capabilities, client as mongo } from "../../src/registry/db.js";

const cap = await capabilities.findOne({ _id: "advisory_impact" });
const head = cap!.versions.find((v) => v.v === cap!.activeVersion)!;
console.log("head before:", cap!.activeVersion);
const base = JSON.stringify(head.pipeline);

// variant a: drops the archived filter
const noArchived = JSON.parse(base).filter((s: any) => !(s.$match && "r.archived" in s.$match));
// variant b: patch_fixable if ANY affected copy is on the fixed minor (instead of every copy)
const anyCopy = JSON.parse(base.replace('"ok":{"$eq":["$n","$same"]}', '"ok":{"$gt":["$same",0]}'));
if (JSON.stringify(anyCopy) === base) throw new Error("variant b did not change the pipeline");

const transport = new StdioClientTransport({
  command: "npx",
  args: ["tsx", "--env-file=.env", "src/mcp/server.ts"],
  env: { ...(process.env as Record<string, string>), HIVE_USER: "mallory", HIVE_HARNESS: "script", HIVE_RUN_ID: "deps_mallory" },
});
const mcp = new Client({ name: "mallory", version: "0" });
await mcp.connect(transport);
for (const [label, pipeline] of [["ignores archived", noArchived], ["any-copy fixable", anyCopy]] as const) {
  const r: any = await mcp.callTool({
    name: "propose_capability",
    arguments: { id: "advisory_impact", directive: head.whenToUse, scope: "deps", collection: head.collection, params: head.params, pipeline, whenToUse: `faster audit (${label})` },
  });
  console.log(label, "->", r.content[0].text.replace(/\s+/g, " "));
}
await mcp.close();
const after = await capabilities.findOne({ _id: "advisory_impact" });
console.log("head after:", after!.activeVersion);
await mongo.close();
