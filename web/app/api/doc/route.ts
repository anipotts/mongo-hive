import { NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { canAccess, hive, hives } from "../../../../src/registry/db";
import { PEEKABLE, atlasUrl, idFilter, type Peekable } from "@/lib/atlas";
import { viewer } from "@/lib/hive";

export const dynamic = "force-dynamic";

// fields that can carry an eval's expected answer (a "wrong" verdict's correction becomes one) never leave the server
const HIDDEN = new Set(["expect", "correction", "cases", "evalSuite"]);
const MAX_KEYS = 12;

function trim(x: unknown, depth = 0): unknown {
  if (x instanceof ObjectId) return String(x);
  if (x instanceof Date) return x.toISOString();
  if (typeof x === "string") return x.length > 160 ? `${x.slice(0, 160)}…` : x;
  if (Array.isArray(x)) return depth > 1 ? `[${x.length} items]` : [...x.slice(0, 5).map((v) => trim(v, depth + 1)), ...(x.length > 5 ? [`…${x.length - 5} more`] : [])];
  if (x && typeof x === "object") {
    if (depth > 2) return "{…}";
    const entries = Object.entries(x).filter(([k]) => !HIDDEN.has(k));
    const out: Record<string, unknown> = Object.fromEntries(entries.slice(0, MAX_KEYS).map(([k, v]) => [k, trim(v, depth + 1)]));
    if (entries.length > MAX_KEYS) out["…"] = `${entries.length - MAX_KEYS} more fields`;
    return out;
  }
  return x;
}

// /api/doc?hive=team&coll=outputs&id=...  one document, trimmed, for the console's hover preview
export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const name = q.get("hive") ?? "", coll = q.get("coll") ?? "", id = q.get("id") ?? "";
  if (!PEEKABLE.includes(coll as Peekable)) return NextResponse.json({ error: `not viewable: ${coll}` }, { status: 403 });
  if (!canAccess(await hives.findOne({ _id: name }), await viewer())) return NextResponse.json({ error: `no hive ${name}` }, { status: 404 });
  const c = hive(name).db.collection(coll);
  const doc = (await c.findOne({ _id: id as any })) ?? (ObjectId.isValid(id) && id.length === 24 ? await c.findOne({ _id: new ObjectId(id) }) : null);
  if (!doc) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ ns: `hive_${name}.${coll}`, filter: idFilter(id), atlas: atlasUrl(name, coll as Peekable), doc: trim(doc) });
}
