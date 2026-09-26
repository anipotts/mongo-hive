import Link from "next/link";
import { notFound } from "next/navigation";
import { Top, ago, clock, stamp } from "@/components/Top";
import { HarnessIcon, harnessLabel } from "@/lib/harness";
import { Score, StandingPill } from "@/components/Standing";
import { dismissVersion, keepVersion } from "@/app/actions";
import { agentsOf, openHiveFor, primaryAgent, rank, standingFor, viewer } from "@/lib/hive";
import { hive } from "../../../../src/registry/db";
import { eventName, eventTool } from "@/lib/events";

export const dynamic = "force-dynamic";

const TABS = ["tools", "inbox", "members", "activity"] as const;
type Tab = (typeof TABS)[number];

export default async function HivePage({ params, searchParams }: PageProps<"/hive/[name]">) {
  const { name } = await params;
  const sp = await searchParams;
  const tab: Tab = TABS.includes(sp.tab as Tab) ? (sp.tab as Tab) : "tools";
  const view: "columns" | "unified" = sp.view === "unified" ? "unified" : "columns";
  const as = await viewer();
  const found = await openHiveFor(as, name);
  if (!found) notFound();
  const { info, h } = found;

  const [caps, agents, events] = await Promise.all([
    h.capabilities.find().sort({ updatedAt: -1 }).toArray(),
    agentsOf(h),
    h.events.find().sort({ at: -1 }).limit(200).toArray() as Promise<Ev[]>,
  ]);
  // drafts always live in the viewer's own private hive
  const home = hive(as);
  const drafts = (await home.capabilities.find({ "versions.status": "unverified" }).toArray()).flatMap((c) =>
    c.versions.filter((v) => v.status === "unverified").map((v) => ({ cap: c, v })),
  );

  // the roster is people first, their agents nested beneath; every member shows even before they connect
  const people = [...new Set([info.owner, ...info.members])];
  const agentsBy = (u: string) => agents.filter((a) => a.user === u).sort((a, b) => +new Date(b.lastSeen) - +new Date(a.lastSeen));
  const counts: Record<Tab, number> = { tools: caps.length, inbox: drafts.length, members: people.length, activity: events.length };

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
          <div className="scroll"><table>
            <thead><tr><th>member / agent</th><th>last seen</th>{caps.map((c) => <th key={c._id} className="mono" style={{ textTransform: "none" }}>{c._id}</th>)}</tr></thead>
            <tbody>
              {people.map((u) => {
                const mine = agentsBy(u);
                const last = mine[0]?.lastSeen;
                return [
                  <tr key={u} className="person">
                    <td><span className={`av av-${u}`}>{u[0]}</span> <b>{u}</b> <span className="faint">· {u === info.owner ? "owner" : "member"}</span></td>
                    <td className="faint" title={last ? stamp(last) : undefined}>{last ? ago(last) : "never"}</td>
                    {caps.map((c) => <td key={c._id} />)}
                  </tr>,
                  ...(mine.length === 0
                    ? [<tr key={`${u}-none`} className="child"><td className="faint" colSpan={2 + caps.length}>no agents connected</td></tr>]
                    : mine.map((a) => (
                        <tr key={a._id} className="child">
                          <td title={`${a._id} · harness=${a.harness}`}><HarnessIcon harness={a.harness} /> {harnessLabel(a.harness)}</td>
                          <td className="faint" title={stamp(a.lastSeen)}>{ago(a.lastSeen)}</td>
                          {caps.map((c) => <td key={c._id}><StandingPill s={standingFor(c, a)} /></td>)}
                        </tr>
                      ))),
                ];
              })}
            </tbody>
          </table></div>
        )}

        {tab === "activity" && (
          <>
            <nav className="seg" aria-label="activity view">
              <Link href={`/hive/${name}?tab=activity&view=columns`} className={view === "columns" ? "on" : ""}>side by side</Link>
              <Link href={`/hive/${name}?tab=activity&view=unified`} className={view === "unified" ? "on" : ""}>unified</Link>
            </nav>
            {events.length === 0 ? <div className="empty">Quiet so far.</div> : view === "unified" ? (
              <EventList events={events} showWho />
            ) : (
              <div className="lanes" style={{ gridTemplateColumns: `repeat(${people.length}, minmax(260px, 1fr))` }}>
                {people.map((u) => {
                  const mine = events.filter((e) => e.user === u);
                  return (
                    <section key={u} className="lane">
                      <h3><span className={`av av-${u}`}>{u[0]}</span> {u} <span className="faint num">{mine.length}</span></h3>
                      {mine.length ? <EventList events={mine} /> : <div className="empty">No activity from {u} yet.</div>}
                    </section>
                  );
                })}
              </div>
            )}
          </>
        )}
      </main>
    </>
  );
}

type Ev = { _id: unknown; at: Date; user?: string; harness?: string; kind?: string; tool?: string; sessionId?: string; runId?: string; args?: unknown; result?: unknown };

// one row grammar for both views: time · (who) · what · result; hover shows the raw identifiers
function EventList({ events, showWho = false }: { events: Ev[]; showWho?: boolean }) {
  return (
    <ul className="tl">
      {events.map((e) => {
        const r = (e.result ?? {}) as { status?: string; score?: { passed: number; total: number } };
        const cls = r.status === "active" ? "good" : r.status === "rejected" ? "bad" : eventTool(e) === "run_capability" ? "info" : /propose|publish/.test(eventTool(e)) ? "honey" : "";
        const a = (e.args && typeof e.args === "object" ? e.args : {}) as Record<string, unknown>;
        const what = a.id ? `${a.id}${a.v ? ` v${a.v}` : ""}` : a.collection ? `on ${a.collection}` : a.task ? `“${String(a.task).slice(0, 80)}”` : "";
        const tip = [stamp(e.at), `event=${String(e._id)}`, `${e.user}:${e.harness}`, e.kind ? `kind=${e.kind}` : "", e.tool ? `tool=${e.tool}` : "", e.sessionId ? `session=${e.sessionId}` : e.runId ? `run=${e.runId}` : ""].filter(Boolean).join("\n");
        return (
          <li key={String(e._id)} className={cls} title={tip}>
            <span className="when">{clock(e.at)}</span>
            {showWho && <><span className="mono">{e.user}</span>{" "}</>}
            <HarnessIcon harness={e.harness ?? ""} size={12} /> {eventName(e)} <span className="muted">{what}</span>
            {r.status && <> <span className={`pill ${r.status}`}>{r.status}</span></>}
            {r.score?.total ? <span className="num faint"> {r.score.passed}/{r.score.total}</span> : null}
          </li>
        );
      })}
    </ul>
  );
}
