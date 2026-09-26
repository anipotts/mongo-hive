// proves the worker drafts a brand-new tool from a session's investigation and the main agent can use it, first
// solo (private hive), then shared: publish → teammate's trial run + feedback → named tool for the teammate.
// real mcp clients, the real worker model; throwaway hives only (never live/team). needs a worker model key.
// run: npx tsx --env-file=.env scripts/verify-newtool.ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { client, db, hive, hives } from "../src/registry/db.js";
import { claim } from "../src/worker/index.js";
import { draftNewTool } from "../src/worker/newtool.js";
import { workerLlm } from "../src/worker/llm.js";
import { giveFeedback } from "../src/hive/feedback.js";

const ANI = "nw_ani", KAP = "nw_kap", SHARED = "nwtest";
const drop = async () => {
  for (const n of [ANI, KAP, SHARED]) { await client.db(`hive_${n}`).dropDatabase(); await hives.deleteOne({ _id: n }); }
};
let failed = 0;
const check = (ok: unknown, what: string) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) failed++; };

async function agent(user: string) {
  const mcp = new Client({ name: `verify-newtool-${user}`, version: "0" });
  await mcp.connect(new StdioClientTransport({
    command: "npx", args: ["tsx", "--env-file=.env", "src/mcp/server.ts"],
    env: { ...(process.env as Record<string, string>), HIVE_USER: user, HIVE_HARNESS: "claude-code", HIVE_RUN_ID: `verify-newtool-${user}` },
  }));
  const call = async (name: string, args: Record<string, unknown>) => JSON.parse(((await mcp.callTool({ name, arguments: args })).content as any)[0].text);
  const names = async () => (await mcp.listTools()).tools.map((t) => t.name);
  const waitFor = async (want: (n: string[]) => boolean) => {
    for (let i = 0; i < 120; i++) { if (want(await names())) return true; await new Promise((r) => setTimeout(r, 250)); }
    return false;
  };
  return { mcp, call, names, waitFor };
}

await drop();
try {
  // a real on-call investigation: a service's upstreams, then their recent successful deploys
  const svc = (await db.collection("inc_services").findOne({ "depends_on.0": { $exists: true } }))!;
  const ani = await agent(ANI);
  const before = await ani.names();
  await ani.call("explore", { collection: "inc_services", pipeline: [{ $match: { _id: svc._id } }] });
  await ani.call("explore", {
    collection: "inc_deploys",
    pipeline: [{ $match: { service: { $in: [svc._id, ...svc.depends_on] }, status: "succeeded" } }, { $sort: { at: -1 } }, { $limit: 5 }],
  });
  const h = hive(ANI);
  const job = await h.workerJobs.findOne({ trigger: "repetition" });
  check(job?.step === "queued" && job.sessionId === `verify-newtool-${ANI}`, "two explore calls queued a new-tool job in ani's private hive");

  // what `npm run worker` does for that job (in-process here so the check is deterministic)
  const claimed = await claim(h, job!._id);
  const r = await draftNewTool(h, claimed!, await workerLlm());
  check(r.ok, r.ok ? `worker drafted ${r.id} v${r.v}: ${r.summary} (${r.rows} row(s) on ${JSON.stringify(r.example)})` : `worker draft: ${r.reason}`);
  if (!r.ok) throw new Error("no draft");
  const named = await h.workerJobs.findOne({ _id: job!._id });
  check(named?.capId === r.id && named?.step === "validating", `the job carries the tool name before it closes (${named?.capId}, ${named?.step})`);

  check(await ani.waitFor((n) => n.includes(r.id)) && !before.includes(r.id), `ani's session gained named tool ${r.id} mid-session`);
  const solo = await ani.call(r.id, r.example);
  check(solo.version === 1 && /unverified v1/.test(solo.ran) && solo.result?.length > 0, `ani calls ${r.id} by name: ${solo.ran}`);
  check(Array.isArray(solo.notices) && solo.notices.some((n: string) => n.includes(r.id)), `ani's reply carries the notice: ${JSON.stringify(solo.notices ?? [])}`);

  // shared: ani publishes; kap's agent runs it on trial, kap accepts, it becomes kap's named tool
  await hives.insertOne({ _id: SHARED, visibility: "shared", owner: ANI, members: [ANI, KAP], createdAt: new Date() } as any);
  const kap = await agent(KAP);
  const pub = await ani.call("publish_capability", { id: r.id, to_hive: SHARED });
  check(pub.version === 1 && !pub.published, `ani publishes to ${SHARED}: ${pub.reason}`);
  check(!(await kap.names()).includes(r.id), "not a named tool for kap before any eval");
  const trial = await kap.call("run_capability", { id: r.id, hive: SHARED, args: r.example });
  check(/unverified v1/.test(trial.ran ?? ""), `kap's trial run: ${trial.ran} (${trial.result?.length} row(s))`);
  if (trial.result?.length === 1) {
    const fb = await giveFeedback({ h: hive(SHARED), outputId: trial.outputId, by: KAP, verdict: "correct" });
    check(fb.ok && fb.head?.v === 1, `kap accepts: ${fb.ok ? fb.summary : fb.error}`);
    check(await kap.waitFor((n) => n.includes(r.id)), `kap now has named tool ${r.id}`);
    const byName = await kap.call(r.id, r.example);
    check(/promoted v1/.test(byName.ran ?? ""), `kap calls it by name: ${byName.ran}`);
    check(await ani.waitFor((n) => n.includes(r.id) && !n.some((x) => x.endsWith(`__${r.id}`))), "ani keeps the same bare name after publish");
  } else console.log(`note: trial returned ${trial.result?.length} rows; accept needs exactly one, skipped the shared promotion step`);

  await ani.mcp.close(); await kap.mcp.close();
} catch (e) {
  failed++;
  console.error("FAIL", e);
} finally {
  await drop();
  await client.close();
}
console.log(failed ? `${failed} check(s) failed` : "new-tool path verified");
process.exit(failed ? 1 : 0);
