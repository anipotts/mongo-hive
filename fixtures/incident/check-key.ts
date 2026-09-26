// double-checks the blame_deploy key with an independent aggregation (does not propose anything).
import { answerKeys, client, db } from "../../src/registry/db.js";
import { execute } from "../../src/learner/index.js";

const pipeline = [
  { $match: { _id: "{{service}}" } },
  { $lookup: { from: "inc_deploys", let: { svcs: { $concatArrays: [["$_id"], "$depends_on"] }, t: { $dateFromString: { dateString: "{{spike_start}}" } } },
    pipeline: [
      { $match: { $expr: { $and: [{ $in: ["$service", "$$svcs"] }, { $eq: ["$status", "succeeded"] }, { $lte: ["$at", "$$t"] }, { $gte: ["$at", { $dateSubtract: { startDate: "$$t", unit: "minute", amount: 30 } }] }] } } },
      { $sort: { at: -1 } }, { $limit: 1 }] , as: "c" } },
  { $project: { _id: 0, culprit_deploy_id: { $ifNull: [{ $first: "$c._id" }, null] }, rollback: { $and: [{ $gt: [{ $size: "$c" }, 0] }, { $ne: [{ $first: "$c.kind" }, "config"] }] } } },
];
const key = await answerKeys.findOne({ _id: "blame_deploy" });
let ok = 0;
for (const c of key!.cases) {
  const out = await execute(db, { collection: "inc_services", pipeline }, c.args);
  const pass = JSON.stringify(out[0]) === JSON.stringify(c.expect);
  ok += +pass;
  if (!pass) console.log("MISMATCH", c.args, out[0], c.expect);
}
console.log(`reference pipeline: ${ok}/${key!.cases.length}`);
await client.close();
