import "server-only";
import { cache } from "react";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { canAccess, client, hive, hives, type Hive } from "../../src/registry/db";
import type { Capability, CapabilityVersion, HiveAgent, HiveInfo } from "../../src/registry/types";
import { board, rank, standing, type Standing } from "../../src/validator/index";

export type { Capability, CapabilityVersion, HiveAgent, HiveInfo, Standing };
export { board, rank };

// who is looking: this machine's member, from ~/.mongo-hive/config.json (written by `mongo-hive join`),
// else HIVE_USER from the repo .env. each laptop is its own member, so there is no identity switch.
export const viewer = cache(async (): Promise<string> => {
  try {
    const user = JSON.parse(readFileSync(join(homedir(), ".mongo-hive", "config.json"), "utf8")).user;
    if (typeof user === "string" && user) return user;
  } catch {
    // not joined yet: fall back to the env identity
  }
  return process.env.HIVE_USER ?? "unknown";
});

export async function recordConsole(h: Hive, user: string, tool: string, args: unknown, result: unknown) {
  await h.events.insertOne({ runId: "console", user, harness: "console", hive: h.name, tool, args, result, ms: 0, at: new Date() });
}

// cache(): the layout, the page and the tool page ask for the same list in one render; ask atlas once
export const visibleHives = cache(async (user: string) => {
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
});

const hiveInfo = cache((name: string) => hives.findOne({ _id: name }));
export async function openHiveFor(user: string, name: string): Promise<{ info: HiveInfo; h: Hive } | null> {
  const info = await hiveInfo(name);
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
