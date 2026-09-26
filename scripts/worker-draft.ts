// one worker draft of a brand-new tool from its directive (what the in-session trigger will do automatically).
// usage: npm run worker-draft -- --hive team --id advisory_owners --scope deps --collection dep_advisories \
//          --param advisory_id:string --directive "..."
import { HIVE_USER, client, hive } from "../src/registry/db.js";
import type { CapabilityVersion } from "../src/registry/types.js";
import { claim, draftAndCommit, enqueue, outputFields } from "../src/worker/index.js";

const arg = (k: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
const h = hive(arg("--hive") ?? "team");
const id = arg("--id")!;
const params: CapabilityVersion["params"] = Object.fromEntries(
  (arg("--param") ?? "").split(",").filter(Boolean).map((p) => p.split(":") as [string, "string" | "number"]),
);
const job = await enqueue(h, { trigger: "session_end", capId: id, note: "manual draft from scripts/worker-draft.ts" });
await claim(h, job._id);
const res = await draftAndCommit({
  h, cap: { _id: id, directive: arg("--directive")!, scope: arg("--scope") ?? "general" }, params,
  collection: arg("--collection")!, output: await outputFields(h, id), job: (await h.workerJobs.findOne({ _id: job._id }))!,
});
console.log(res ? `${HIVE_USER}'s worker drafted ${res.summary}${res.failing.length ? ` (failing: ${res.failing.join(", ")})` : ""}` : "draft unusable");
await client.close();
