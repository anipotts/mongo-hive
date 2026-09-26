import Link from "next/link";
import { notFound } from "next/navigation";
import { Top, ago, stamp } from "@/components/Top";
import { HarnessIcon, harnessLabel } from "@/lib/harness";
import { StandingPill } from "@/components/Standing";
import { dismissVersion, keepVersion } from "@/app/actions";
import { agentsOf, openHiveFor, standingFor, viewer } from "@/lib/hive";
import { hive } from "../../../../src/registry/db";
import { Overview } from "@/components/Overview";

export const dynamic = "force-dynamic";


export default async function HivePage({ params, searchParams }: PageProps<"/hive/[name]">) {
  const { name } = await params;
  const sp = await searchParams;
  const as = await viewer();
  const found = await openHiveFor(as, name);
  if (!found) notFound();
  const { info, h } = found;

  const [caps, agents] = await Promise.all([h.capabilities.find().sort({ updatedAt: -1 }).toArray(), agentsOf(h)]);
  // drafts always live in the viewer's own private hive
  const drafts = (await hive(as).capabilities.find({ "versions.status": "unverified" }).toArray()).flatMap((c) =>
    c.versions.filter((v) => v.status === "unverified").map((v) => ({ cap: c, v })),
  );

  // the roster is people first, their agents nested beneath; every member shows even before they connect
  const people = [...new Set([info.owner, ...info.members])];
  const agentsBy = (u: string) => agents.filter((a) => a.user === u).sort((a, b) => +new Date(b.lastSeen) - +new Date(a.lastSeen));

  // one screen, no tabs: honeycomb, workers, members (and your drafts when there are any) on the left, activity on the right
  const members = (
    <section>
      <h2 className="h-sec">Members &amp; agents <span className="faint">{people.length} people</span></h2>
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
    </section>
  );

  const inbox = drafts.length > 0 && (
    <section>
      <h2 className="h-sec">Your drafts <span className="faint">in your private hive <Link href={`/hive/${as}`} className="mono">{as}</Link> · trusted only once they pass evals</span></h2>
      <div className="scroll"><table>
        <thead><tr><th>draft</th><th>from</th><th>when</th><th>why unverified</th><th></th></tr></thead>
        <tbody>
          {drafts.map(({ cap, v }) => (
            <tr key={`${cap._id}:${v.v}`}>
              <td><Link href={`/hive/${as}/tool/${cap._id}`} className="mono">{cap._id} v{v.v}</Link>{v.kept && <span className="pill pinned" style={{ marginLeft: 6 }}>kept</span>}
                <div className="muted small">{v.whenToUse}</div></td>
              <td className="muted">{v.author} · {v.harness}</td>
              <td className="faint">{ago(v.createdAt)}</td>
              <td className="muted small">{v.reason}</td>
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
    </section>
  );

  return (
    <>
      <Top as={as} crumbs={[{ href: `/hive/${name}`, label: name }]} />
      <main className="wide">
        {sp.flash && <div className={`banner ${sp.ok === "1" ? "good" : "bad"}`}>{String(sp.flash)}</div>}
        <h1 className="hive-title">{name} <span className={`pill ${info.visibility}`}>{info.visibility}</span></h1>
        <Overview name={name} as={as} caps={caps} agents={agents} extra={<>{inbox}{members}</>} />
      </main>
    </>
  );
}
