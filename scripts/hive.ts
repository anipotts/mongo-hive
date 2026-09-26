// manage hives in the honeycomb.
//   hive create <name> --private|--shared [--owner u]   hive invite <name> <user>   hive list
//   hive delete <name> --yes   (owner only; drops hive_<name> and its registry entry)
import { client, ensureHive, hives, HIVE_USER } from "../src/registry/db.js";

const [cmd, name, ...rest] = process.argv.slice(2);
const flag = (f: string) => rest.includes(f);
const opt = (f: string) => (rest.includes(f) ? rest[rest.indexOf(f) + 1] : undefined);

if (cmd === "create" && name) {
  const info = await ensureHive(name, flag("--shared") ? "shared" : "private", opt("--owner") ?? HIVE_USER);
  console.log(`hive ${info?._id} (${info?.visibility}) owner=${info?.owner} members=${info?.members.join(",")} db=hive_${info?._id}`);
} else if (cmd === "invite" && name && rest[0]) {
  const info = await hives.findOne({ _id: name });
  if (!info) throw new Error(`no hive ${name}`);
  if (info.visibility !== "shared") throw new Error(`hive ${name} is private; only shared hives take members`);
  await hives.updateOne({ _id: name }, { $addToSet: { members: rest[0] } });
  console.log(`invited ${rest[0]} to ${name}`);
} else if (cmd === "delete" && name) {
  const info = await hives.findOne({ _id: name });
  if (!info) throw new Error(`no hive ${name}`);
  if (info.owner !== HIVE_USER) throw new Error(`only the owner (${info.owner}) can delete hive ${name}; you are ${HIVE_USER}`);
  if (name === "team") throw new Error("team is the demo hive; use npm run demo:reset instead");
  if (!flag("--yes")) {
    const db = client.db(`hive_${name}`);
    const count = async (c: string) => db.collection(c).countDocuments();
    console.log(`hive ${name}: ${await count("capabilities")} tools, ${await count("sessions")} sessions, ${await count("events")} events. this cannot be undone.`);
    console.log(`run again with --yes to delete it: npm run hive -- delete ${name} --yes`);
  } else {
    await client.db(`hive_${name}`).dropDatabase();
    await hives.deleteOne({ _id: name });
    console.log(`deleted hive ${name} (database hive_${name} dropped)`);
  }
} else if (cmd === "list") {
  for (const h of await hives.find().sort({ _id: 1 }).toArray())
    console.log(`${h._id.padEnd(10)} ${h.visibility.padEnd(8)} owner=${h.owner} members=${h.members.join(",")}`);
} else {
  console.log("usage: hive create <name> --private|--shared [--owner u] | invite <name> <user> | delete <name> --yes | list");
}
await client.close();
