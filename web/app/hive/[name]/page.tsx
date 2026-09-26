import { notFound } from "next/navigation";
import { Top } from "@/components/Top";
import { agentsOf, openHiveFor, viewer } from "@/lib/hive";
import { Overview } from "@/components/Overview";

export const dynamic = "force-dynamic";


export default async function HivePage({ params, searchParams }: PageProps<"/hive/[name]">) {
  const { name } = await params;
  const sp = await searchParams;
  const as = await viewer();
  const found = await openHiveFor(as, name);
  if (!found) notFound();
  const { info, h } = found;

  const [caps, agents] = await Promise.all([h.capabilities.find().sort({ updatedAt: -1 }).toArray(), agentsOf(h)]);
  // the roster is people first, their agents nested beneath; every member shows even before they connect
  const people = [...new Set([info.owner, ...info.members])];

  return (
    <>
      <Top as={as} crumbs={[{ href: `/hive/${name}`, label: name }]} />
      <main className="wide fit">
        {sp.flash && <div className={`banner toast ${sp.ok === "1" ? "good" : "bad"}`}>{String(sp.flash)}</div>}
        <Overview name={name} as={as} caps={caps} agents={agents} people={people.map((u) => ({ user: u, role: u === info.owner ? "owner" : "member" }))}
          title={<h1 className="hive-title">{name} <span className={`pill ${info.visibility}`}>{info.visibility}</span></h1>} />
      </main>
    </>
  );
}
