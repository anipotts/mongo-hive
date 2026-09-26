// one-off: backfill nextVersion for capabilities created before atomic version reservation
import { capabilities, client } from "../src/registry/db.js";
const r = await capabilities.updateMany({ nextVersion: { $exists: false } }, [{ $set: { nextVersion: { $size: "$versions" } } }]);
console.log("backfilled", r.modifiedCount);
await client.close();
