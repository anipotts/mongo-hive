import { hive, hives } from "../../../../src/registry/db";
import { viewer } from "@/lib/hive";

export const dynamic = "force-dynamic";

// a single "something changed" stamp across the viewer's hives: newest event, tool update, worker step and run
export async function GET() {
  const as = await viewer();
  const list = await hives.find({ $or: [{ owner: as }, { members: as }] }, { projection: { _id: 1 } }).toArray();
  const stamps = await Promise.all(
    list.map(async ({ _id }) => {
      const h = hive(_id);
      const [e, c, j, o] = await Promise.all([
        h.events.find({}, { projection: { at: 1 } }).sort({ at: -1 }).limit(1).next(),
        h.capabilities.find({}, { projection: { updatedAt: 1 } }).sort({ updatedAt: -1 }).limit(1).next(),
        h.workerJobs.find({}, { projection: { updatedAt: 1 } }).sort({ updatedAt: -1 }).limit(1).next(),
        h.outputs.find({}, { projection: { at: 1, feedback: 1 } }).sort({ at: -1 }).limit(1).next(),
      ]);
      const t = (d?: Date | string | null) => (d ? new Date(d).getTime() : 0);
      // worker steps and judged runs move the ui too, not just events and promotions
      return `${_id}:${t(e?.at)}:${t(c?.updatedAt)}:${t(j?.updatedAt)}:${t(o?.at)}:${o?.feedback ? 1 : 0}`;
    }),
  );
  return Response.json({ stamp: stamps.join("|") });
}
