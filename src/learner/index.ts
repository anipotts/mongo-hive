// turns a recipe + args into a safe, read-only aggregation.
import { createHash } from "node:crypto";
import { BSON, type Db } from "mongodb";
import type { CapabilityVersion } from "../registry/types.js";

const FORBIDDEN = new Set(["$out", "$merge", "$function", "$accumulator", "$where"]);

export function assertReadOnly(node: unknown): void {
  if (Array.isArray(node)) return node.forEach(assertReadOnly);
  if (node && typeof node === "object")
    for (const [k, v] of Object.entries(node)) {
      if (FORBIDDEN.has(k)) throw new Error(`stage/operator ${k} is not allowed (read-only hive)`);
      assertReadOnly(v);
    }
}

export function bind(node: unknown, args: Record<string, unknown>): unknown {
  if (typeof node === "string") {
    const whole = node.match(/^\{\{(\w+)\}\}$/);
    if (whole) {
      if (!(whole[1] in args)) throw new Error(`missing arg ${whole[1]}`);
      return args[whole[1]];
    }
    return node.replace(/\{\{(\w+)\}\}/g, (_, k) => String(args[k]));
  }
  if (Array.isArray(node)) return node.map((n) => bind(n, args));
  if (node && typeof node === "object") return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, bind(v, args)]));
  return node;
}

export const hashRecipe = (collection: string, pipeline: object[]) =>
  "sha256:" + createHash("sha256").update(JSON.stringify({ collection, pipeline })).digest("hex").slice(0, 16);

// agents write extended json ({"$date": ...}); turn it into real bson before it reaches the server
export const fromEjson = <T>(pipeline: T): T => BSON.EJSON.deserialize(pipeline as any, { relaxed: true }) as T;

export async function execute(db: Db, version: Pick<CapabilityVersion, "collection" | "pipeline">, args: Record<string, unknown>) {
  assertReadOnly(version.pipeline);
  const pipeline = fromEjson(bind(version.pipeline, args) as object[]);
  return db.collection(version.collection).aggregate(pipeline, { maxTimeMS: 10_000 }).limit(50).toArray();
}
