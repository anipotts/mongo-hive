import Link from "next/link";
import { notFound } from "next/navigation";
import { Top } from "@/components/Top";
import { CombCanvas, type CombTool } from "@/components/CombCanvas";
import { workerActivity } from "@/lib/console";
import { agentsOf, openHiveFor, primaryAgent, rank, standingFor, viewer, type Standing } from "@/lib/hive";

export const dynamic = "force-dynamic";

const VARIANTS = { a: "comb + panel", b: "scope clusters", c: "zoom into cell" } as const;
type Variant = keyof typeof VARIANTS;

const label = (s: Standing | null) =>
  !s ? null : s.state === "on_best" ? "up to date" : s.state === "better_available" ? `update available · v${s.best}` : s.state === "yours_beats_team" ? "yours is better, publish it" : `pinned v${s.v}`;

// the honeycomb as a bounded, pannable canvas: every cell is a tool (three variations to compare)
export default async function CombPage({ params, searchParams }: PageProps<"/hive/[name]/comb">) {
  const { name } = await params;
  const sp = await searchParams;
  const variant: Variant = sp.v === "b" || sp.v === "c" ? sp.v : "a";
  const as = await viewer();
  const found = await openHiveFor(as, name);
  if (!found) notFound();
  const { h } = found;

  const [caps, agents, work, keys, runs] = await Promise.all([
    h.capabilities.find().toArray(),
    agentsOf(h),
    workerActivity(name, 60),
    h.answerKeys.aggregate<{ _id: string; n: number }>([{ $project: { n: { $size: "$cases" } } }]).toArray(),
    h.outputs.aggregate<{ _id: string; n: number; last: Date }>([{ $group: { _id: "$capId", n: { $sum: 1 }, last: { $max: "$at" } } }]).toArray(),
  ]);

  const tools: CombTool[] = caps.map((c) => {
    const top = rank(c)[0];
    const job = work.active.find((j) => j.tool === c._id);
    const run = runs.find((r) => r._id === c._id);
    return {
      id: c._id,
      directive: c.directive,
      scope: c.scope,
      head: top ? { v: top.v, passed: top.score!.passed, total: top.score!.total, ms: top.score!.ms, by: top.harness === "worker" ? `${top.author}'s worker` : top.author } : null,
      versions: c.versions.length,
      rejected: c.versions.filter((v) => v.status === "rejected").length,
      evals: keys.find((k) => k._id === c._id)?.n ?? 0,
      runs: run?.n ?? 0,
      lastRun: run?.last ? new Date(run.last).toISOString() : null,
      standing: label(standingFor(c, primaryAgent(agents, as, c._id))),
      job: job ? { stage: job.stage, kind: job.kind, v: job.v ?? null, by: job.workerOf } : null,
      updatedAt: new Date(c.updatedAt).toISOString(),
    };
  });

  return (
    <>
      <Top as={as} crumbs={[{ href: `/hive/${name}`, label: name }, { href: `/hive/${name}/comb`, label: "honeycomb" }]} />
      <main className="comb-main">
        <div className="comb-bar">
          <h1 className="hive-title" style={{ margin: 0 }}>{name}&apos;s honeycomb</h1>
          <span className="faint small">{tools.length} tools · drag to pan · scroll to zoom · click a cell</span>
          <span className="spacer" />
          <nav className="seg" aria-label="variation">
            {(Object.keys(VARIANTS) as Variant[]).map((k) => (
              <Link key={k} href={`/hive/${name}/comb?v=${k}`} className={k === variant ? "on" : ""}>{k.toUpperCase()} · {VARIANTS[k]}</Link>
            ))}
          </nav>
        </div>
        <CombCanvas key={variant} variant={variant} tools={tools} hive={name} />
      </main>
    </>
  );
}
