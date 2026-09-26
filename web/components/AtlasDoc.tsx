"use client";
import { useRef, useState } from "react";

type Peek = { ns: string; filter: string; atlas: string | null; doc: unknown } | { error: string };

// a small "atlas" chip next to anything stored in the hive. hover: the raw document (trimmed, evals never included).
// click: copies the _id filter and opens that collection in the atlas data explorer (when ATLAS_EXPLORER_URL is set).
export function AtlasDoc({ hive, coll, id }: { hive: string; coll: string; id: string }) {
  const [peek, setPeek] = useState<Peek | null>(null);
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const loading = useRef(false);

  const load = async () => {
    setOpen(true);
    if (peek || loading.current) return peek;
    loading.current = true;
    const r = await fetch(`/api/doc?${new URLSearchParams({ hive, coll, id })}`).then((x) => x.json()).catch(() => ({ error: "unreachable" }));
    loading.current = false;
    setPeek(r);
    return r as Peek;
  };

  const go = async (e: React.MouseEvent) => {
    e.preventDefault(); e.stopPropagation(); // chips sit inside <summary>; don't toggle the row
    const p = await load();
    if (!p || "error" in p) return;
    await navigator.clipboard.writeText(p.filter).catch(() => {});
    setCopied(true); setTimeout(() => setCopied(false), 1500);
    if (p.atlas) window.open(p.atlas, "_blank", "noopener");
  };

  return (
    <span className="atlas" onMouseEnter={load} onMouseLeave={() => setOpen(false)} onFocus={load} onBlur={() => setOpen(false)}>
      <button type="button" className="atlas-chip" onClick={go} aria-label={`${coll} document in atlas`}>
        {copied ? "filter copied" : "atlas ↗"}
      </button>
      {open && (
        <span className="atlas-pop" role="tooltip">
          {!peek ? <span className="faint">loading…</span> : "error" in peek ? <span className="bad">{peek.error}</span> : (
            <>
              <span className="atlas-ns mono">{peek.ns} · {peek.filter}</span>
              <pre className="atlas-json">{JSON.stringify(peek.doc, null, 2)}</pre>
              <span className="faint">{peek.atlas ? "click: open in atlas, filter copied" : "click: copy filter (set ATLAS_EXPLORER_URL to link atlas)"}</span>
            </>
          )}
        </span>
      )}
    </span>
  );
}
