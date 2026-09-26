// feeds sample hook payloads through the real plugin shim, then shows what landed in atlas.
// usage: MONGO_HIVE_CONFIG=<path> npx tsx --env-file=.env scripts/verify-hooks.ts
import { spawnSync } from "node:child_process";
import { hive, client } from "../src/registry/db.js";

const sid = `verify_hook_${Date.now()}`;
const payloads = [
  { hook_event_name: "SessionStart", session_id: sid, cwd: "/tmp/demo" },
  { hook_event_name: "UserPromptSubmit", session_id: sid, prompt: "triage run R1040, token=abc123secret" },
  { hook_event_name: "PostToolUse", session_id: sid, tool_name: "Bash", tool_input: { command: "echo mongodb+srv://u:p@host/x" }, tool_response: "ok sk-abcdefghijklmnopqrstuv" },
  { hook_event_name: "Stop", session_id: sid },
];
for (const p of payloads) {
  const t0 = Date.now();
  const r = spawnSync("node", ["plugins/mongo-hive/scripts/hive-hook.mjs"], { input: JSON.stringify(p), env: { ...process.env, CLAUDECODE: "1" } });
  console.log(`${p.hook_event_name}: exit ${r.status} in ${Date.now() - t0}ms`);
  await new Promise((r) => setTimeout(r, 2500)); // detached writer finishes in the background
}
const team = hive("team");
console.log("session:", JSON.stringify(await team.db.collection("sessions").findOne({ _id: sid as any }, { projection: { cwd: 0 } })));
for (const e of await team.events.find({ sessionId: sid }).sort({ at: 1 }).toArray())
  console.log("event:", JSON.stringify({ kind: e.kind, tool: e.tool, harness: e.harness, argsPreview: e.argsPreview, resultPreview: e.resultPreview }));
// fail-open: a broken config must still exit 0 fast
const t0 = Date.now();
const bad = spawnSync("node", ["plugins/mongo-hive/scripts/hive-hook.mjs"], { input: "{}", env: { ...process.env, MONGO_HIVE_CONFIG: "/nonexistent/config.json" } });
console.log(`not joined: exit ${bad.status} in ${Date.now() - t0}ms`);
await client.close();
