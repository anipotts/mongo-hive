"use client";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

// the honeycomb as a bounded "infinite" canvas: a hex grid that runs past the edges, pan by drag, zoom by wheel,
// clamped so the tools never leave the view. every cell is a tool. three variations share the engine:
//   a: one comb, amber fill = pass rate, click → side panel
//   b: one comb per scope, click → card beside the cell
//   c: ordered by activity (live worker jobs in the middle), click → camera flies into the cell
export type CombTool = {
  id: string; directive: string; scope: string;
  head: { v: number; passed: number; total: number; ms: number; by: string } | null;
  versions: number; rejected: number; evals: number; runs: number; lastRun: string | null;
  standing: string | null;
  job: { stage: string; kind: string; v: number | null; by: string | null } | null;
  updatedAt: string;
};

const R = 64; // cell radius in world units
const SQ3 = Math.sqrt(3);
const toXY = (q: number, r: number) => ({ x: R * SQ3 * (q + r / 2), y: R * 1.5 * r });
const hexPts = (cx: number, cy: number, rad: number) =>
  Array.from({ length: 6 }, (_, i) => {
    const a = (Math.PI / 3) * i - Math.PI / 2;
    return `${(cx + rad * Math.cos(a)).toFixed(1)},${(cy + rad * Math.sin(a)).toFixed(1)}`;
  }).join(" ");

// axial coordinates in rings around the centre: 0, then 6, then 12 ...
function spiral(n: number) {
  const out: [number, number][] = [[0, 0]];
  const dirs: [number, number][] = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];
  for (let k = 1; out.length < n; k++) {
    let [q, r] = [-k, k]; // start at ring k, south-west corner
    for (let side = 0; side < 6 && out.length < n; side++)
      for (let step = 0; step < k && out.length < n; step++) {
        out.push([q, r]);
        q += dirs[side][0]; r += dirs[side][1];
      }
  }
  return out.slice(0, n);
}

type Placed = { t: CombTool; x: number; y: number; group?: string };

function layout(variant: string, tools: CombTool[]): { cells: Placed[]; labels: { text: string; x: number; y: number }[] } {
  const rate = (t: CombTool) => (t.head ? t.head.passed / t.head.total : -1);
  if (variant === "b") {
    const scopes = [...new Set(tools.map((t) => t.scope))].sort();
    const cells: Placed[] = [], labels: { text: string; x: number; y: number }[] = [];
    scopes.forEach((s, i) => {
      const mine = tools.filter((t) => t.scope === s).sort((a, b) => rate(b) - rate(a));
      // clusters side by side, 4 columns apart, snapped to the lattice so every cell sits on a background cell
      const oq = Math.round((i - (scopes.length - 1) / 2) * 4);
      const ox = toXY(oq, 0).x;
      spiral(mine.length).forEach(([q, r], j) => { const p = toXY(q + oq, r); cells.push({ t: mine[j], x: p.x, y: p.y, group: s }); });
      labels.push({ text: s, x: ox, y: -R * 2.4 - (mine.length > 7 ? R * 1.5 : 0) });
    });
    return { cells, labels };
  }
  const score = (t: CombTool) =>
    variant === "c" ? (t.job ? 1e13 : 0) + (t.lastRun ? +new Date(t.lastRun) : 0) + +new Date(t.updatedAt) / 1e3 : rate(t);
  const sorted = [...tools].sort((a, b) => score(b) - score(a));
  return { cells: spiral(sorted.length).map(([q, r], i) => ({ t: sorted[i], ...toXY(q, r) })), labels: [] };
}

export function CombCanvas({ variant, tools, hive }: { variant: "a" | "b" | "c"; tools: CombTool[]; hive: string }) {
  const { cells, labels } = useMemo(() => layout(variant, tools), [variant, tools]);
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 800, h: 500 });
  const [cam, setCam] = useState({ x: 0, y: 0, k: 1 }); // world point at screen centre, zoom
  const [sel, setSel] = useState<string | null>(null);
  const drag = useRef<{ x: number; y: number; cx: number; cy: number; moved: boolean } | null>(null);

  // content bounds (+ one cell of margin): the camera centre may not leave them
  const bounds = useMemo(() => {
    const xs = cells.map((c) => c.x), ys = cells.map((c) => c.y);
    const pad = R * 1.5;
    return xs.length ? { x0: Math.min(...xs) - pad, x1: Math.max(...xs) + pad, y0: Math.min(...ys) - pad, y1: Math.max(...ys) + pad } : { x0: -R, x1: R, y0: -R, y1: R };
  }, [cells]);
  const clamp = useCallback((c: { x: number; y: number; k: number }) => {
    const k = Math.min(3, Math.max(0.45, c.k));
    return { k, x: Math.min(bounds.x1, Math.max(bounds.x0, c.x)), y: Math.min(bounds.y1, Math.max(bounds.y0, c.y)) };
  }, [bounds]);

  useEffect(() => {
    const el = box.current!;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // fit everything on first paint
  useEffect(() => {
    const w = bounds.x1 - bounds.x0, h = bounds.y1 - bounds.y0;
    const k = Math.min(1.4, (size.w - 40) / w, (size.h - 40) / h);
    setCam(clamp({ x: (bounds.x0 + bounds.x1) / 2, y: (bounds.y0 + bounds.y1) / 2, k }));
  }, [bounds, size.w, size.h, clamp]);

  // wheel zoom around the cursor; non-passive so the page never scrolls or bounces
  useEffect(() => {
    const el = box.current!;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      setCam((c) => {
        const k = Math.min(3, Math.max(0.45, c.k * Math.exp(-e.deltaY * 0.0015)));
        const wx = c.x + (e.clientX - r.left - r.width / 2) / c.k, wy = c.y + (e.clientY - r.top - r.height / 2) / c.k;
        return clamp({ k, x: wx - (e.clientX - r.left - r.width / 2) / k, y: wy - (e.clientY - r.top - r.height / 2) / k });
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [clamp]);

  // capture on the canvas so a drag keeps panning past the edge; a press without movement is a click on the cell under it
  const onDown = (e: React.PointerEvent) => { drag.current = { x: e.clientX, y: e.clientY, cx: cam.x, cy: cam.y, moved: false }; e.currentTarget.setPointerCapture(e.pointerId); };
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x, dy = e.clientY - d.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true;
    setCam((c) => clamp({ ...c, x: d.cx - dx / c.k, y: d.cy - dy / c.k }));
  };
  const onUp = (e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    if (!d || d.moved) return;
    const hit = (document.elementFromPoint(e.clientX, e.clientY) as Element | null)?.closest<SVGGElement>("g.cell");
    if (hit?.dataset.id) pick(hit.dataset.id);
  };
  // c: the camera flies (eased, 350ms) instead of jumping
  const fly = (to: { x: number; y: number; k: number }) => {
    const from = { ...cam }, t0 = performance.now(), dest = clamp(to);
    const step = (now: number) => {
      const p = Math.min(1, (now - t0) / 350), e = 1 - Math.pow(1 - p, 3);
      setCam({ x: from.x + (dest.x - from.x) * e, y: from.y + (dest.y - from.y) * e, k: from.k + (dest.k - from.k) * e });
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  };
  const pick = (id: string) => {
    setSel((s) => (s === id ? null : id));
    if (variant === "c") {
      const c = cells.find((x) => x.t.id === id)!;
      fly(sel === id ? { ...cam, k: 1 } : { x: c.x, y: c.y, k: 2.6 });
    }
  };

  const selected = cells.find((c) => c.t.id === sel);
  const tf = `translate(${size.w / 2} ${size.h / 2}) scale(${cam.k}) translate(${-cam.x} ${-cam.y})`;
  const toScreen = (x: number, y: number) => ({ x: size.w / 2 + (x - cam.x) * cam.k, y: size.h / 2 + (y - cam.y) * cam.k });

  return (
    <div className={`comb comb-${variant}`}>
      <div ref={box} className="comb-canvas" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={() => (drag.current = null)}>
        <svg width={size.w} height={size.h} role="img" aria-label={`${hive} honeycomb`}>
          <defs>
            {/* the endless comb behind the tools: one tile of the hex lattice, repeated */}
            <pattern id="lattice" width={R * SQ3} height={R * 3} patternUnits="userSpaceOnUse">
              {/* one tile of the same lattice the cells sit on: cell centres at (0,0), (w,0), (w/2,1.5R), (0,3R), (w,3R) */}
              {[[0, 0], [R * SQ3, 0], [R * SQ3 / 2, R * 1.5], [0, R * 3], [R * SQ3, R * 3]].map(([cx, cy]) => (
                <polygon key={`${cx},${cy}`} points={hexPts(cx, cy, R - 2)} fill="none" stroke="var(--line)" strokeWidth="1" opacity=".55" />
              ))}
            </pattern>
            <clipPath id="cell-clip"><polygon points={hexPts(0, 0, R - 5)} /></clipPath>
          </defs>
          <g transform={tf}>
            <rect x={-R * 60} y={-R * 60} width={R * 120} height={R * 120} fill="url(#lattice)" />
            {labels.map((l) => <text key={l.text} x={l.x} y={l.y} textAnchor="middle" className="comb-group">{l.text}</text>)}
            {cells.map(({ t, x, y }) => (
              <Cell key={t.id} t={t} x={x} y={y} variant={variant} on={sel === t.id} zoomed={variant === "c" && sel === t.id} />
            ))}
          </g>
        </svg>

        {variant === "b" && selected && (() => {
          const p = toScreen(selected.x, selected.y);
          const left = Math.min(size.w - 300, p.x + R * cam.k * 0.95), top = Math.max(8, Math.min(size.h - 250, p.y - 110));
          return <div className="comb-card" style={{ left, top }}><Metrics t={selected.t} hive={hive} onClose={() => setSel(null)} /></div>;
        })()}

        <div className="comb-hud faint small">{Math.round(cam.k * 100)}% · <button className="ghost linkish" onClick={() => { setSel(null); const w = bounds.x1 - bounds.x0, h = bounds.y1 - bounds.y0; setCam(clamp({ x: (bounds.x0 + bounds.x1) / 2, y: (bounds.y0 + bounds.y1) / 2, k: Math.min(1.4, (size.w - 40) / w, (size.h - 40) / h) })); }}>fit</button></div>
      </div>

      {variant === "a" && (
        <aside className="comb-panel">
          {selected ? <Metrics t={selected.t} hive={hive} onClose={() => setSel(null)} /> : (
            <div className="faint small comb-empty">Click a cell to see its metrics. Fill = how much of its evals the promoted version passes.</div>
          )}
        </aside>
      )}
    </div>
  );
}

function Cell({ t, x, y, variant, on, zoomed }: { t: CombTool; x: number; y: number; variant: string; on: boolean; zoomed: boolean }) {
  const f = t.head ? t.head.passed / t.head.total : 0;
  const bad = t.head ? f < 0.5 : false;
  const live = !!t.job;
  return (
    <g transform={`translate(${x} ${y})`} className={`cell ${on ? "on" : ""} ${live ? "live" : ""}`} data-id={t.id} style={{ cursor: "pointer" }}>
      <polygon points={hexPts(0, 0, R - 4)} className="cell-bg" />
      {/* a: amber rises from the bottom like honey, to the pass rate */}
      {variant === "a" && t.head && (
        <rect x={-R} y={R - 5 - (2 * R - 10) * f} width={2 * R} height={(2 * R - 10) * f} clipPath="url(#cell-clip)" fill={bad ? "var(--bad)" : "var(--honey)"} opacity=".28" />
      )}
      {/* b: whole cell tinted by pass rate */}
      {variant === "b" && t.head && <polygon points={hexPts(0, 0, R - 5)} fill={bad ? "var(--bad)" : "var(--honey)"} opacity={0.08 + 0.3 * f} />}
      {/* c: inner rings, one per version (max 5), a live worker glows */}
      {variant === "c" && Array.from({ length: Math.min(5, t.versions) }, (_, i) => (
        <polygon key={i} points={hexPts(0, 0, R - 10 - i * 6)} fill="none" stroke="var(--honey)" strokeWidth=".8" opacity={0.12 + 0.06 * i} />
      ))}
      <polygon points={hexPts(0, 0, R - 4)} fill="none" className="cell-edge" stroke={live ? "var(--honey)" : on ? "var(--text)" : bad ? "var(--bad)" : "color-mix(in srgb, var(--honey) 55%, var(--line))"} strokeWidth={on || live ? 2.4 : 1.4} />
      {!zoomed && (
        <>
          <text y={-8} textAnchor="middle" className="cell-name">{t.id.length > 14 ? t.id.slice(0, 13) + "…" : t.id}</text>
          <text y={12} textAnchor="middle" className="cell-score">{t.head ? `${t.head.passed}/${t.head.total}` : "no evals"}{t.head ? ` · v${t.head.v}` : ""}</text>
          {live && <text y={30} textAnchor="middle" className="cell-live">{t.job!.stage}…</text>}
          {!live && t.standing?.startsWith("update") && <text y={30} textAnchor="middle" className="cell-live">update available</text>}
        </>
      )}
      {zoomed && (
        <foreignObject x={-R * 0.72} y={-R * 0.62} width={R * 1.44} height={R * 1.24}>
          <div className="cell-zoom">
            <b className="mono">{t.id}</b>
            <span>{t.head ? `v${t.head.v} · ${t.head.passed}/${t.head.total} evals · ${t.head.ms}ms` : "no promoted version"}</span>
            <span>{t.versions} versions · {t.rejected} rejected · {t.runs} runs</span>
            <span>{t.standing ?? "not used yet"}</span>
            {t.job && <span className="good">worker {t.job.stage} {t.job.v ? `v${t.job.v}` : ""}</span>}
          </div>
        </foreignObject>
      )}
    </g>
  );
}

function Metrics({ t, hive, onClose }: { t: CombTool; hive: string; onClose: () => void }) {
  const f = t.head ? t.head.passed / t.head.total : 0;
  return (
    <div className="metrics">
      <div className="metrics-head">
        <b className="mono">{t.id}</b>
        <span className="spacer" />
        <button className="ghost linkish" onClick={onClose} aria-label="close">×</button>
      </div>
      <p className="muted small clamp">{t.directive}</p>
      <dl>
        <dt>promoted</dt><dd>{t.head ? `v${t.head.v} by ${t.head.by}` : "none yet"}</dd>
        <dt>evals</dt><dd>{t.head ? <><span className={f < 0.5 ? "bad" : "good"}>{t.head.passed}/{t.head.total}</span> · {t.head.ms}ms</> : `${t.evals} cases, nothing passing enough`}</dd>
        <dt>versions</dt><dd>{t.versions} ({t.rejected} rejected)</dd>
        <dt>runs</dt><dd>{t.runs}{t.lastRun ? ` · last ${new Date(t.lastRun).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" })}` : ""}</dd>
        <dt>you</dt><dd>{t.standing ?? "not used yet"}</dd>
        <dt>worker</dt><dd>{t.job ? `${t.job.by ?? ""}'s worker ${t.job.stage} ${t.job.v ? `v${t.job.v}` : ""} (${t.job.kind})` : "idle"}</dd>
        <dt>scope</dt><dd>{t.scope}</dd>
      </dl>
      <Link href={`/hive/${hive}/tool/${t.id}`} className="small">open version history →</Link>
    </div>
  );
}
