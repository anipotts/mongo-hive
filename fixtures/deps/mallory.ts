// bad teammate: a member of the shared hive pushes subtly wrong versions through the real MCP server
// (propose into their private hive, then publish). the shared hive's hidden cases must reject them.
// usage: npm run poison [-- --hive team]
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { client as mongo, hive, hives } from "../../src/registry/db.js";

const i = process.argv.indexOf("--hive");
const team = hive(i > 0 ? process.argv[i + 1] : "team");
await hives.updateOne({ _id: team.name }, { $addToSet: { members: "mallory" } }); // mallory is a real member, so only the tests stand in the way

const cap = await team.capabilities.findOne({ _id: "advisory_impact" });
const head = cap!.versions.find((v) => v.v === cap!.activeVersion)!;
console.log(`head before: v${cap!.activeVersion} ${head.score?.passed}/${head.score?.total}`);
const base = JSON.stringify(head.pipeline);

// variant a: drops every archived filter
const noArchived = JSON.parse(base.replace(/archived/g, "__ignored")); // every field path that mentions archived now reads a missing field
// variant b: patch_fixable if ANY affected copy is on the fixed minor (instead of every copy), when the head has that shape
const anyCopy = JSON.parse(base.replace('"ok":{"$eq":["$n","$same"]}', '"ok":{"$gt":["$same",0]}'));

const transport = new StdioClientTransport({
  command: "npx",
  args: ["tsx", "--env-file=.env", "src/mcp/server.ts"],
  env: { ...(process.env as Record<string, string>), HIVE_USER: "mallory", HIVE_HARNESS: "script", HIVE_RUN_ID: "poison" },
});
const mcp = new Client({ name: "mallory", version: "0" });
await mcp.connect(transport);
const text = (r: any) => JSON.parse(r.content[0].text);
for (const [label, pipeline] of [["ignores archived", noArchived], ["any-copy fixable", anyCopy]] as const) {
  if (JSON.stringify(pipeline) === base) { console.log(`${label}: head has a different shape, skipped`); continue; }
  await mcp.callTool({
    name: "propose_capability",
    arguments: { id: "advisory_impact", directive: cap!.directive, scope: "deps", collection: head.collection, params: head.params, pipeline, whenToUse: `faster audit (${label})` },
  });
  const pub = text(await mcp.callTool({ name: "publish_capability", arguments: { id: "advisory_impact", to_hive: team.name } }));
  console.log(`${label} -> ${pub.summary ?? pub.error} | ${pub.reason ?? ""}`);
}
await mcp.close();
const after = await team.capabilities.findOne({ _id: "advisory_impact" });
console.log(`head after: v${after!.activeVersion} (unchanged: ${after!.activeVersion === cap!.activeVersion})`);
await mongo.close();
