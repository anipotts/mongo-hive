// console-v2 building blocks, one per pick on #6 (docs/wireframes): I1 avatar, W1 worker chip, N1 kind chip +
// N2 version arrow, E2 score ring, U1 standing words, S1 progress as a hexagon cell that completes the honeycomb.
import type { Standing } from "@/lib/hive";

// I1: initial avatars, fixed colour per person, no image fetches
export function Avatar({ user, size = 18 }: { user: string; size?: number }) {
  return (
    <span className={`av av-${user}`} style={{ width: size, height: size, fontSize: Math.round(size * 0.52) }} title={user}>
      {user[0]}
    </span>
  );
}

// W1: "worker" with the owner's (bigger) avatar; a dot pulses while a job is live
export function WorkerChip({ user, live = false }: { user: string; live?: boolean }) {
  return (
    <span className="wchip" title={`${user}'s worker`}>
      <span className="muted">worker</span>
      <Avatar user={user} size={22} />
      {live && <span className="dot pulse-loop" />}
    </span>
  );
}

// N1: what kind of job this is
export function KindChip({ kind, fromV }: { kind: string; fromV?: number | null }) {
  const cls = kind === "new tool" ? "new" : kind === "repair" ? "repair" : "improving";
  return <span className={`kchip ${cls}`}>{kind === "improving" && fromV != null ? `improving v${fromV}` : kind}</span>;
}

// N2: version arrow, ∅ for a brand-new tool
export function VArrow({ from, to }: { from?: number | null; to?: number | null }) {
  return <span className="mono">{from != null ? `v${from}` : "∅"} → {to != null ? `v${to}` : "…"}</span>;
}

// pointy-top hexagon points, shared by the score hexagon and the progress cell
const HEX = (cx: number, cy: number, r: number) =>
  Array.from({ length: 6 }, (_, i) => {
    const a = (Math.PI / 3) * i - Math.PI / 2;
    return `${(cx + r * Math.cos(a)).toFixed(2)},${(cy + r * Math.sin(a)).toFixed(2)}`;
  }).join(" ");

// E2 as a hexagon: the outline fills clockwise from the top vertex by pass rate.
// green-free palette: amber at 100% and above the 50% floor, red below it
export function ScoreRing({ s, size = 40 }: { s?: { passed: number; total: number; ms?: number } | null; size?: number }) {
  if (!s || !s.total) return <span className="faint">no evals</span>;
  const f = s.passed / s.total;
  const col = f >= 0.5 ? "var(--honey)" : "var(--bad)";
  const pts = HEX(size / 2, size / 2, size / 2 - 3);
  return (
    <span className="ring" style={{ width: size, height: size }} title={`${s.passed}/${s.total} evals${s.ms != null ? ` in ${s.ms}ms` : ""}`}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        <polygon points={pts} fill="none" stroke="var(--line)" strokeWidth="3" strokeLinejoin="round" />
        <polygon points={pts} fill="none" stroke={col} strokeWidth="3" strokeLinejoin="round" strokeLinecap="round" pathLength={100} strokeDasharray={`${f * 100} 100`} />
      </svg>
      <span className="ring-t" style={{ fontSize: Math.max(8, Math.round(size * 0.22)) }}>{s.passed}/{s.total}</span>
    </span>
  );
}

// U1: package-manager words from docs/glossary.md
export function StandingTag({ s }: { s: Standing | null }) {
  if (!s) return <span className="faint">not used yet</span>;
  const [cls, text] =
    s.state === "on_best" ? ["on_best", `up to date · v${s.v}`] :
    s.state === "better_available" ? ["better_available", `update available · v${s.best}`] :
    s.state === "yours_beats_team" ? ["yours_beats_team", "yours is better, publish it"] :
    ["pinned", `pinned v${s.v}`];
  const title = s.state === "better_available" ? `${s.author}'s v${s.best}: ${s.delta}` : undefined;
  return <span className={`pill ${cls}`} title={title}>{text}</span>;
}

// S1: one hexagon cell travels queued → drafting → testing → done toward a honeycomb missing one cell;
// at done the cell fills the slot and the comb is whole. static, no animation.
const STAGES = ["queued", "drafting", "testing", "done"] as const;
// a finished job only completes the comb if its version was promoted; a rejected one stops short of the slot
export function CellTrail({ stage, label, promoted = false }: { stage: (typeof STAGES)[number]; label: string; promoted?: boolean }) {
  const i = STAGES.indexOf(stage);
  const xs = [6, 70, 134, 198];
  const done = stage === "done" && promoted;
  const stopped = stage === "done" && !promoted;
  const x = xs[Math.max(0, i)];
  const r = 5.2, dx = r * Math.sqrt(3); // honeycomb cell radius and column spacing
  const comb = [[1, 0], [2, 0], [0.5, 1], [1.5, 1], [2.5, 1], [1, 2], [2, 2]].map(([c, row]) => [236 + c * dx, 6 + row * r * 1.5]);
  return (
    <span className="trail" title={`${stage}: ${label}`}>
      <svg width="290" height="30" viewBox="0 0 290 30" aria-hidden="true">
        <line x1={xs[0]} y1="15" x2={done ? 228 : x} y2="15" stroke="var(--honey)" strokeWidth="2" />
        {!done && <line x1={x} y1="15" x2="228" y2="15" stroke="var(--line)" strokeWidth="2" strokeDasharray="3 5" />}
        {xs.map((sx, j) => <circle key={sx} cx={sx} cy="15" r="3" fill={j <= i ? "var(--honey)" : "var(--line)"} />)}
        {/* comb[2] faces the trail: drawn only once a promoted version completes the comb */}
        {comb.map(([cx, cy], j) => (j === 2 && !done ? null : (
          <polygon key={j} points={HEX(cx, cy + 3, r)} fill={j === 2 ? "color-mix(in srgb, var(--honey) 45%, transparent)" : "none"}
            stroke="var(--honey)" strokeWidth={j === 2 ? 1.8 : 1.2} strokeLinejoin="round" />
        )))}
        {!done && <polygon points={HEX(x, 15, 7)} fill="var(--panel)" stroke={stopped ? "var(--bad)" : "var(--honey)"} strokeWidth="1.5" strokeLinejoin="round" />}
      </svg>
      <span className="muted trail-label">{label}</span>
    </span>
  );
}
