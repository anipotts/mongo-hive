import { MongoClient } from "mongodb";

const uri = process.env.MONGODB_URI;
if (!uri) throw new Error("MONGODB_URI is not set");

export const client = new MongoClient(uri);
export const db = client.db(process.env.MONGODB_DB ?? "harness");

export const runs = db.collection("runs");
export const events = db.collection("events");
export const capabilities = db.collection("capabilities");
export const evaluations = db.collection("evaluations");
export const harnessVersions = db.collection("harness_versions");
