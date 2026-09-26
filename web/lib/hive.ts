import "server-only";
import { cookies } from "next/headers";
import { canAccess, client, hive, hives, type Hive } from "../../src/registry/db";
import type { Capability, CapabilityVersion, HiveAgent, HiveInfo } from "../../src/registry/types";
import { board, rank, standing, type Standing } from "../../src/validator/index";

export type { Capability, CapabilityVersion, HiveAgent, HiveInfo, Standing };
export { board, rank };

// who is looking: set by `?as=` (see proxy.ts), remembered in a cookie. demo identity, not auth.
export async function viewer(): Promise<string> {
  return (await cookies()).get("hive_as")?.value ?? "ani";
}

export async function recordConsole(h: Hive, user: string, tool: string, args: unknown, result: unknown) {
  await h.events.insertOne({ runId: "console", user, harness: "console", hive: h.name, tool, args, result, ms: 0, at: new Date() });
}

export async function visibleHives(user: string) {
  const list = await hives.find({ $or: [{ owner: user }, { members: user }] }).sort({ visibility: -1, _id: 1 }).toArray();
  return Promise.all(
    list.map(async (info) => {
      const h = hive(info._id);
      const [tools, last] = await Promise.all([
        h.capabilities.countDocuments(),
        h.events.find({}, { projection: { at: 1, tool: 1, kind: 1, user: 1 } }).sort({ at: -1 }).limit(1).next(),
      ]);
      return { info, tools, last: last as { at: Date; tool?: string; kind?: string; user: string } | null };
    }),
  );
}

export async function openHiveFor(user: string, name: string): Promise<{ info: HiveInfo; h: Hive } | null> {
  const info = await hives.findOne({ _id: name });
  if (!canAccess(info, user)) return null;
  return { info: info!, h: hive(info!._id) };
}

// the viewer's agents in a hive (claude-code, codex, console...) and what they currently run per tool
export async function agentsOf(h: Hive) {
  return h.agents.find({}, { projection: { resumeToken: 0 } }).sort({ _id: 1 }).toArray();
}

export function standingFor(cap: Capability, agent: HiveAgent | undefined): Standing | null {
  if (!agent) return null;
  return standing(cap, agent.pulled?.[cap._id] ?? null, agent.pinned?.[cap._id] ?? null);
}

// the viewer's best-informed agent: prefer the one that ran this tool most recently
export function primaryAgent(agents: HiveAgent[], user: string, capId?: string) {
  const mine = agents.filter((a) => a.user === user);
  if (capId) {
    const ran = mine.filter((a) => a.pulled?.[capId] != null || a.pinned?.[capId] != null);
    if (ran.length) return ran.sort((a, b) => +new Date(b.lastSeen) - +new Date(a.lastSeen))[0];
  }
  return mine.sort((a, b) => +new Date(b.lastSeen) - +new Date(a.lastSeen))[0];
}

export const dbClient = client;
