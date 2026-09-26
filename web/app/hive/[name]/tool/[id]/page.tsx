import { notFound } from "next/navigation";
import { Top, clock, stamp } from "@/components/Top";
import { AtlasDoc } from "@/components/AtlasDoc";
import { Avatar, ScoreRing, StandingTag, StatePill } from "@/components/ui";
import { WorkerRow } from "@/components/Workers";
import { pinVersion, publishVersion } from "@/app/actions";
import { evalSource, evalWord, feed, standingLabel, toolPage } from "@/lib/console";
import { ActivityFeed } from "@/components/Overview";
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
  const [cap, page, agents, mine, activity] = await Promise.all([h.capabilities.findOne({ _id: id }), toolPage(name, id), agentsOf(h), visibleHives(as), feed(name, { tool: id })]);
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
          <span className={`mono vnum ${v.status === "active" ? "lead" : ""}`}>v{v.v}</span>
          {v.status === "active" ? <span className="pill active">promoted</span> : <span className={`pill ${v.status}`}>{v.status === "superseded" && v.supersededBy ? `superseded by v${v.supersededBy}` : v.status}</span>}
          <ScoreRing s={v.score} />
          <span className="muted small"><Avatar user={v.author} size={16} /> {who(v.author, v.harness)} · <span title={stamp(v.createdAt)}>{clock(v.createdAt)}</span></span>
          {pinnedV === v.v && <span className="pill pinned">your pin</span>}
          <span className="spacer" /><AtlasDoc hive={name} coll="capabilities" id={id} />
        </summary>
        <div className="vprov small">
          {p.replaced ? <>replaced v{p.replaced.v} ({evalWord(p.replaced.score)})</> : v.status === "rejected" ? <>vs promoted v{cap.activeVersion ?? "–"}</> : <>first version</>}
          {p.fixed.length > 0 && <> · fixed: <span className="good">{p.fixed.join(", ")}</span></>}
          {p.stillFails.length > 0 && <> · still fails: <span className="bad">{p.stillFails.join(", ")}</span></>}
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

  const lead = page.leaderboard[0];
  const callV = promoted ?? cap.versions.filter((v) => v.status !== "rejected" && v.status !== "archived").at(-1);
  const sig = callV ? `${id}({ ${Object.entries(callV.params).map(([k, t]) => `${k}: ${t}`).join(", ")} })` : id;

  return (
    <>
      <Top as={as} crumbs={[{ href: `/hive/${name}`, label: name }, { href: `/hive/${name}/tool/${id}`, label: id }]} />
      <main className="wide fit">
        {sp.flash && <div className={`banner toast ${sp.ok === "1" ? "good" : "bad"}`}>{String(sp.flash)}</div>}
        <div className="toolpage">
          {/* left: what it is, how agents call it, what it's been doing. the questions a visitor asks first */}
          <section className="tp-left">
            <header className="tp-head">
              <div className="tp-title">
                <h1 className="mono">{id}</h1>
                {page.state && <StatePill st={page.state} inline extra={`your standing: ${standingLabel(myStanding) ?? "not used yet"}`} />}
              </div>
              <p className="muted tp-desc" title={cap.directive}>{cap.directive}</p>
            </header>

            <div className="panel tp-call">
              <div className="panel-label">call it</div>
              <code className="mono tp-sig">{sig}</code>
              <div className="tp-meta small">
                {callV ? <>
                  <span className="mono">v{callV.v}</span>
                  <span className="muted">{promoted ? "promoted" : "untested draft"}</span>
                  <ScoreRing s={callV.score} />
                  <span className="muted"><Avatar user={callV.author} size={16} /> {who(callV.author, callV.harness)}</span>
                </> : <span className="faint">no runnable version</span>}
                <span className="spacer" />
                <StandingTag s={myStanding} />
                {pinnedV != null && <form action={pinVersion}><input type="hidden" name="hive" value={name} /><input type="hidden" name="id" value={id} /><button className="ghost">Unpin</button></form>}
              </div>
            </div>

            <div className="tp-runs">
              <h2 className="h-sec">Activity <span className="faint">judge a run to add an eval</span></h2>
              <div className="panel pane tp-feed">
                <ActivityFeed groups={activity.groups} name={name} back={`/hive/${name}/tool/${id}`} pane={false} />
              </div>
            </div>

            {info.visibility === "private" && info.owner === as && sharedTargets.length > 0 && (
              <form action={publishVersion} className="panel tp-publish small">
                <span className="panel-label">publish</span>
                <input type="hidden" name="hive" value={name} /><input type="hidden" name="id" value={id} />
                <select name="v" defaultValue={cap.activeVersion ?? cap.versions.at(-1)?.v}>
                  {cap.versions.filter((v) => v.status !== "rejected" && v.status !== "archived").map((v) => <option key={v.v} value={v.v}>v{v.v}</option>)}
                </select>
                <span className="muted">to</span>
                <select name="to">{sharedTargets.map((t) => <option key={t}>{t}</option>)}</select>
                <button className="primary">Publish</button>
              </form>
            )}
          </section>

          {/* right: how it got here. worker now, versions ranked, evals behind one click */}
          <section className="tp-right pane">
            <h2 className="h-sec">Versions <span className="faint">{cap.versions.length} · {lead ? `v${lead.v} leads` : "none promoted yet"}</span></h2>
            {card && <WorkerRow c={card} />}
            <div className="vlist">
              {groups.map((g, i) =>
                g.kind === "one" ? row(g.v) : g.vs.length === 1 ? row(g.vs[0]) : (
                  <details key={`r${i}`} className="rgroup">
                    <summary className="faint small">v{g.vs.at(-1)!.v}–v{g.vs[0].v} · {g.vs.length} rejected</summary>
                    {g.vs.map(row)}
                  </details>
                ),
              )}
            </div>
            <details className="panel tp-evals">
              <summary className="small"><span className="panel-label">evals</span> {page.evals.length === 0 ? <span className="faint">none yet: judging a run adds one, so does a worker check that agrees</span> : <span className="muted">{page.evals.length} · {evalMix(page.evals)}</span>}</summary>
              {page.evals.length > 0 && (
                <table className="small compact">
                  <thead><tr><th>#</th><th>category</th><th>source</th><th>added by</th></tr></thead>
                  <tbody>
                    {page.evals.map((e) => (
                      <tr key={e.n}>
                        <td className="faint">{e.n}</td>
                        <td className="mono">{e.category ?? "–"}</td>
                        <td className={evalSource(e.source).tone ? `t-${evalSource(e.source).tone}` : "muted"}>{evalSource(e.source).label}{e.provisional ? " · provisional" : ""}</td>
                        <td className="muted">{e.addedBy === "seed" ? "seed" : <>{e.addedBy}{e.addedAt ? ` · ${clock(e.addedAt)}` : ""}</>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </details>
          </section>
        </div>
      </main>
    </>
  );
}

// "8 seeded, 2 feedback, 3 auto-check": the three kinds of eval stay distinguished even in the summary
function evalMix(evals: { source: string }[]) {
  const n = (f: (s: string) => boolean) => evals.filter((e) => f(e.source)).length;
  const parts: [number, string][] = [
    [n((s) => s === "seed"), "seeded"],
    [n((s) => s === "accepted_run" || s === "corrected_run"), "feedback"],
    [n((s) => s === "worker_agreement"), "auto-check"],
  ];
  return parts.filter(([k]) => k > 0).map(([k, w]) => `${k} ${w}`).join(", ");
}
