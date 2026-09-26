import Link from "next/link";
import { notFound } from "next/navigation";
import { Top, ago, clock } from "@/components/Top";
import { Score, StandingPill } from "@/components/Standing";
import { dismissVersion, keepVersion } from "@/app/actions";
import { agentsOf, openHiveFor, primaryAgent, rank, standingFor, viewer } from "@/lib/hive";
import { hive } from "../../../../src/registry/db";

export const dynamic = "force-dynamic";

const TABS = ["tools", "inbox", "members", "activity"] as const;
type Tab = (typeof TABS)[number];

export default async function HivePage({ params, searchParams }: PageProps<"/hive/[name]">) {
  const { name } = await params;
  const sp = await searchParams;
  const tab: Tab = TABS.includes(sp.tab as Tab) ? (sp.tab as Tab) : "tools";
  const as = await viewer();
  const found = await openHiveFor(as, name);
  if (!found) notFound();
  const { info, h } = found;

  const [caps, agents, events] = await Promise.all([
    h.capabilities.find().sort({ updatedAt: -1 }).toArray(),
    agentsOf(h),
    h.events.find().sort({ at: -1 }).limit(60).toArray(),
  ]);
  // drafts always live in the viewer's own private hive
  const home = hive(as);
  const drafts = (await home.capabilities.find({ "versions.status": "unverified" }).toArray()).flatMap((c) =>
    c.versions.filter((v) => v.status === "unverified").map((v) => ({ cap: c, v })),
  );

  const counts: Record<Tab, number> = { tools: caps.length, inbox: drafts.length, members: agents.length, activity: events.length };

  return (
    <>
      <Top as={as} crumbs={[{ href: `/hive/${name}`, label: name }]} here={`/hive/${name}`} />
      <main>
        <h1 style={{ display: "flex", alignItems: "center", gap: 10 }}>
          hive {name} <span className={`pill ${info.visibility}`}>{info.visibility}</span>
        </h1>
        <p className="sub">
          {info.visibility === "shared"
            ? `Shared by ${info.members.join(", ")}. A version leads only while it tops this hive's hidden tests.`
            : `${info.owner}'s private hive. Drafts land here first; publish one to a shared hive to let it compete.`}
        </p>
        <nav className="tabs">
          {TABS.map((t) => (
            <Link key={t} href={`/hive/${name}?tab=${t}`} className={t === tab ? "on" : ""}>
              {t === "members" ? "members & agents" : t}
              <span className="n">{counts[t]}</span>
            </Link>
          ))}
        </nav>

        {tab === "tools" && (
          caps.length === 0 ? <div className="empty">No tools yet. An agent calls propose_capability after solving something.</div> : (
            <div className="scroll"><table>
              <thead><tr><th>tool</th><th>#1</th><th>score</th><th>by</th><th>versions</th><th>you ({as})</th></tr></thead>
              <tbody>
                {caps.map((c) => {
                  const top = rank(c)[0];
                  const latest = c.versions.at(-1);
                  return (
                    <tr key={c._id}>
                      <td>
                        <Link href={`/hive/${name}/tool/${c._id}`} className="mono" style={{ fontWeight: 600 }}>{c._id}</Link>
                        <div className="muted clamp" style={{ fontSize: 12.5, maxWidth: 420 }} title={c.directive}>{c.directive}</div>
                      </td>
                      <td className="num">{top ? `v${top.v}` : <span className={`pill ${latest?.status}`}>{latest?.status}</span>}</td>
                      <td><Score s={top?.score} /></td>
                      <td className="muted">{top ? `${top.author} · ${top.harness}` : latest ? `${latest.author} · ${latest.harness}` : "–"}</td>
                      <td className="num">{c.versions.length}</td>
                      <td><StandingPill s={standingFor(c, primaryAgent(agents, as, c._id))} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table></div>
          )
        )}

        {tab === "inbox" && (
          <>
            <p className="muted" style={{ marginTop: 0 }}>
              Drafts your agents proposed in your private hive <Link href={`/hive/${as}`} className="mono">{as}</Link>. Keep the ones worth keeping; dismissed drafts are archived, never deleted. A draft becomes trusted only after it passes hidden cases.
            </p>
            {drafts.length === 0 ? <div className="empty">Inbox zero. New drafts appear here as your agents work.</div> : (
              <div className="scroll"><table>
                <thead><tr><th>draft</th><th>from</th><th>when</th><th>why unverified</th><th></th></tr></thead>
                <tbody>
                  {drafts.map(({ cap, v }) => (
                    <tr key={`${cap._id}:${v.v}`}>
                      <td><Link href={`/hive/${as}/tool/${cap._id}`} className="mono">{cap._id} v{v.v}</Link>{v.kept && <span className="pill pinned" style={{ marginLeft: 6 }}>kept</span>}
                        <div className="muted" style={{ fontSize: 12.5 }}>{v.whenToUse}</div></td>
                      <td className="muted">{v.author} · {v.harness}</td>
                      <td className="faint">{ago(v.createdAt)}</td>
                      <td className="muted" style={{ fontSize: 12.5 }}>{v.reason}</td>
                      <td>
                        <div className="actions">
                          {!v.kept && <form action={keepVersion}><input type="hidden" name="hive" value={as} /><input type="hidden" name="id" value={cap._id} /><input type="hidden" name="v" value={v.v} /><button>Keep</button></form>}
                          <form action={dismissVersion}><input type="hidden" name="hive" value={as} /><input type="hidden" name="id" value={cap._id} /><input type="hidden" name="v" value={v.v} /><button className="ghost danger">Dismiss</button></form>
                          <Link href={`/hive/${as}/tool/${cap._id}`}><button className="ghost">Publish…</button></Link>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table></div>
            )}
          </>
        )}

        {tab === "members" && (
          agents.length === 0 ? <div className="empty">No agents have connected to this hive yet.</div> : (
            <div className="scroll"><table>
              <thead><tr><th>agent</th><th>last seen</th>{caps.map((c) => <th key={c._id} className="mono" style={{ textTransform: "none" }}>{c._id}</th>)}</tr></thead>
              <tbody>
                {agents.map((a) => (
                  <tr key={a._id}>
                    <td><span className="mono">{a.user}</span> <span className="faint">· {a.harness}</span></td>
                    <td className="faint">{ago(a.lastSeen)}</td>
                    {caps.map((c) => <td key={c._id}><StandingPill s={standingFor(c, a)} /></td>)}
                  </tr>
                ))}
              </tbody>
            </table></div>
          )
        )}

        {tab === "activity" && (
          events.length === 0 ? <div className="empty">Quiet so far.</div> : (
            <ul className="tl">
              {events.map((e) => {
                const r = (e.result ?? {}) as { status?: string; score?: { passed: number; total: number } };
                const cls = r.status === "active" ? "good" : r.status === "rejected" ? "bad" : e.tool === "run_capability" ? "info" : e.tool.includes("propose") || e.tool.includes("publish") ? "honey" : "";
                const a = (e.args ?? {}) as Record<string, unknown>;
                const what = a.id ? `${a.id}${a.v ? ` v${a.v}` : ""}` : a.collection ? `on ${a.collection}` : a.task ? `“${String(a.task).slice(0, 80)}”` : "";
                return (
                  <li key={String(e._id)} className={cls}>
                    <span className="when">{clock(e.at)}</span>
                    <span className="mono">{e.user}</span> <span className="faint">({e.harness})</span> {String(e.tool).replace(/_/g, " ")} <span className="muted">{what}</span>
                    {r.status && <> <span className={`pill ${r.status}`}>{r.status}</span></>}
                    {r.score?.total ? <span className="num faint"> {r.score.passed}/{r.score.total}</span> : null}
                  </li>
                );
              })}
            </ul>
          )
        )}
      </main>
    </>
  );
}
