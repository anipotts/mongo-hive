// proves the #36 vertical slice with two real mcp clients (ani, kap) in a throwaway hive, never live/team:
// ani proposes + publishes → unverified, not native → kap runs it on trial and accepts → promoted v1 appears as a
// named tool → ani pins v1 → kap calls it by name, rejects a wrong answer → ani's v2 is promoted on kap's evals →
// kap's same-name call runs v2, ani's stays pinned on v1. no eval args/expect in any agent-facing reply.
// the v2 here is team's advisory_owners v2 recipe standing in for ani's worker draft (the llm is not the point).
// run: npx tsx --env-file=.env scripts/verify-slice.ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { isDeepStrictEqual } from "node:util";
import { client, db, hive, hives } from "../src/registry/db.js";
import { execute } from "../src/learner/index.js";
import { giveFeedback } from "../src/hive/feedback.js";

const HIVE = "slicetest", ANI = "sl_ani", KAP = "sl_kap", TOOL = "slice_owners";
const team = hive("team"); // read only: the recipe and its evals give us real inputs and known answers
const src = (await team.capabilities.findOne({ _id: "advisory_owners" }))!;
const v1 = src.versions.find((v) => v.v === 1)!, v2 = src.versions.find((v) => v.v === 2)!;
const cases = (await team.answerKeys.findOne({ _id: "advisory_owners" }))!.cases;
const secrets = cases.map((c) => JSON.stringify(c.expect)); // must never show up in a reply

const drop = async () => {
  for (const n of [HIVE, ANI, KAP]) { await client.db(`hive_${n}`).dropDatabase(); await hives.deleteOne({ _id: n }); }
};
await drop();
await hives.insertOne({ _id: HIVE, visibility: "shared", owner: ANI, members: [ANI, KAP], createdAt: new Date() } as any);

let failed = 0;
const check = (ok: unknown, what: string) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) failed++; };

async function agent(user: string) {
  const mcp = new Client({ name: `verify-slice-${user}`, version: "0" });
  let changed = 0;
  mcp.setNotificationHandler(ToolListChangedNotificationSchema, async () => { changed++; });
  await mcp.connect(new StdioClientTransport({
    command: "npx", args: ["tsx", "--env-file=.env", "src/mcp/server.ts"],
    env: { ...(process.env as Record<string, string>), HIVE_USER: user, HIVE_HARNESS: "claude-code", HIVE_RUN_ID: `verify-slice-${user}` },
  }));
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = await mcp.callTool({ name, arguments: args });
    const text = (r.content as any)[0].text as string;
    // the executor legitimately returns a correct answer; an eval leak is an expected output nobody ran for
    if (name !== TOOL && name !== "run_capability") for (const s of secrets) if (text.includes(s)) check(false, `${name} reply leaks an eval's expected output`);
    return JSON.parse(text);
  };
  const names = async () => (await mcp.listTools()).tools.map((t) => t.name);
  const waitFor = async (want: (n: string[]) => boolean) => {
    for (let i = 0; i < 120; i++) { if (want(await names())) return true; await new Promise((r) => setTimeout(r, 250)); }
    return false;
  };
  return { mcp, call, names, waitFor, changed: () => changed };
}

try {
  // pick one input v1 answers right and one it gets wrong, script-side (agents never see these)
  let good, bad;
  for (const c of cases) {
    const out = await execute(db, v1, c.args);
    if (!good && out.length === 1 && isDeepStrictEqual(out[0], c.expect)) good = c;
    if (!bad && !(out.length === 1 && isDeepStrictEqual(out[0], c.expect)) && (await execute(db, v2, c.args)).length === 1) bad = c;
  }
  if (!good || !bad) throw new Error("no usable good/bad inputs for advisory_owners v1");

  const ani = await agent(ANI), kap = await agent(KAP);

  const p = await ani.call("propose_capability", { id: TOOL, directive: src.directive, scope: src.scope, collection: v1.collection, params: v1.params, pipeline: v1.pipeline, whenToUse: v1.whenToUse });
  check(p.status === "unverified", `ani proposes ${TOOL} v${p.version}: ${p.status}`);
  const pub = await ani.call("publish_capability", { id: TOOL, to_hive: HIVE });
  check(pub.version === 1 && !pub.published, `ani publishes to ${HIVE}: v${pub.version}, ${pub.reason}`);
  check(!(await kap.names()).includes(TOOL), "unverified tool is not a named tool for kap yet");
  // the rename case from #27: ani's private copy is promoted too (as if her own evals passed it)
  await hive(ANI).capabilities.updateOne({ _id: TOOL }, { $set: { activeVersion: 1, "versions.0.status": "active", updatedAt: new Date() } });
  check(await ani.waitFor((n) => n.includes(TOOL)), `ani's promoted private ${TOOL} is a named tool`);

  const trial = await kap.call("run_capability", { id: TOOL, hive: HIVE, args: good.args });
  check(trial.version === 1 && /unverified/.test(trial.ran), `kap runs it on trial: ${trial.ran}`);
  const fb1 = await giveFeedback({ h: hive(HIVE), outputId: trial.outputId, by: KAP, verdict: "correct" });
  check(fb1.ok && fb1.head?.v === 1, `kap accepts: ${fb1.ok ? fb1.summary : fb1.error}`);

  check(await kap.waitFor((n) => n.includes(TOOL)), `kap sees named tool ${TOOL} (list_changed x${kap.changed()})`);
  check(await ani.waitFor((n) => n.includes(TOOL)) && !(await ani.names()).some((n) => n.endsWith(`__${TOOL}`)), `ani sees ${TOOL} under the same bare name (no ${ANI}__ rename)`);
  // back to an unpromoted private draft so ani's next publish sends her newest version, as in real use
  await hive(ANI).capabilities.updateOne({ _id: TOOL }, { $set: { activeVersion: null, "versions.0.status": "unverified", updatedAt: new Date() } });

  await ani.call("pin_capability", { id: TOOL, hive: HIVE, version: 1 });
  const named = await kap.call(TOOL, bad.args);
  check(named.version === 1 && /promoted v1/.test(named.ran), `kap calls ${TOOL} by name on a different input: ${named.ran}`);
  const fb2 = await giveFeedback({ h: hive(HIVE), outputId: named.outputId, by: KAP, verdict: "wrong", correction: bad.expect });
  check(fb2.ok && fb2.queuedImprove, `kap rejects with the right answer: ${fb2.ok ? fb2.summary : fb2.error}`);

  // ani's improvement (the worker's role): scored only on evals ani didn't author, i.e. kap's two
  const before = kap.changed();
  const p2 = await ani.call("propose_capability", { id: TOOL, directive: src.directive, scope: src.scope, collection: v2.collection, params: v2.params, pipeline: v2.pipeline, whenToUse: v2.whenToUse });
  const pub2 = await ani.call("publish_capability", { id: TOOL, to_hive: HIVE });
  check(pub2.published && pub2.version === 2, `ani's v${p2.version} published: ${pub2.reason}`);

  const again = await kap.call(TOOL, bad.args);
  check(again.version === 2 && /promoted v2/.test(again.ran) && /v1 → v2/.test(again.updated ?? ""), `kap's same-name call: ${again.ran} | ${again.updated}`);
  check(isDeepStrictEqual(again.result, [bad.expect]), "v2 gives the answer kap said was right");
  check(kap.changed() === before, "compatible promotion sent no list_changed");
  const pinned = await ani.call(TOOL, bad.args);
  check(pinned.version === 1 && /pinned v1/.test(pinned.ran), `ani stays pinned: ${pinned.ran}`);

  await ani.mcp.close(); await kap.mcp.close();
} catch (e) {
  failed++;
  console.error("FAIL", e);
} finally {
  await drop();
  await client.close();
}
console.log(failed ? `${failed} check(s) failed` : "slice verified");
process.exit(failed ? 1 : 0);
