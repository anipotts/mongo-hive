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
// W1: "<user>'s worker" as visible text with their avatar; "worker · waiting" until a worker claims the job (#46 B)
export function WorkerChip({ user, live = false }: { user: string | null; live?: boolean }) {
  if (!user) return <span className="wchip muted">worker · waiting</span>;
  return (
    <span className="wchip" title={`${user}'s worker`}>
      <Avatar user={user} size={22} />
      <b>{user}&apos;s worker</b>
      {live && <span className="dot pulse-loop" />}
    </span>
  );
}

// N1: what kind of job this is
export function KindChip({ kind, fromV }: { kind: string; fromV?: number | null }) {
  const cls = kind === "new tool" ? "new" : kind === "repair" ? "repair" : "improving";
  return <span className={`kchip ${cls}`}>{kind === "improving" && fromV != null ? `improving v${fromV}` : kind}</span>;
}

// N2: version arrow, "null → v1" for a brand-new tool; nothing when the target isn't known yet
export function VArrow({ from, to }: { from?: number | null; to?: number | null }) {
  if (to == null) return null;
  return <span className="mono">{from != null ? `v${from}` : "null"} → v{to}</span>;
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

// S1: one hexagon cell travels queued → drafting → testing → done toward a honeycomb missing one cell (#46 C).
// promoted completes the comb; rejected ends red, skipped grey, an untested draft honey. between refreshes the
// cell glides to its new stage (css transition on transform) instead of jumping.
const STAGES = ["queued", "drafting", "testing", "done"] as const;
export type TrailOutcome = "promoted" | "draft" | "rejected" | "skipped" | null;
export function CellTrail({ stage, label, outcome = null }: { stage: (typeof STAGES)[number]; label: string; outcome?: TrailOutcome }) {
  const i = STAGES.indexOf(stage);
  const xs = [6, 70, 134, 198];
  const done = stage === "done" && outcome === "promoted";
  const x = xs[Math.max(0, i)];
  const edge = outcome === "rejected" ? "var(--bad)" : outcome === "skipped" ? "var(--faint)" : "var(--honey)";
  const r = 5.2, dx = r * Math.sqrt(3); // honeycomb cell radius and column spacing
  const comb = [[1, 0], [2, 0], [0.5, 1], [1.5, 1], [2.5, 1], [1, 2], [2, 2]].map(([c, row]) => [236 + c * dx, 6 + row * r * 1.5]);
  const glide = { transition: "transform .6s ease, width .6s ease" };
  return (
    <span className="trail" title={`${stage}: ${label}`}>
      <svg width="290" height="30" viewBox="0 0 290 30" aria-hidden="true">
        <line x1={xs[0]} y1="15" x2="228" y2="15" stroke="var(--line)" strokeWidth="2" strokeDasharray="3 5" />
        <rect x={xs[0]} y="14" height="2" width={(done ? 228 : x) - xs[0]} fill="var(--honey)" style={glide} />
        {xs.map((sx, j) => <circle key={sx} cx={sx} cy="15" r="3" fill={j <= i ? "var(--honey)" : "var(--line)"} />)}
        {/* comb[2] faces the trail: drawn only once a promoted version completes the comb */}
        {comb.map(([cx, cy], j) => (j === 2 && !done ? null : (
          <polygon key={j} points={HEX(cx, cy + 3, r)} fill={j === 2 ? "color-mix(in srgb, var(--honey) 45%, transparent)" : "none"}
            stroke="var(--honey)" strokeWidth={j === 2 ? 1.8 : 1.2} strokeLinejoin="round" />
        )))}
        {!done && <polygon points={HEX(0, 15, 7)} fill="var(--panel)" stroke={edge} strokeWidth="1.5" strokeLinejoin="round" style={{ ...glide, transform: `translateX(${x}px)` }} />}
      </svg>
      <span className="muted trail-label">{label}</span>
    </span>
  );
}
