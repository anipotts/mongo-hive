import Link from "next/link";
import { clock, stamp } from "@/components/Top";
import { Avatar, CellTrail, KindChip, ScoreRing, StandingTag, VArrow, WorkerChip } from "@/components/ui";
import { giveRunFeedback } from "@/app/actions";
import { HarnessIcon, harnessLabel } from "@/lib/harness";
import { feed, workerActivity, type Line, type SessionLine } from "@/lib/console";
import { primaryAgent, rank, standingFor, type Capability, type HiveAgent } from "@/lib/hive";

export type Person = { user: string; role: "owner" | "member" };

// hive page on one screen (kap, #6): three panes that each scroll on their own, the page never does.
//   1. honeycomb + workers (+ your drafts)   2. people, each with their agent sessions nested   3. hive changes
export async function Overview({ name, as, caps, agents, people, extra }: { name: string; as: string; caps: Capability[]; agents: HiveAgent[]; people: Person[]; extra?: React.ReactNode }) {
  const [{ changes, sessions }, work] = await Promise.all([feed(name), workerActivity(name, 30)]);
  const finished = work.recent;
  const last = finished[0];
  return (
    <div className="overview3">
      <div className="pane ov-col">
        <section>
          <h2 className="h-sec">Honeycomb <span className="faint">{caps.length} tools · open one for its history</span> <span className="spacer" /><Link href={`/hive/${name}/comb`} className="small muted">canvas view →</Link></h2>
          {caps.length === 0 ? <div className="empty small">No tools yet. When an agent solves something, it proposes a tool and it lands here.</div> : (
            <table className="compact">
              <tbody>
                {caps.map((c) => {
                  const top = rank(c)[0];
                  return (
                    <tr key={c._id}>
                      <td className="tool-cell">
                        <Link href={`/hive/${name}/tool/${c._id}`} className="mono tool-name">{c._id}</Link>
                        <div className="muted small one-line" title={c.directive}>{c.directive}</div>
                      </td>
                      <td className="num small">{top ? `v${top.v}` : <span className="faint">–</span>}</td>
                      <td><ScoreRing s={top?.score} size={34} /></td>
                      <td><StandingTag s={standingFor(c, primaryAgent(agents, as, c._id))} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </section>

        <section>
          <h2 className="h-sec">Workers <span className="faint">{work.active.length} running</span></h2>
          {work.active.map((j) => (
            <div key={j.id} className="job">
              <div className="job-head">
                {j.workerOf ? <WorkerChip user={j.workerOf} live /> : <span className="muted">worker</span>}
                <KindChip kind={j.kind} fromV={j.fromV} />
                <span className="spacer" />
                <span className="muted small">{j.kind === "new tool" ? "new tool" : j.toolOwner ? `${j.toolOwner}'s tool` : ""}</span>
              </div>
              <div className="mono job-title">{j.tool ?? "untitled"} · <VArrow from={j.kind === "new tool" ? null : j.fromV} to={j.v} /></div>
              <CellTrail stage={j.stage} label={jobLabel(j)} />
            </div>
          ))}
          {work.active.length === 0 && <div className="faint small">No worker running. Feedback on a wrong answer queues one.</div>}
          {finished.length > 0 && (
            <details className="finished-line small">
              <summary className="muted">{finished.length} finished · last: <span className="mono">{last.tool} v{last.v}</span> <span className={last.outcome === "promoted" ? "good" : "bad"}>{last.outcome}</span></summary>
              <ul className="feed">{finished.map((j) => (
                <li key={j.id} className="muted"><span className="mono">{j.tool} v{j.v}</span> · <span className={j.outcome === "promoted" ? "good" : "bad"}>{j.outcome}</span> · {j.note}</li>
              ))}</ul>
            </details>
          )}
        </section>
        {extra}
      </div>

      <div className="pane ov-col">
        <h2 className="h-sec">People <span className="faint">{sessions.filter((s) => s.online).length} agent sessions live</span></h2>
        {people.map((p) => <PersonBlock key={p.user} p={p} sessions={sessions.filter((s) => s.actor.user === p.user)} agents={agents.filter((a) => a.user === p.user)} caps={caps} />)}
      </div>

      <div className="pane ov-col">
        <h2 className="h-sec">Hive changes</h2>
        {changes.length === 0 ? <div className="empty small">Quiet so far.</div> : (
          <ul className="feed">{changes.slice(0, 60).map((l) => <ChangeRow key={l.id} l={l} name={name} />)}</ul>
        )}
      </div>
    </div>
  );
}

// one person: who they are, then their agent sessions as children (live first), then where they stand per tool
function PersonBlock({ p, sessions, agents, caps }: { p: Person; sessions: SessionLine[]; agents: HiveAgent[]; caps: Capability[] }) {
  const live = sessions.some((s) => s.online);
  const seen = [...sessions.map((s) => +new Date(s.lastEventAt)), ...agents.map((a) => +new Date(a.lastSeen))].sort((x, y) => y - x)[0];
  const main = agents.filter((a) => a.harness !== "worker").sort((a, b) => +new Date(b.lastSeen) - +new Date(a.lastSeen))[0];
  return (
    <div className="person">
      <div className="person-head">
        <Avatar user={p.user} size={24} />
        <b>{p.user}</b> <span className="faint small">{p.role}</span>
        <span className="spacer" />
        {live ? <span className="good small">● live</span> : <span className="faint small">{seen ? `last ${clock(new Date(seen))}` : "no agents yet"}</span>}
      </div>
      <ul className="sessions">
        {sessions.length === 0 && <li className="faint small">no agent sessions in the last day</li>}
        {[...sessions].sort((a, b) => Number(b.online) - Number(a.online) || +new Date(b.lastEventAt) - +new Date(a.lastEventAt)).map((s) => <SessionRow key={s.id} s={s} />)}
      </ul>
      {main && caps.length > 0 && (
        <div className="person-tools">
          {caps.map((c) => {
            const st = standingFor(c, main);
            return st ? <span key={c._id} className="small"><span className="mono faint">{c._id}</span> <StandingTag s={st} /></span> : null;
          })}
        </div>
      )}
    </div>
  );
}

function jobLabel(j: Awaited<ReturnType<typeof workerActivity>>["active"][number]) {
  if (j.stage === "testing") return `testing on ${j.verdict?.total ?? "the"} evals`;
  if (j.stage === "done") return j.outcome === "promoted" ? `promoted v${j.v}` : j.note ?? j.outcome ?? "done";
  return j.stage;
}

const who = (a: Line["actor"]) => (a.worker ? `${a.user}'s worker` : a.user);

function ChangeRow({ l, name }: { l: Line; name: string }) {
  const tone = l.verb === "rejected" ? "bad" : l.verb === "promoted" || l.verb === "published" ? "good" : "";
  return (
    <li>
      <details>
        <summary title={stamp(l.at)}>
          <Avatar user={l.actor.user} />
          <span className="feed-line">
            <span><b>{who(l.actor)}</b> <span className={`verb ${tone}`}>{l.verb}</span> {l.tool && <Link href={`/hive/${name}/tool/${l.tool}`} className="mono">{l.tool}{l.v != null ? ` v${l.v}` : ""}</Link>}</span>
            <span className="muted small feed-res">{l.result ? `${l.result} · ` : ""}{clock(l.at)}</span>
          </span>
          {l.verb === "ran" && l.outputId && !l.judged && <span className="fb-hint faint small">judge ›</span>}
        </summary>
        <div className="feed-detail small">
          <div className="muted">{l.actor.harness && <><HarnessIcon harness={l.actor.harness} size={12} /> {harnessLabel(l.actor.harness)} · </>}{stamp(l.at)}</div>
          {l.verb === "ran" && l.outputId && (l.judged ? (
            <div className="muted">judged {l.judged}. it is an eval now.</div>
          ) : (
            <div className="fb">
              <form action={giveRunFeedback}>
                <input type="hidden" name="hive" value={name} /><input type="hidden" name="outputId" value={l.outputId} /><input type="hidden" name="verdict" value="correct" />
                <button className="ok" title="this answer is right: it becomes an eval">✓ correct</button>
              </form>
              <form action={giveRunFeedback} className="fb-wrong">
                <input type="hidden" name="hive" value={name} /><input type="hidden" name="outputId" value={l.outputId} /><input type="hidden" name="verdict" value="wrong" />
                <input name="correction" placeholder='right answer, e.g. {"teams":["web"]}' className="mono" />
                <button className="bad" title="this answer is wrong: the right answer becomes an eval">✗ wrong</button>
              </form>
            </div>
          ))}
        </div>
      </details>
    </li>
  );
}

function SessionRow({ s }: { s: SessionLine }) {
  return (
    <li>
      <details>
        <summary title={stamp(s.lastEventAt)}>
          <span className={`sdot ${s.online ? "on" : ""}`} />
          <span className="feed-line">
            <span><HarnessIcon harness={s.actor.harness ?? ""} size={12} /> {harnessLabel(s.actor.harness ?? "")} · <span className="muted">{s.toolCalls} tool calls</span></span>
            <span className="muted small feed-res">{s.title ? `“${s.title.slice(0, 70)}” · ` : ""}{s.online ? <span className="good">live</span> : `last ${clock(s.lastEventAt)}`}</span>
          </span>
        </summary>
        <div className="feed-detail small muted">
          {s.prompts} prompt{s.prompts === 1 ? "" : "s"} · started {clock(s.startedAt)} · session {s.id.slice(0, 8)}
        </div>
      </details>
    </li>
  );
}
