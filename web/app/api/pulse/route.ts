import { hive, hives } from "../../../../src/registry/db";
import { viewer } from "@/lib/hive";

export const dynamic = "force-dynamic";

// a single "something changed" stamp across the viewer's hives: newest event, tool update, worker step, run and check.
// why each part is there (Live.tsx refreshes the page whenever the stamp changes):
// - worker jobs: every step write (queued → drafting → validating → proposed | skipped) sets updatedAt, so a check
//   job's stage change moves t(j) on its own.
// - outputs.check: a check writes { agree, by, at, jobId } onto runs that are usually NOT the newest output, so the
//   newest-output part below would miss it, and waiting for the job's final updatedAt would make every agreement
//   appear at once at the end. max(check.at) moves the stamp at each write, so "needs judgment" marks show live.
//   (no index on check.at: outputs are a few hundred docs per hive, and a limit(1) sort is a top-k scan.)
// - feedback on an older run also writes a `feedback` event, so t(e) covers it.
export async function GET() {
  const as = await viewer();
  const list = await hives.find({ $or: [{ owner: as }, { members: as }] }, { projection: { _id: 1 } }).toArray();
  const stamps = await Promise.all(
    list.map(async ({ _id }) => {
      const h = hive(_id);
      const [e, c, j, o, k] = await Promise.all([
        h.events.find({}, { projection: { at: 1 } }).sort({ at: -1 }).limit(1).next(),
        h.capabilities.find({}, { projection: { updatedAt: 1 } }).sort({ updatedAt: -1 }).limit(1).next(),
        h.workerJobs.find({}, { projection: { updatedAt: 1, step: 1 } }).sort({ updatedAt: -1 }).limit(1).next(),
        h.outputs.find({}, { projection: { at: 1, feedback: 1 } }).sort({ at: -1 }).limit(1).next(),
        h.outputs.find({ "check.at": { $exists: true } } as any, { projection: { "check.at": 1 } }).sort({ "check.at": -1 }).limit(1).next(),
      ]);
      const t = (d?: Date | string | null) => (d ? new Date(d).getTime() : 0);
      const checkAt = (k as { check?: { at?: Date } } | null)?.check?.at;
      return `${_id}:${t(e?.at)}:${t(c?.updatedAt)}:${t(j?.updatedAt)}:${j?.step ?? ""}:${t(o?.at)}:${o?.feedback ? 1 : 0}:${t(checkAt)}`;
    }),
  );
  return Response.json({ stamp: stamps.join("|") });
}
