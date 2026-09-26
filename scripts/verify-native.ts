// proves promoted tools appear as native mcp tools and refresh live, in a throwaway hive (never live/team).
// run: npx tsx --env-file=.env scripts/verify-native.ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { client, hive, hives } from "../src/registry/db.js";

const HIVE = "nttest", USER = "nt_user";
const keep = process.argv.includes("--keep"); // leave the throwaway hive for a manual claude/codex check
const src = hive("team"); // read only
const t = hive(HIVE);
const copy = async (id: string, promote: boolean) => {
  const cap = (await src.capabilities.findOne({ _id: id }))!;
  const head = cap.versions.find((v) => v.v === cap.activeVersion)!;
  const key = (await src.answerKeys.findOne({ _id: id }))!;
  await t.answerKeys.replaceOne({ _id: id }, key, { upsert: true });
  await t.capabilities.replaceOne({ _id: id }, {
    ...cap, activeVersion: promote ? 1 : null, nextVersion: 1, updatedAt: new Date(),
    versions: [{ ...head, v: 1, status: promote ? "active" : "unverified", author: "kap", harness: "claude-code" }],
  } as any, { upsert: true });
};

await hives.replaceOne({ _id: HIVE }, { _id: HIVE, visibility: "shared", owner: USER, members: [USER], createdAt: new Date() } as any, { upsert: true });
await copy("advisory_impact", true);
await copy("triage_ci_failure", false);
if (keep) { console.log("seeded hive_nttest for nt_user; rerun without --keep to verify + drop"); await client.close(); process.exit(0); }

const mcp = new Client({ name: "verify-native", version: "0" });
let changed = 0;
mcp.setNotificationHandler(ToolListChangedNotificationSchema, async () => { changed++; });
await mcp.connect(new StdioClientTransport({
  command: "npx", args: ["tsx", "--env-file=.env", "src/mcp/server.ts"],
  env: { ...(process.env as Record<string, string>), HIVE_USER: USER, HIVE_HARNESS: "script", HIVE_RUN_ID: "verify-native" },
}));
const tools = async () => (await mcp.listTools()).tools;
const names = async () => (await tools()).map((x) => x.name);
console.log("tools at start:", (await names()).join(", "));
const d = (await tools()).find((x) => x.name === "advisory_impact");
console.log("advisory_impact description:\n  " + d?.description?.split("\n").join("\n  "));
console.log("advisory_impact input schema:", JSON.stringify(d?.inputSchema));
const r = await mcp.callTool({ name: "advisory_impact", arguments: { advisory_id: "ADV-004" } });
const body = JSON.parse((r.content as any)[0].text);
console.log("call advisory_impact(ADV-004):", JSON.stringify(body.result), "v" + body.version, body.outputId);

console.log("promoting triage_ci_failure while connected...");
await t.capabilities.updateOne({ _id: "triage_ci_failure" }, { $set: { activeVersion: 1, "versions.0.status": "active", updatedAt: new Date() } });
for (let i = 0; i < 40 && !(await names()).includes("triage_ci_failure"); i++) await new Promise((res) => setTimeout(res, 250));
console.log(`list_changed notifications: ${changed}; tools now: ${(await names()).join(", ")}`);
const r2 = await mcp.callTool({ name: "find_capability", arguments: { task: "ci failure" } });
console.log("next reply notices:", JSON.stringify(JSON.parse((r2.content as any)[0].text).notices ?? []));

const r3 = await mcp.callTool({ name: "triage_ci_failure", arguments: { run_id: "R1040" } });
const b3 = JSON.parse((r3.content as any)[0].text);
console.log("call triage_ci_failure(R1040):", JSON.stringify(b3.result), "|", b3.ran);

console.log("promoting a same-params v2 of triage_ci_failure (kap's worker)...");
const before = changed;
const cap = (await t.capabilities.findOne({ _id: "triage_ci_failure" }))!;
const v2 = { ...cap.versions[0], v: 2, author: "kap", harness: "worker", createdAt: new Date() };
await t.capabilities.updateOne({ _id: "triage_ci_failure" }, { $set: { versions: [{ ...cap.versions[0], status: "superseded" }, { ...v2, status: "active" }], activeVersion: 2, nextVersion: 2, updatedAt: new Date() } });
await new Promise((res) => setTimeout(res, 3000));
const r4 = await mcp.callTool({ name: "triage_ci_failure", arguments: { run_id: "R1040" } });
const b4 = JSON.parse((r4.content as any)[0].text);
console.log(`list_changed after promotion: ${changed - before} (want 0) | ${b4.ran} | ${b4.updated}`);

console.log("publishing a version with different params (frozen contract)...");
const { commitVersion, decide, validate } = await import("../src/validator/index.js");
const { decision } = await commitVersion(t, "triage_ci_failure", { directive: cap.directive, scope: cap.scope },
  (v) => ({ ...v2, v, status: "rejected", params: { run_id: "string", branch: "string" }, createdAt: new Date() }),
  async (ver, head) => decide(await validate(t, "triage_ci_failure", ver), head, false));
console.log(`  ${decision.status}: ${decision.reason}`);

console.log("demoting advisory_impact...");
await t.capabilities.updateOne({ _id: "advisory_impact" }, { $set: { activeVersion: null, "versions.0.status": "superseded", updatedAt: new Date() } });
for (let i = 0; i < 40 && (await names()).includes("advisory_impact"); i++) await new Promise((res) => setTimeout(res, 250));
console.log(`list_changed notifications: ${changed}; tools now: ${(await names()).join(", ")}`);

await mcp.close();
await client.db(`hive_${HIVE}`).dropDatabase();
await client.db(`hive_${USER}`).dropDatabase();
await hives.deleteMany({ _id: { $in: [HIVE, USER] } });
console.log("dropped hive_nttest, hive_nt_user and their registry entries");
await client.close();
