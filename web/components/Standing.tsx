import type { Standing } from "@/lib/hive";

const LABEL: Record<Standing["state"], string> = {
  on_best: "up to date",
  better_available: "update available",
  yours_beats_team: "yours is better, publish it",
  pinned: "pinned",
};

export function StandingPill({ s }: { s: Standing | null }) {
  if (!s) return <span className="faint">not used yet</span>;
  const detail =
    s.state === "better_available" ? ` v${s.v ?? "–"} → v${s.best}` :
    s.state === "on_best" || s.state === "pinned" ? ` v${s.v}` :
    ` v${s.privateV} > v${s.head}`;
  const title = s.state === "better_available" ? `${s.author}'s v${s.best}: ${s.delta}` : undefined;
  return <span className={`pill ${s.state}`} title={title}>{LABEL[s.state]}<span className="mono" style={{ fontSize: 11 }}>{detail}</span></span>;
}

export function Score({ s }: { s?: { passed: number; total: number; ms: number } }) {
  if (!s || !s.total) return <span className="faint">unscored</span>;
  return <span className="num">{s.passed}/{s.total} <span className="faint">{s.ms}ms</span></span>;
}
