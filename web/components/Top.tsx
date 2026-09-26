import Link from "next/link";
import { Live } from "./Live";

export function Hex({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 2.5 20.2 7.25v9.5L12 21.5l-8.2-4.75v-9.5L12 2.5Z" fill="currentColor" opacity=".18" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      <path d="M12 8.2 15.3 10.1v3.8L12 15.8l-3.3-1.9v-3.8L12 8.2Z" fill="currentColor" />
    </svg>
  );
}

export function Top({ as, crumbs = [], here = "/" }: { as: string; crumbs?: { href: string; label: string }[]; here?: string }) {
  return (
    <header className="top">
      <Link href="/" className="brand"><Hex /> MongoHive</Link>
      <nav className="crumbs">
        {crumbs.map((c) => (
          <span key={c.href}>/ <Link href={c.href}>{c.label}</Link></span>
        ))}
      </nav>
      <span className="spacer" />
      <Live as={as} />
      <span className="who" title="view as">
        {["ani", "kap"].map((u) => (
          <Link key={u} href={`${here}?as=${u}`} className={u === as ? "on" : ""}>{u}</Link>
        ))}
      </span>
    </header>
  );
}

export function ago(d?: Date | string | null) {
  if (!d) return "never";
  const s = Math.round((Date.now() - +new Date(d)) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

// every visible time is eastern, 12-hour: "1:34:20 PM"
export function clock(d: Date | string) {
  return new Date(d).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true, timeZone: "America/New_York" });
}

// hover text: the exact instant in iso utc plus the eastern wall time, copy-friendly
export function stamp(d: Date | string) {
  const t = new Date(d);
  const et = t.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "medium", hour12: true, timeZone: "America/New_York" });
  return `${t.toISOString()} · ${et} ET`;
}
