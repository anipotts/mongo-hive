import { hive, hives } from "../../../../src/registry/db";

export const dynamic = "force-dynamic";

// a single "something changed" stamp across the viewer's hives: newest event + newest tool update
export async function GET(req: Request) {
  const as = new URL(req.url).searchParams.get("as") ?? "ani";
  const list = await hives.find({ $or: [{ owner: as }, { members: as }] }, { projection: { _id: 1 } }).toArray();
  const stamps = await Promise.all(
    list.map(async ({ _id }) => {
      const h = hive(_id);
      const [e, c] = await Promise.all([
        h.events.find({}, { projection: { at: 1 } }).sort({ at: -1 }).limit(1).next(),
        h.capabilities.find({}, { projection: { updatedAt: 1 } }).sort({ updatedAt: -1 }).limit(1).next(),
      ]);
      return `${_id}:${e?.at?.getTime?.() ?? 0}:${c?.updatedAt ? new Date(c.updatedAt).getTime() : 0}`;
    }),
  );
  return Response.json({ stamp: stamps.join("|") });
}
