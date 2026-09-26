import Link from "next/link";
import { clock, stamp } from "@/components/Top";
import { Avatar, ScoreRing, StandingTag } from "@/components/ui";
import { giveRunFeedback } from "@/app/actions";
import { HarnessIcon, harnessLabel } from "@/lib/harness";
import { feed, type Line, type SessionLine } from "@/lib/console";
import { Workers } from "@/components/Workers";
import { primaryAgent, rank, standingFor, type Capability, type HiveAgent } from "@/lib/hive";

export type Person = { user: string; role: "owner" | "member" };

// hive page on one screen (kap, #6): three panes that each scroll on their own, the page never does.
//   title row with people as compact chips (click for their agent sessions), then honeycomb + workers beside hive changes
export async function Overview({ name, as, caps, agents, people, title, invite, extra }: { name: string; as: string; caps: Capability[]; agents: HiveAgent[]; people: Person[]; title: React.ReactNode; invite?: React.ReactNode; extra?: React.ReactNode }) {
  const { changes, sessions } = await feed(name);
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
          <h2 className="h-sec">Honeycomb <span className="faint">{caps.length} tools</span></h2>
          {caps.length === 0 ? <div className="empty small">No tools yet.</div> : (
            <div className="pane honeycomb-table"><table className="compact">
              <tbody>
                {caps.map((c) => {
                  const top = rank(c)[0];
                  // a tool with no tested version yet is a draft: it lives in this hive's table, marked as untested
                  const draft = !top ? [...c.versions].reverse().find((v) => v.status === "unverified") : undefined;
                  return (
                    <tr key={c._id}>
                      <td className="tool-cell">
                        <Link href={`/hive/${name}/tool/${c._id}`} className="mono tool-name">{c._id}</Link>
                        <div className="muted small one-line" title={c.directive}>{c.directive}</div>
                      </td>
                      <td className="num small">{top ? `v${top.v}` : draft ? `v${draft.v}` : <span className="faint">–</span>}</td>
                      <td><ScoreRing s={top?.score} size={34} /></td>
                      <td>{draft
                        ? <span className="pill unverified" title={draft.reason}>{draft.publishedFrom ? `untested · published by ${draft.author}` : `untested draft · ${draft.harness === "worker" ? `${draft.author}'s worker` : draft.author}`}</span>
                        : <StandingTag s={standingFor(c, primaryAgent(agents, as, c._id))} />}</td>
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

      <div className="pane ov-col">
        {/* live ladder: one row per agent, the one that changed something most recently sinks to the bottom;
            opening it shows the full log */}
        <details className="changes" style={{ ["--lh" as string]: `${ladder(changes).length * 64}px` }}>
          <summary className="h-sec">Hive changes <span className="faint">{ladder(changes).length} agents · full log ›</span></summary>
          <ul className="feed">{changes.slice(0, 80).map((l) => <ChangeRow key={l.id} l={l} name={name} />)}</ul>
        </details>
        <ul className="ladder">
          {ladder(changes).map(({ key, l, n }) => (
            <li key={key} title={stamp(l.at)}>
              <span className="pchip-av"><Avatar user={l.actor.user} size={22} /></span>
              {l.actor.harness && <HarnessIcon harness={l.actor.harness} size={12} />}
              <span className="feed-line">
                <span><b>{who(l.actor)}</b> <span className="faint small">· {n} change{n === 1 ? "" : "s"}</span></span>
                <span className="muted small feed-res"><span className={`verb ${l.verb === "rejected" ? "bad" : l.verb === "promoted" ? "good" : ""}`}>{l.verb}</span> {l.tool}{l.v != null ? ` v${l.v}` : ""} · {clock(l.at)}</span>
              </span>
            </li>
          ))}
        </ul>
      </div>
      </div>
    </div>
  );
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


// one entry per agent (person + harness), oldest latest-change first, so the freshest sits at the bottom
function ladder(changes: Line[]) {
  const by = new Map<string, { key: string; l: Line; n: number }>();
  for (const l of changes) {
    const key = `${l.actor.user}:${l.actor.harness ?? ""}`;
    const cur = by.get(key);
    if (!cur) by.set(key, { key, l, n: 1 });
    else { cur.n++; if (+new Date(l.at) > +new Date(cur.l.at)) cur.l = l; }
  }
  return [...by.values()].sort((a, b) => +new Date(a.l.at) - +new Date(b.l.at));
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
