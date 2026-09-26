"use client";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

// agents hear about new heads through atlas change streams (see src/mcp/server.ts).
// the browser polls a tiny endpoint instead, because serverless functions (vercel) can't hold a stream open.
export function Live({ as }: { as: string }) {
  const router = useRouter();
  const last = useRef<string | null>(null);
  const [beat, setBeat] = useState(0);
  const [ago, setAgo] = useState(0);
  const seen = useRef(Date.now());

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const r = await fetch(`/api/pulse?as=${encodeURIComponent(as)}`, { cache: "no-store" });
        const { stamp } = await r.json();
        if (!alive) return;
        if (last.current && stamp !== last.current) {
          router.refresh();
          setBeat((b) => b + 1);
          seen.current = Date.now();
        }
        last.current = stamp;
      } catch {}
    };
    tick();
    const poll = setInterval(tick, 3000);
    const clock = setInterval(() => setAgo(Math.round((Date.now() - seen.current) / 1000)), 1000);
    return () => { alive = false; clearInterval(poll); clearInterval(clock); };
  }, [as, router]);

  return (
    <span className="live" title="refreshes when anything in your hives changes">
      <span key={beat} className={`dot ${beat ? "pulse" : ""}`} />
      live · {ago < 3 ? "just now" : `${ago}s`}
    </span>
  );
}
