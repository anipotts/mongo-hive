import { notFound } from "next/navigation";
import { Top, clock, stamp } from "@/components/Top";
import { Avatar, ScoreRing, StandingTag } from "@/components/ui";
import { WorkerRow } from "@/components/Workers";
import { pinVersion, publishVersion } from "@/app/actions";
import { toolPage } from "@/lib/console";
import { recipeDiff } from "@/lib/versions";
import { agentsOf, openHiveFor, primaryAgent, standingFor, viewer, visibleHives } from "@/lib/hive";

export const dynamic = "force-dynamic";

// tool page, docs/wireframes/02-tool.svg: the tool on the left, its version history on the right,
// newest first with whoever is working + testing on top
export default async function ToolPage({ params, searchParams }: PageProps<"/hive/[name]/tool/[id]">) {
  const { name, id } = await params;
  const sp = await searchParams;
  const as = await viewer();
  const found = await openHiveFor(as, name);
  if (!found) notFound();
  const { info, h } = found;
  const [cap, page, agents, mine] = await Promise.all([h.capabilities.findOne({ _id: id }), toolPage(name, id), agentsOf(h), visibleHives(as)]);
  if (!cap || !page) notFound();

  const me = primaryAgent(agents, as, id);
  const myStanding = standingFor(cap, me);
  const pinnedV = me?.pinned?.[id] ?? null;
  const promoted = cap.versions.find((v) => v.v === cap.activeVersion);
  const card = page.worker[0]; // one card per tool (#46 A); older attempts fold inside it
  const sharedTargets = mine.filter((x) => x.info.visibility === "shared" && x.info._id !== name).map((x) => x.info._id);
  const who = (author: string, harness: string) => (harness === "worker" ? `${author}'s worker` : author);

  // fold runs of consecutive rejected versions into one line so the promoted version stays in view
  type V = (typeof page.versions)[number];
  const groups: ({ kind: "one"; v: V } | { kind: "rejected"; vs: V[] })[] = [];
  for (const v of page.versions) {
    const last = groups.at(-1);
    if (v.status === "rejected" && last?.kind === "rejected") last.vs.push(v);
    else groups.push(v.status === "rejected" ? { kind: "rejected", vs: [v] } : { kind: "one", v });
  }

  const row = (v: V) => {
    const d = recipeDiff(cap, v.v);
    const full = cap.versions.find((x) => x.v === v.v)!;
    const p = v.provenance;
    const open = sp.v ? Number(sp.v) === v.v : false; // a scannable list by default; ?v= opens one
    return (
      <details key={v.v} className={`vrow ${v.status}`} open={open}>
        <summary>
          <span className="mono vnum">v{v.v}</span>
          {v.status === "active" ? <span className="pill active">promoted</span> : <span className={`pill ${v.status}`}>{v.status === "superseded" && v.supersededBy ? `superseded by v${v.supersededBy}` : v.status}</span>}
          <ScoreRing s={v.score} size={34} />
          <span className="muted small"><Avatar user={v.author} size={16} /> {who(v.author, v.harness)} · <span title={stamp(v.createdAt)}>{clock(v.createdAt)}</span></span>
          {pinnedV === v.v && <span className="pill pinned">your pin</span>}
          <span className="spacer" /><span className="chev faint">⌄</span>
        </summary>
        <div className="vprov small">
          {p.replaced ? <>replaced v{p.replaced.v} ({p.replaced.score ? `${p.replaced.score.passed}/${p.replaced.score.total}` : "unscored"})</> : v.status === "rejected" ? <>vs promoted v{cap.activeVersion ?? "–"}</> : <>first version</>}
          {p.fixed.length > 0 && <> · fixed: <span className="good">{p.fixed.join(", ")}</span></>}
          {p.stillFails.length > 0 && <> · still fails: <span className="bad">{p.stillFails.join(", ")}</span></>}
          {v.status === "rejected" && v.reason && <span className="faint"> · {v.reason}</span>}
        </div>
        <div className="vbody small">
          {d && d.from != null && d.changed.length > 0 && (
            <details className="impl">
              <summary className="muted">view changes vs v{d.from}</summary>
              <pre className="diff">{d.lines.filter((l) => l.op !== "same").slice(0, 40).map((l, i) => <span key={i} className={l.op}>{l.op === "add" ? "+ " : "- "}{l.text}{"\n"}</span>)}</pre>
            </details>
          )}
          {(v.runningOn.length > 0 || v.pinnedBy.length > 0) && (
            <div className="muted">
              {v.runningOn.length > 0 && <>running on {v.runningOn.join(", ")}</>}
              {v.runningOn.length > 0 && v.pinnedBy.length > 0 && " · "}
              {v.pinnedBy.length > 0 && <>pinned by {v.pinnedBy.join(", ")}</>}
            </div>
          )}
          <details className="impl"><summary className="muted">implementation ({full.collection})</summary><pre className="recipe">{JSON.stringify(full.pipeline, null, 2)}</pre></details>
          {v.status !== "rejected" && v.status !== "archived" && pinnedV !== v.v && (
            <form action={pinVersion}><input type="hidden" name="hive" value={name} /><input type="hidden" name="id" value={id} /><input type="hidden" name="v" value={v.v} /><button className="ghost">Pin v{v.v}</button></form>
          )}
        </div>
      </details>
    );
  };

  return (
    <>
      <Top as={as} crumbs={[{ href: `/hive/${name}`, label: name }, { href: `/hive/${name}/tool/${id}`, label: id }]} />
      <main className="wide fit">
        {sp.flash && <div className={`banner toast ${sp.ok === "1" ? "good" : "bad"}`}>{String(sp.flash)}</div>}
        <div className="toolpage">
          <section className="tp-left pane">
            <h1 className="mono">{id}</h1>
            {/* the answer first: which version runs, how it scores, who made it, where you stand */}
            <div className="actions tp-summary">
              {promoted ? <><span className="mono">v{promoted.v}</span><ScoreRing s={promoted.score} size={34} /><span className="muted small">{who(promoted.author, promoted.harness)}</span></> : <span className="faint">nothing promoted yet</span>}
              <StandingTag s={myStanding} />
              {pinnedV != null && <form action={pinVersion}><input type="hidden" name="hive" value={name} /><input type="hidden" name="id" value={id} /><button className="ghost">Unpin</button></form>}
            </div>

            <h2>Leaderboard</h2>
            {page.leaderboard.length === 0 ? <div className="empty small">Nothing has passed enough evals to be promoted.</div> : (
              <table className="small">
                <tbody>
                  {page.leaderboard.map((r) => (
                    <tr key={r.v} className={r.rank === 1 ? "lead" : ""}>
                      <td className="rank">#{r.rank}</td>
                      <td className="mono">v{r.v}</td>
                      <td><ScoreRing s={r.score} size={34} /></td>
                      <td className="muted">{r.score?.ms}ms · {who(r.author, r.harness)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            <details className="fold">
              <summary className="muted small">what it does · use cases</summary>
              <p className="muted small">{cap.directive}</p>
              <p className="muted small">{promoted?.whenToUse ?? cap.versions.at(-1)?.whenToUse ?? "–"}</p>
            </details>
            <details className="fold">
              <summary className="muted small">evals · {page.evals.length} ({[...new Set(page.evals.map((e) => e.source))].join(", ") || "none"})</summary>
            {page.evals.length === 0 ? <div className="empty small">No evals yet. Feedback on a run adds one.</div> : (
              <table className="small">
                <thead><tr><th>#</th><th>category</th><th>source</th><th>added by</th></tr></thead>
                <tbody>
                  {page.evals.map((e) => (
                    <tr key={e.n}>
                      <td className="faint">{e.n}</td>
                      <td className="mono">{e.category ?? "–"}{e.provisional && <span className="pill unverified" style={{ marginLeft: 6 }}>provisional</span>}</td>
                      <td className={e.source === "seed" ? "muted" : "good"}>{e.source}</td>
                      <td className="muted">{e.addedBy === "seed" ? "seed" : <><Avatar user={e.addedBy} size={16} /> {e.addedBy}{e.addedAt ? ` · ${clock(e.addedAt)}` : ""}</>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            </details>

            {info.visibility === "private" && info.owner === as && (
              <>
                <h2>Publish</h2>
                {sharedTargets.length === 0 ? <div className="empty small">You aren&apos;t in any shared hive yet.</div> : (
                  <form action={publishVersion} className="actions">
                    <input type="hidden" name="hive" value={name} /><input type="hidden" name="id" value={id} />
                    <select name="v" defaultValue={cap.activeVersion ?? cap.versions.at(-1)?.v}>
                      {cap.versions.filter((v) => v.status !== "rejected" && v.status !== "archived").map((v) => <option key={v.v} value={v.v}>v{v.v} ({v.status})</option>)}
                    </select>
                    <span className="muted">to</span>
                    <select name="to">{sharedTargets.map((t) => <option key={t}>{t}</option>)}</select>
                    <button className="primary">Publish</button>
                  </form>
                )}
              </>
            )}
          </section>

          <section className="tp-right pane">
            <h2 className="h-sec">Version history</h2>
            {card && <div className="jobs">{<WorkerRow c={card} />}</div>}
            {groups.map((g, i) =>
              g.kind === "one" ? row(g.v) : g.vs.length === 1 ? row(g.vs[0]) : (
                <details key={`r${i}`} className="rgroup">
                  <summary className="faint small">v{g.vs.at(-1)!.v}–v{g.vs[0].v} rejected ({g.vs.length}) · show</summary>
                  {g.vs.map(row)}
                </details>
              ),
            )}
          </section>
        </div>
      </main>
    </>
  );
}
