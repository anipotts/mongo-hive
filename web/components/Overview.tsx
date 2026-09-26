import Link from "next/link";
import { clock, stamp } from "@/components/Top";
import { Avatar, CellTrail, KindChip, ScoreRing, StandingTag, VArrow, WorkerChip } from "@/components/ui";
import { giveRunFeedback } from "@/app/actions";
import { HarnessIcon, harnessLabel } from "@/lib/harness";
import { feed, workerActivity, type Line, type SessionLine } from "@/lib/console";
import { primaryAgent, rank, standingFor, type Capability, type HiveAgent } from "@/lib/hive";

// hive overview, docs/wireframes/01-hive.svg: honeycomb (the hive's tool store), workers, then activity in two lanes
export async function Overview({ name, as, caps, agents }: { name: string; as: string; caps: Capability[]; agents: HiveAgent[] }) {
  const [{ changes, sessions }, work] = await Promise.all([feed(name), workerActivity(name, 12)]);
  const jobs = [...work.active, ...work.recent.slice(0, Math.max(0, 3 - work.active.length))];
  return (
    <div className="overview">
      <div className="ov-main">
        <section>
          <h2 className="h-sec">Honeycomb <span className="faint">{name}&apos;s store of tools · open one for its version history</span></h2>
          {caps.length === 0 ? <div className="empty">No tools yet. When an agent solves something, it proposes a tool and it lands here.</div> : (
            <div className="scroll"><table>
              <thead><tr><th>tool</th><th>promoted</th><th>evals</th><th>you</th></tr></thead>
              <tbody>
                {caps.map((c) => {
                  const top = rank(c)[0];
                  return (
                    <tr key={c._id}>
                      <td>
                        <Link href={`/hive/${name}/tool/${c._id}`} className="mono tool-name">{c._id}</Link>
                        <div className="muted clamp small" title={c.directive}>{c.directive}</div>
                      </td>
                      <td className="num">{top ? `v${top.v}` : <span className="faint">none yet</span>}</td>
                      <td><ScoreRing s={top?.score} /></td>
                      <td><StandingTag s={standingFor(c, primaryAgent(agents, as, c._id))} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table></div>
          )}
        </section>

        <section>
          <h2 className="h-sec">Workers <span className="faint">who&apos;s working + testing, newest first</span></h2>
          {jobs.length === 0 ? <div className="empty">No worker jobs yet. Feedback on a wrong answer, or a repeated query, queues one.</div> : jobs.map((j) => (
            <div key={j.id} className={`job ${j.stage === "done" ? "finished" : ""}`}>
              <div className="job-head">
                {j.workerOf ? <WorkerChip user={j.workerOf} live={j.stage !== "done"} /> : <span className="muted">worker</span>}
                <KindChip kind={j.kind} fromV={j.fromV} />
                <span className="spacer" />
                <span className="muted small">{j.kind === "new tool" ? "new tool" : j.toolOwner ? `${j.toolOwner}'s tool` : ""}</span>
              </div>
              <div className="mono job-title">{j.tool ?? "untitled"} · <VArrow from={j.kind === "new tool" ? null : j.fromV} to={j.v} /></div>
              <CellTrail stage={j.stage} promoted={j.outcome === "promoted"} label={jobLabel(j)} />
            </div>
          ))}
        </section>
      </div>

      <aside className="ov-feed">
        <h2 className="h-sec">Activity</h2>
        <h3 className="lane-h">hive changes</h3>
        {changes.length === 0 ? <div className="empty small">Quiet so far.</div> : (
          <ul className="feed">{changes.slice(0, 25).map((l) => <ChangeRow key={l.id} l={l} name={name} />)}</ul>
        )}
        <h3 className="lane-h">agent sessions</h3>
        {sessions.length === 0 ? <div className="empty small">No sessions in the last day.</div> : (
          <ul className="feed">{sessions.map((s) => <SessionRow key={s.id} s={s} />)}</ul>
        )}
      </aside>
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
          <Avatar user={s.actor.user} />
          <span className="feed-line">
            <span><b>{s.actor.user}</b> · <HarnessIcon harness={s.actor.harness ?? ""} size={12} /> {harnessLabel(s.actor.harness ?? "")} · <span className="muted">{s.toolCalls} tool calls</span></span>
            <span className="muted small feed-res">{s.title ? `“${s.title.slice(0, 60)}” · ` : ""}{s.online ? <span className="good">live</span> : `last ${clock(s.lastEventAt)}`}</span>
          </span>
        </summary>
        <div className="feed-detail small muted">
          {s.prompts} prompt{s.prompts === 1 ? "" : "s"} · started {clock(s.startedAt)} · session {s.id.slice(0, 8)}
        </div>
      </details>
    </li>
  );
}
