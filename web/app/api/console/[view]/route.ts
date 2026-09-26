import { NextResponse } from "next/server";
import { canAccess, hives } from "../../../../../src/registry/db";
import { catalog, feed, roster, sessionDetail, toolPage, toolStates, workerActivity } from "@/lib/console";
import { viewer } from "@/lib/hive";

export const dynamic = "force-dynamic";

// console-v2 json for the ui (poll every 3s). one route, one view per path segment:
//   /api/console/me                         who this machine is
//   /api/console/catalog                    every tool across visible hives
//   /api/console/feed?hive=team[&since=iso] activity (lines + collapsed bursts) + sessions
//   /api/console/session?hive=team&id=...   the hook events behind one session line
//   /api/console/roster?hive=team           agents, online, standing per tool
//   /api/console/tool?hive=team&id=...      leaderboard, timeline, diff, pins, evals, tests, worker jobs
//   /api/console/worker?hive=team           worker_jobs: active first, then recent
//   /api/console/states?hive=team           one state + next step per tool (counts only, never eval inputs)
export async function GET(req: Request, { params }: { params: Promise<{ view: string }> }) {
  const { view } = await params;
  const q = new URL(req.url).searchParams;
  const me = await viewer();
  if (view === "me") return NextResponse.json({ user: me });
  if (view === "catalog") return NextResponse.json(await catalog(me));

  const name = q.get("hive") ?? "";
  if (!canAccess(await hives.findOne({ _id: name }), me)) return NextResponse.json({ error: `no hive ${name} for ${me}` }, { status: 404 });
  switch (view) {
    case "feed": return NextResponse.json(await feed(name, { since: q.get("since") ? new Date(q.get("since")!) : undefined }));
    case "session": return NextResponse.json(await sessionDetail(name, q.get("id") ?? ""));
    case "roster": return NextResponse.json(await roster(name));
    case "worker": return NextResponse.json(await workerActivity(name));
    case "states": return NextResponse.json(await toolStates(name));
    case "tool": {
      const page = await toolPage(name, q.get("id") ?? "");
      return page ? NextResponse.json(page) : NextResponse.json({ error: "no such tool" }, { status: 404 });
    }
  }
  return NextResponse.json({ error: `unknown view ${view}` }, { status: 404 });
}
