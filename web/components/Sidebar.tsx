"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { Hex } from "./Top";
import { Avatar } from "./ui";

// hives are groups of collaborators; each one's tools are its honeycomb. collapses to a rail of hex icons.
// open/closed lives in a cookie so the server renders the right state on reload (no flash)
export function Sidebar({ hives, initialOpen = true }: { hives: { name: string; visibility: string; tools: number; members: string[] }[]; initialOpen?: boolean }) {
  const path = usePathname();
  const [open, setOpen] = useState(initialOpen);
  const toggle = () => {
    const next = !open;
    setOpen(next);
    document.cookie = `hive_sidebar=${next ? "open" : "closed"}; path=/; max-age=31536000; samesite=lax`;
  };
  const here = path.split("/")[2];
  const members = [...new Set(hives.filter((h) => h.name === here).flatMap((h) => h.members))];
  return (
    <aside className={`side ${open ? "" : "closed"}`}>
      <div className="side-head">
        {open && <span className="side-title">hives</span>}
        <button className="ghost side-toggle" onClick={toggle} aria-label={open ? "collapse hives" : "expand hives"}>{open ? "‹" : "›"}</button>
      </div>
      <nav>
        {hives.map((h) => (
          <Link key={h.name} href={`/hive/${h.name}`} className={`side-hive ${h.name === here ? "on" : ""}`} title={`${h.name} · ${h.visibility}`}>
            <Hex size={18} />
            {open && <><span className="side-name">{h.name}</span><span className="faint side-n">{h.visibility === "private" ? "private" : `${h.tools} tools`}</span></>}
          </Link>
        ))}
      </nav>
      {open && members.length > 0 && (
        <div className="side-members"><span className="faint">members</span><div>{members.map((m) => <Avatar key={m} user={m} />)}</div></div>
      )}
    </aside>
  );
}
