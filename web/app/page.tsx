import Link from "next/link";
import { Top, ago } from "@/components/Top";
import { viewer, visibleHives } from "@/lib/hive";
import { eventName } from "@/lib/events";

export const dynamic = "force-dynamic";

export default async function Hives() {
  const as = await viewer();
  const list = await visibleHives(as);
  return (
    <>
      <Top as={as} />
      <main>
        <h1>Hives</h1>
        <p className="sub">Every hive you belong to. A hive is a group of collaborators; its honeycomb is the tools they share. Your private hive holds your drafts.</p>
        {list.length === 0 ? (
          <div className="empty">No hives for {as} yet. Start an agent with the mongo-hive MCP server and one appears.</div>
        ) : (
          <div className="grid">
            {list.map(({ info, tools, last }) => (
              <Link key={info._id} href={`/hive/${info._id}`} className="card" style={{ textDecoration: "none" }}>
                <h3>
                  {info._id}
                  <span className={`pill ${info.visibility}`}>{info.visibility}</span>
                </h3>
                <div className="meta">
                  <span>{tools} tool{tools === 1 ? "" : "s"}</span>
                  <span>members: {info.members.join(", ")}</span>
                </div>
                <div className="meta" style={{ marginTop: 6 }}>
                  <span className="faint">
                    {last ? `${last.user} · ${eventName(last)} · ${ago(last.at)}` : "no activity yet"}
                  </span>
                </div>
              </Link>
            ))}
          </div>
        )}
      </main>
    </>
  );
}
