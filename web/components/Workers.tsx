import { clock } from "@/components/Top";
import { CellTrail, KindChip, VArrow, WorkerChip } from "@/components/ui";
import { workerActivity, type WorkerCard } from "@/lib/console";

// workers section (#46 B): the same component for private and shared hives; one row per tool, running first.
export async function Workers({ name }: { name: string }) {
  const { cards, running, queued } = await workerActivity(name);
  return (
    <section className="workers-sec">
      <h2 className="h-sec">Workers <span className="faint">· {running} running · {queued} queued</span></h2>
      {cards.length === 0 ? <WorkersIdle /> : (
        <div className="jobs pane">{cards.slice(0, 8).map((c) => <WorkerRow key={c.id} c={c} />)}</div>
      )}
    </section>
  );
}

function WorkersIdle() {
  return (
    <div className="worker-idle">
      <svg width="32" height="32" viewBox="0 0 32 32" fill="none" aria-hidden="true"><path d="m16 3 11.3 6.5v13L16 29 4.7 22.5v-13Z" stroke="currentColor" /><path d="m16 10 5.2 3v6L16 22l-5.2-3v-6Z" fill="currentColor" opacity=".25" /></svg>
      <span>No workers running</span>
    </div>
  );
}

// one card: whose worker, which tool (or whose session it's reading), the version arrow, then the stage trail.
// a check names the one version it checks instead of an arrow. older attempts on the same tool stay folded under it.
export function WorkerRow({ c }: { c: WorkerCard }) {
  return (
    <div className={`job ${c.stage === "done" ? "finished" : ""} ${c.needsPerson ? "needs-person" : ""}`}>
      <div className="job-top">
        <WorkerChip user={c.workerOf} live={c.stage !== "done"} />
        <KindChip kind={c.kind} fromV={c.fromV} />
        <span className="mono job-title">{c.title}{c.tool && (c.kind === "checking" ? (c.v != null ? <> · v{c.v}</> : null) : <> · <VArrow from={c.fromV} to={c.v} /></>)}</span>
        <span className="spacer" />
        <span className="faint small" title={c.model ?? undefined}>{clock(c.updatedAt)}</span>
      </div>
      <div className="job-bottom">
        <CellTrail stage={c.stage} label={c.label} outcome={c.outcome} />
      </div>
      {c.older.length > 0 && (
        <details className="older small">
          <summary className="faint">{c.older.length} earlier job{c.older.length === 1 ? "" : "s"}</summary>
          <ul>{c.older.map((o) => <li key={o.id} className="faint">{o.kind} <span className="mono">{o.v != null ? `v${o.v}` : ""}</span> {o.label} · {clock(o.updatedAt)}</li>)}</ul>
        </details>
      )}
    </div>
  );
}
