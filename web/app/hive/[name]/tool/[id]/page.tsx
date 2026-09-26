import Link from "next/link";
import { notFound } from "next/navigation";
import { Top, ago, clock } from "@/components/Top";
import { Score, StandingPill } from "@/components/Standing";
import { pinVersion, publishVersion } from "@/app/actions";
import { agentsOf, openHiveFor, primaryAgent, rank, standingFor, viewer, visibleHives, type CapabilityVersion } from "@/lib/hive";

export const dynamic = "force-dynamic";

type Moment = { at: Date; cls: string; text: React.ReactNode };

export default async function ToolPage({ params, searchParams }: PageProps<"/hive/[name]/tool/[id]">) {
  const { name, id } = await params;
  const sp = await searchParams;
  const as = await viewer();
  const found = await openHiveFor(as, name);
  if (!found) notFound();
  const { info, h } = found;
  const cap = await h.capabilities.findOne({ _id: id });
  if (!cap) notFound();

  const [agents, evals, events, mine] = await Promise.all([
    agentsOf(h),
    h.evaluations.find({ capId: id }).sort({ at: -1 }).limit(12).toArray(),
    h.events.find({ "args.id": id }).sort({ at: -1 }).limit(40).toArray(),
    visibleHives(as),
  ]);
  const ranked = rank(cap);
  const rankOf = new Map(ranked.map((v, i) => [v.v, i + 1]));
  // leaderboard first, then everything that didn't make it (unverified, rejected, archived), newest first
  const rest = cap.versions.filter((v) => !rankOf.has(v.v)).sort((a, b) => b.v - a.v);
  const rows: CapabilityVersion[] = [...ranked, ...rest];
  const me = primaryAgent(agents, as, id);
  const myStanding = standingFor(cap, me);
  const pinnedV = me?.pinned?.[id] ?? null;
  const top = ranked[0];
  const shown = cap.versions.find((v) => v.v === (Number(sp.v) || top?.v || cap.versions.at(-1)?.v)) ?? cap.versions.at(-1);
  const sharedTargets = mine.filter((x) => x.info.visibility === "shared" && x.info._id !== name).map((x) => x.info._id);

  // the tool's history: versions created, how each was judged, who ran/pinned/published it
  const moments: Moment[] = [
    ...cap.versions.map((v) => ({
      at: new Date(v.createdAt),
      cls: v.status === "active" ? "good" : v.status === "rejected" ? "bad" : v.status === "unverified" ? "honey" : "",
      text: (
        <>
          <b className="mono">v{v.v}</b> {v.publishedFrom ? `published from ${v.publishedFrom.hive} v${v.publishedFrom.v}` : "proposed"} by <span className="mono">{v.author}</span> <span className="faint">({v.harness})</span>{" "}
          <span className={`pill ${v.status}`}>{v.status === "active" ? "took #1" : v.status}</span>{" "}
          <span className="muted">{v.reason}</span>
        </>
      ),
    })),
    ...events
      .filter((e) => e.tool === "run_capability" || e.tool === "pin_capability" || e.tool === "keep_version" || e.tool === "dismiss_version")
      .map((e) => {
        const a = e.args as { v?: number; version?: number | null };
        return {
          at: new Date(e.at),
          cls: e.tool === "run_capability" ? "info" : "",
          text: (
            <>
              <span className="mono">{e.user}</span> <span className="faint">({e.harness})</span>{" "}
              {e.tool === "run_capability" ? `ran v${a.v}` : e.tool === "pin_capability" ? (a.version ? `pinned v${a.version}` : "unpinned") : e.tool === "keep_version" ? `kept v${a.v}` : `dismissed v${a.v}`}
            </>
          ),
        };
      }),
  ].sort((a, b) => +b.at - +a.at);

  return (
    <>
      <Top as={as} crumbs={[{ href: `/hive/${name}`, label: name }, { href: `/hive/${name}/tool/${id}`, label: id }]} here={`/hive/${name}/tool/${id}`} />
      <main>
        {sp.flash && <div className={`banner ${sp.ok === "1" ? "good" : "bad"}`}>{String(sp.flash)}</div>}
        <h1 className="mono" style={{ fontSize: 20 }}>{id}</h1>
        <p className="sub"><span className="clamp" title={cap.directive}>{cap.directive}</span> <span className="faint">· hive {name} ({info.visibility}) · scope {cap.scope}</span></p>
        <div className="actions" style={{ marginBottom: 8 }}>
          <span className="muted">you ({as}):</span> <StandingPill s={myStanding} />
          {pinnedV != null && (
            <form action={pinVersion}><input type="hidden" name="hive" value={name} /><input type="hidden" name="id" value={id} /><button className="ghost">Unpin</button></form>
          )}
        </div>

        <h2>Leaderboard</h2>
        <div className="scroll"><table>
          <thead><tr><th>#</th><th>version</th><th>status</th><th>score</th><th>by</th><th>hash</th><th>when</th><th></th></tr></thead>
          <tbody>
            {rows.map((v) => {
              const r = rankOf.get(v.v);
              return (
                <tr key={v.v} className={r === 1 ? "lead" : ""}>
                  <td className="rank">{r ? `#${r}` : "–"}</td>
                  <td><Link href={`/hive/${name}/tool/${id}?v=${v.v}`} className="mono">v{v.v}</Link>{pinnedV === v.v && <span className="pill pinned" style={{ marginLeft: 6 }}>your pin</span>}</td>
                  <td><span className={`pill ${v.status}`}>{v.status}</span>{v.status === "rejected" && <div className="muted" style={{ fontSize: 12 }}>{v.reason}</div>}</td>
                  <td><Score s={v.score} /></td>
                  <td className="muted">{v.author} · {v.harness}</td>
                  <td className="mono faint">{v.hash.replace("sha256:", "").slice(0, 10)}</td>
                  <td className="faint">{ago(v.createdAt)}</td>
                  <td>
                    {v.status !== "rejected" && v.status !== "archived" && pinnedV !== v.v && (
                      <form action={pinVersion}><input type="hidden" name="hive" value={name} /><input type="hidden" name="id" value={id} /><input type="hidden" name="v" value={v.v} /><button className="ghost">Pin</button></form>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table></div>

        {info.visibility === "private" && info.owner === as && (
          <>
            <h2>Publish</h2>
            {sharedTargets.length === 0 ? <div className="empty">You aren&apos;t in any shared hive yet.</div> : (
              <form action={publishVersion} className="actions">
                <input type="hidden" name="hive" value={name} /><input type="hidden" name="id" value={id} />
                <select name="v" defaultValue={shown?.v}>
                  {cap.versions.filter((v) => v.status !== "rejected" && v.status !== "archived").map((v) => <option key={v.v} value={v.v}>v{v.v} ({v.status})</option>)}
                </select>
                <span className="muted">to</span>
                <select name="to">{sharedTargets.map((t) => <option key={t}>{t}</option>)}</select>
                <button className="primary">Publish</button>
                <span className="faint" style={{ fontSize: 12.5 }}>Only the recipe travels. That hive&apos;s hidden cases decide if it leads.</span>
              </form>
            )}
          </>
        )}

        <div className="two">
          <section>
            <h2>History</h2>
            <ul className="tl">
              {moments.map((m, i) => <li key={i} className={m.cls}><span className="when">{clock(m.at)}</span>{m.text}</li>)}
            </ul>
          </section>
          <section>
            <h2>Recipe {shown && <span className="mono" style={{ textTransform: "none" }}>v{shown.v}</span>}</h2>
            {shown && (
              <>
                <dl className="kv">
                  <dt>collection</dt><dd className="mono">{shown.collection}</dd>
                  <dt>params</dt><dd className="mono">{Object.entries(shown.params).map(([k, t]) => `${k}: ${t}`).join(", ") || "none"}</dd>
                  <dt>when to use</dt><dd>{shown.whenToUse}</dd>
                  {shown.publishedFrom && <><dt>published from</dt><dd className="mono">{shown.publishedFrom.hive} v{shown.publishedFrom.v}</dd></>}
                </dl>
                <pre className="recipe">{JSON.stringify(shown.pipeline, null, 2)}</pre>
              </>
            )}
            <h2>Evaluations</h2>
            {evals.length === 0 ? <div className="empty">No hidden-case runs in this hive yet.</div> : (
              <table>
                <thead><tr><th>when</th><th>version</th><th>result</th></tr></thead>
                <tbody>
                  {evals.map((e) => (
                    <tr key={String(e._id)}>
                      <td className="faint">{clock(e.at)}</td>
                      <td className="mono">v{e.v}</td>
                      <td><span className={`pill ${e.total && e.passed === e.total ? "active" : "rejected"}`}>{e.passed}/{e.total}</span> <span className="faint num">{e.ms}ms</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </div>
      </main>
    </>
  );
}
