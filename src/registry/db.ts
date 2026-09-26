import { MongoClient } from "mongodb";
import type { AnswerKey, Capability, HiveAgent } from "./types.js";

const uri = process.env.MONGODB_URI;
if (!uri) throw new Error("MONGODB_URI is not set");

export const client = new MongoClient(uri, { appName: "mongo-hive", maxPoolSize: 10 });
export const db = client.db(process.env.MONGODB_DB ?? "harness");

export const runs = db.collection("runs");
export const events = db.collection("events");
export const capabilities = db.collection<Capability>("capabilities");
export const answerKeys = db.collection<AnswerKey>("answer_keys");
export const agents = db.collection<HiveAgent>("agents");
export const evaluations = db.collection("evaluations");

export const HIVE_USER = process.env.HIVE_USER ?? process.env.USER ?? "unknown";
export const HIVE_HARNESS = process.env.HIVE_HARNESS ?? "unknown";
export const AGENT_ID = `${HIVE_USER}:${HIVE_HARNESS}`;
