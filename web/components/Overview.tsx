import Link from "next/link";
import { clock, stamp } from "@/components/Top";
import { Avatar, ScoreRing, StandingTag, StatePill } from "@/components/ui";
import { giveRunFeedback } from "@/app/actions";
import { HarnessIcon, harnessLabel } from "@/lib/harness";
import { byState, feed, standingLabel, toolStates, type ActivityRow, type Line, type SessionLine } from "@/lib/console";
import { Workers } from "@/components/Workers";
import { primaryAgent, standingFor, type Capability, type HiveAgent } from "@/lib/hive";

export type Person = { user: string; role: "owner" | "member" };

// hive page on one screen (kap, #6): the page never scrolls, each pane scrolls inside itself.
//   title row with people as compact chips (click for their agent sessions), then
//   left: honeycomb as a queue (one state per tool from toolStates) with the workers under it; right: activity.
// a tool moves through one lifecycle here whether the hive is solo or shared: drafted → run → checked by a
// worker → judged by a person → promoted → improved. every row, card and line on this page is one step of it.
export async function Overview({ name, as, caps, agents, people, title, invite, extra }: { name: string; as: string; caps: Capability[]; agents: HiveAgent[]; people: Person[]; title: React.ReactNode; invite?: React.ReactNode; extra?: React.ReactNode }) {
  const [{ groups, sessions }, states] = await Promise.all([feed(name), toolStates(name, caps)]);
  const queue = byState(caps, states);
  const inQueue = caps.filter((c) => states[c._id]?.state !== "passing").length;
  return (
    <div className="overview3">
      <div className="title-row">
        {title}
        <span className="spacer" />
        <div className="pchips">
          {people.map((p) => <PersonChip key={p.user} p={p} sessions={sessions.filter((s) => s.actor.user === p.user)} agents={agents.filter((a) => a.user === p.user)} caps={caps} />)}
          {invite}
        </div>
      </div>
      <div className="ov-body">
        <div className="ov-col ov-left">
          <section className="honeycomb-sec">
            <h2 className="h-sec">Honeycomb <span className="faint">· {caps.length} tool{caps.length === 1 ? "" : "s"} · {inQueue} in queue</span></h2>
            {caps.length === 0 ? <div className="empty small ov-empty">No tools yet</div> : (
              <div className="pane honeycomb-table"><table className="compact">
                <tbody>
                  {queue.map((c) => {
                    const st = states[c._id];
                    const standing = standingFor(c, primaryAgent(agents, as, c._id));
                    const actionable = standing && standing.state !== "on_best";
                    return (
                      <tr key={c._id} className={`q-${st.state}`}>
                        <td className="tool-cell">
                          <Link href={`/hive/${name}/tool/${c._id}`} className="mono tool-name">{c._id}</Link>
                          <div className="muted small one-line" title={c.directive}>{c.directive}</div>
                        </td>
                        <td className="num small">{st.promotedV != null ? `promoted v${st.promotedV}` : st.draftV != null ? `draft v${st.draftV}` : <span className="faint">–</span>}</td>
                        <td><ScoreRing s={st.promotedScore} size={34} /></td>
                        <td className="state-cell">
                          <StatePill st={st} extra={`your standing: ${standingLabel(standing) ?? "not used yet"}`} />
                          {actionable && <div className="standing-note"><StandingTag s={standing} /></div>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table></div>
            )}
          </section>

          <Workers name={name} />
          {extra}
        </div>

        {/* activity (was "hive changes", and before that kap's per-agent ladder, #42): one chronological feed, newest at
            the top, people and workers together. agent sessions stay one click away on the person chips. */}
        <section className="ov-col activity">
          <h2 className="h-sec">Activity <span className="faint">· newest first</span></h2>
          <ActivityFeed groups={groups} name={name} />
        </section>
      </div>
    </div>
  );
}

// the activity list, shared by the hive page and the tool page (filtered to one tool there, so "judge N runs"
// can be done where it's announced). `back` sends ✓/✗ back to the page it was given on.
export function ActivityFeed({ groups, name, back, pane = true }: { groups: ActivityRow[]; name: string; back?: string; pane?: boolean }) {
  if (groups.length === 0) return <div className={`empty small ${pane ? "ov-empty" : ""}`}>No activity yet</div>;
  return (
    <ul className={`feed ${pane ? "pane" : ""}`}>
      {groups.slice(0, 80).map((g) => g.lines.length === 1 ? <ChangeRow key={g.key} l={g.lines[0]} name={name} back={back} /> : <BurstRow key={g.key} g={g} name={name} back={back} />)}
    </ul>
  );
}

// "2:56–2:57 PM": eastern, minutes only, one meridiem when both ends share it
const hm = (d: Date) => new Date(d).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: "America/New_York" });
function span(first: Date, last: Date) {
  const a = hm(first), b = hm(last);
  if (a === b) return b;
  const [at, am] = a.split(/\s/), [, bm] = b.split(/\s/); // icu puts a narrow no-break space before AM/PM
  return am === bm ? `${at}–${b}` : `${a}–${b}`;
}

// W1-style person chip: avatar + name + one icon per agent harness (dot when live); click opens their
// agent sessions (live first) and where they stand per tool
function PersonChip({ p, sessions, agents, caps }: { p: Person; sessions: SessionLine[]; agents: HiveAgent[]; caps: Capability[] }) {
  const live = sessions.some((s) => s.online);
  const harnesses = [...new Set([...sessions.map((s) => s.actor.harness ?? ""), ...agents.map((a) => a.harness)].filter((h) => h && h !== "script" && h !== "console"))];
  const seen = [...sessions.map((s) => +new Date(s.lastEventAt)), ...agents.map((a) => +new Date(a.lastSeen))].sort((x, y) => y - x)[0];
  const main = agents.filter((a) => a.harness !== "worker").sort((a, b) => +new Date(b.lastSeen) - +new Date(a.lastSeen))[0];
  return (
    <details className="pchip">
      <summary title={`${p.user} · ${p.role}${seen ? ` · last ${clock(new Date(seen))}` : ""}`}>
        <span className="pchip-av"><Avatar user={p.user} size={22} />{live && <span className="pchip-live" />}</span>
        <b>{p.user}</b>
        <span className="pchip-agents">{harnesses.map((h) => <HarnessIcon key={h} harness={h} size={12} />)}</span>
      </summary>
      <div className="pchip-pop">
        <div className="muted small">{p.role} · {live ? <span className="good">live</span> : seen ? `last ${clock(new Date(seen))}` : "no agents yet"}</div>
        {sessions.length === 0 && <div className="faint small">no agent sessions in the last day</div>}
        {/* one group per machine, newest activity first; each session is a child row with its project and latest prompt */}
        {byMachine(sessions).map(([machine, list]) => (
          <div key={machine} className="machine">
            <div className="machine-head small">
              <span className="mono">{machine}</span>
              <span className="faint"> · {list.length} session{list.length === 1 ? "" : "s"}{new Set(list.map((s) => s.project)).size > 1 ? " · several projects" : list[0].project ? ` · ${list[0].project}` : ""}</span>
            </div>
            <ul className="sessions">{list.map((s) => <SessionRow key={s.id} s={s} showProject={new Set(list.map((x) => x.project)).size > 1 || !!s.worktree} />)}</ul>
          </div>
        ))}
        {main && caps.length > 0 && (
          <div className="person-tools">
            {caps.map((c) => {
              const st = standingFor(c, main);
              return st ? <span key={c._id} className="small"><span className="mono faint">{c._id}</span> <StandingTag s={st} /></span> : null;
            })}
          </div>
        )}
      </div>
    </details>
  );
}



const who = (a: Line["actor"]) => (a.worker ? `${a.user}'s worker` : a.user);
const toolLink = (name: string, l: Line) => l.tool && <Link href={`/hive/${name}/tool/${l.tool}`} className="mono">{l.tool}{l.v != null ? ` v${l.v}` : ""}</Link>;

// a burst: one row with a count and a time range; open it and every line is there, each run with its own ✓/✗
function BurstRow({ g, name, back }: { g: ActivityRow; name: string; back?: string }) {
  const l = g.lines[0];
  const n = g.lines.length;
  const need = g.lines.filter((x) => x.needsJudgment).length;
  const judged = g.lines.filter((x) => x.judged).length;
  const agree = g.lines.filter((x) => x.checked === "agrees").length;
  const open = l.verb === "ran" ? n - judged : 0;
  const parts = l.verb === "ran"
    ? [agree ? `a worker's check agrees on ${agree}` : "", judged ? `${judged} judged` : "", open && !need ? `${open} to judge` : ""].filter(Boolean)
    : [l.result ?? ""].filter(Boolean);
  const tone = need ? "warn" : l.tone ?? "";
  return (
    <li className="burst">
      <details>
        <summary title={`${stamp(g.first)} to ${stamp(g.last)}`}>
          <Avatar user={l.actor.user} />
          <span className="feed-line">
            <span><b>{who(l.actor)}</b> <span className={`verb ${tone}`}>{l.verb}</span> {toolLink(name, l)} <span className="burst-n">×{n}</span>{need > 0 && <> <span className="pill spill warn">{need} need{need === 1 ? "s" : ""} judgment</span></>}</span>
            <span className="muted small feed-res">{parts.length ? `${parts.join(" · ")} · ` : ""}{span(g.first, g.last)}</span>
          </span>
          <span className="fb-hint faint small">{n} ›</span>
        </summary>
        <ul className="feed nested">{g.lines.map((x) => <ChangeRow key={x.id} l={x} name={name} back={back} />)}</ul>
      </details>
    </li>
  );
}

function ChangeRow({ l, name, back }: { l: Line; name: string; back?: string }) {
  const tone = l.tone ?? (l.verb === "rejected" ? "bad" : l.verb === "promoted" ? "good" : "");
  return (
    <li>
      <details>
        <summary title={stamp(l.at)}>
          <Avatar user={l.actor.user} />
          <span className="feed-line">
            <span><b>{who(l.actor)}</b> <span className={`verb ${tone}`}>{l.verb}</span> {toolLink(name, l)}{l.needsJudgment && <> <span className="pill spill warn" title="a worker's check disagrees with this run; a person decides">needs judgment</span></>}</span>
            <span className="muted small feed-res">{l.result ? `${l.result} · ` : ""}{clock(l.at)}</span>
          </span>
          {l.verb === "ran" && l.outputId && !l.judged && <span className="fb-hint faint small">judge ›</span>}
        </summary>
        <div className="feed-detail small">
          <div className="muted">{l.actor.harness && <><HarnessIcon harness={l.actor.harness} size={12} /> {harnessLabel(l.actor.harness)} · </>}{stamp(l.at)}</div>
          {l.needsJudgment && <div className="t-warn">a worker wrote its own implementation and got a different answer for this run. which one is right?</div>}
          {l.verb === "ran" && l.outputId && (l.judged ? (
            <div className="muted">judged {l.judged}. it is an eval now.</div>
          ) : (
            <div className="fb">
              <form action={giveRunFeedback}>
                <input type="hidden" name="hive" value={name} />{back && <input type="hidden" name="back" value={back} />}<input type="hidden" name="outputId" value={l.outputId} /><input type="hidden" name="verdict" value="correct" />
                <button className="ok" title="this answer is right: it becomes an eval">✓ correct</button>
              </form>
              <form action={giveRunFeedback} className="fb-wrong">
                <input type="hidden" name="hive" value={name} />{back && <input type="hidden" name="back" value={back} />}<input type="hidden" name="outputId" value={l.outputId} /><input type="hidden" name="verdict" value="wrong" />
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

const byMachine = (sessions: SessionLine[]) => {
  const groups = new Map<string, SessionLine[]>();
  for (const s of [...sessions].sort((a, b) => +new Date(b.lastEventAt) - +new Date(a.lastEventAt)))
    groups.set(s.machine ?? "unknown machine", [...(groups.get(s.machine ?? "unknown machine") ?? []), s]);
  return [...groups.entries()];
};

function SessionRow({ s, showProject }: { s: SessionLine; showProject?: boolean }) {
  // pasted blocks arrive wrapped in markup; show the words, not the wrapper
  const said = (s.lastPrompt ?? s.title)?.replace(/<\/?pasted_content[^>]*>/g, " ").replace(/\[Image[^\]]*\]/g, "[image]").trim();
  return (
    <li>
      <details>
        <summary title={stamp(s.lastEventAt)}>
          <span className={`sdot ${s.online ? "on" : ""}`} />
          <span className="feed-line">
            <span><HarnessIcon harness={s.actor.harness ?? ""} size={12} /> {harnessLabel(s.actor.harness ?? "")}{showProject && s.project ? <span className="mono faint"> · {s.project}{s.worktree ? " (worktree)" : ""}</span> : null} · <span className="muted">{s.online ? <span className="good">live</span> : clock(s.lastEventAt)}</span></span>
            <span className="muted small feed-res">{said ? `“${said.replace(/\s+/g, " ").slice(0, 80)}”` : ""}</span>
          </span>
        </summary>
        <div className="feed-detail small muted">
          {s.prompts} prompt{s.prompts === 1 ? "" : "s"} · {s.toolCalls} tool calls · started {clock(s.startedAt)} · session {s.id.slice(0, 8)}
        </div>
      </details>
    </li>
  );
}
