import { clock } from "@/components/Top";
import { CellTrail, KindChip, VArrow, WorkerChip } from "@/components/ui";
import { workerActivity, type WorkerCard } from "@/lib/console";

// workers section (#46 B): the same component for private and shared hives; one row per tool, running first.
export async function Workers({ name }: { name: string }) {
  const { cards, running } = await workerActivity(name);
  return (
    <section className="workers-sec">
      <h2 className="h-sec">Workers <span className="faint">{running} running</span></h2>
      {cards.length === 0 ? <div className="faint small">idle</div> : (
        <div className="jobs">{cards.slice(0, 4).map((c) => <WorkerRow key={c.id} c={c} />)}</div>
      )}
    </section>
  );
}

// one card: whose worker, which tool (or whose session it's reading), the version arrow, then the stage trail.
// older attempts on the same tool stay folded under it, never top-level.
export function WorkerRow({ c }: { c: WorkerCard }) {
  return (
    <div className={`job ${c.stage === "done" ? "finished" : ""}`}>
      <div className="job-top">
        <WorkerChip user={c.workerOf} live={c.stage !== "done"} />
        <KindChip kind={c.kind} fromV={c.fromV} />
        <span className="mono job-title">{c.title}{c.tool && <> · <VArrow from={c.fromV} to={c.v} /></>}</span>
        <span className="spacer" />
        <span className="faint small" title={c.model ?? undefined}>{clock(c.updatedAt)}</span>
      </div>
      <div className="job-bottom">
        <CellTrail stage={c.stage} label={c.label} outcome={c.outcome} />
      </div>
      {c.older.length > 0 && (
        <details className="older small">
          <summary className="faint">{c.older.length} earlier attempt{c.older.length === 1 ? "" : "s"}</summary>
          <ul>{c.older.map((o) => <li key={o.id} className="faint"><span className="mono">v{o.v}</span> {o.label} · {clock(o.updatedAt)}</li>)}</ul>
        </details>
      )}
    </div>
  );
}
