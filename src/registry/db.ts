// honeycomb = the cluster. a hive = one database (`hive_<name>`) holding its own tools, tests and traces.
// the `honeycomb` db lists hives and who belongs to them. domain work data lives in DATA_DB.
import { MongoClient } from "mongodb";
import type { AnswerKey, Capability, HiveAgent, HiveInfo } from "./types.js";

const uri = process.env.MONGODB_URI;
if (!uri) throw new Error("MONGODB_URI is not set");

export const client = new MongoClient(uri, { appName: "mongo-hive", maxPoolSize: 10 });

// work data the agents investigate (ci_*, inc_*, dep_*)
export const db = client.db(process.env.DATA_DB ?? process.env.MONGODB_DB ?? "harness");

export const honeycomb = client.db("honeycomb");
export const hives = honeycomb.collection<HiveInfo>("hives");

export const HIVE_USER = process.env.HIVE_USER ?? process.env.USER ?? "unknown";
export const HIVE_HARNESS = process.env.HIVE_HARNESS ?? "unknown";
export const AGENT_ID = `${HIVE_USER}:${HIVE_HARNESS}`;
// your private hive; proposals land here first
export const HIVE_HOME = (process.env.HIVE_HOME ?? HIVE_USER).replace(/^hive_/, "");

export function hive(name: string) {
  const d = client.db(`hive_${name.replace(/^hive_/, "")}`);
  return {
    name: name.replace(/^hive_/, ""),
    db: d,
    capabilities: d.collection<Capability>("capabilities"),
    answerKeys: d.collection<AnswerKey>("answer_keys"),
    agents: d.collection<HiveAgent>("agents"),
    events: d.collection("events"),
    runs: d.collection("runs"),
    evaluations: d.collection("evaluations"),
  };
}
export type Hive = ReturnType<typeof hive>;

export const canAccess = (info: HiveInfo | null, user: string) =>
  !!info && (info.owner === user || info.members.includes(user));

// hives this user can see: their own plus shared hives they belong to
export async function myHives(user = HIVE_USER): Promise<HiveInfo[]> {
  return hives.find({ $or: [{ owner: user }, { members: user }] }).toArray();
}

export async function ensureHive(name: string, visibility: HiveInfo["visibility"], owner: string, members: string[] = []) {
  await hives.updateOne(
    { _id: name },
    { $setOnInsert: { visibility, owner, createdAt: new Date() }, $addToSet: { members: { $each: [owner, ...members] } } },
    { upsert: true },
  );
  return hives.findOne({ _id: name });
}

// seeds and older scripts write hidden cases into the shared team hive
export const SEED_HIVE = hive(process.env.SEED_HIVE ?? "team");
export const answerKeys = SEED_HIVE.answerKeys;
export const capabilities = SEED_HIVE.capabilities;
export const agents = SEED_HIVE.agents;
export const events = SEED_HIVE.events;
export const runs = SEED_HIVE.runs;
export const evaluations = SEED_HIVE.evaluations;
