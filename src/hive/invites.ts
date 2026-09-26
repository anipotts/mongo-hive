// invites (#34): a member of a shared hive creates a short code; a teammate redeems it to become a member.
// an invite is only a hive name + expiry: it never carries credentials or connection strings. the teammate
// still needs their own atlas login (`scripts/setup-db-user.sh`, run by `mongo-hive connect`).
import { randomBytes } from "node:crypto";
import { canAccess, hives, honeycomb } from "../registry/db.js";

export interface Invite {
  _id: string; // the code people paste
  hive: string;
  createdBy: string;
  for?: string; // optional: only this user may redeem it
  createdAt: Date;
  expiresAt: Date;
  usedBy: { user: string; at: Date }[];
  revoked?: boolean;
}

export const invites = honeycomb.collection<Invite>("invites");

// unambiguous alphabet (no 0/o/1/l), 10 chars, e.g. "hv-k7m2x9q4ra"
const ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";
const code = () => "hv-" + [...randomBytes(10)].map((b) => ALPHABET[b % ALPHABET.length]).join("");

export async function createInvite(hive: string, by: string, opts: { hours?: number; for?: string } = {}) {
  const info = await hives.findOne({ _id: hive });
  if (!info) return { ok: false as const, error: `no hive ${hive}` };
  if (info.visibility !== "shared") return { ok: false as const, error: `hive ${hive} is private; only shared hives take invites` };
  if (!canAccess(info, by)) return { ok: false as const, error: `you (${by}) are not a member of hive ${hive}` };
  const now = new Date();
  const inv: Invite = {
    _id: code(), hive, createdBy: by, createdAt: now, usedBy: [],
    expiresAt: new Date(now.getTime() + (opts.hours ?? 24) * 3600_000),
    ...(opts.for ? { for: opts.for } : {}),
  };
  await invites.insertOne(inv);
  return { ok: true as const, invite: inv, command: connectCommand(inv._id), prompt: invitePrompt(inv) };
}

export async function redeemInvite(codeIn: string, user: string) {
  const inv = await invites.findOne({ _id: codeIn.trim().toLowerCase() });
  if (!inv || inv.revoked) return { ok: false as const, error: "that invite doesn't exist or was revoked" };
  if (inv.expiresAt < new Date()) return { ok: false as const, error: `that invite expired at ${inv.expiresAt.toISOString()}; ask ${inv.createdBy} for a new one` };
  if (inv.for && inv.for !== user) return { ok: false as const, error: `that invite is for ${inv.for}, not ${user}` };
  // fail closed: the hive may have been deleted or made private since the invite was made
  const res = await hives.updateOne({ _id: inv.hive, visibility: "shared" }, { $addToSet: { members: user } });
  if (res.matchedCount === 0) return { ok: false as const, error: `hive ${inv.hive} no longer exists or isn't shared` };
  await invites.updateOne({ _id: inv._id }, { $push: { usedBy: { user, at: new Date() } } });
  return { ok: true as const, hive: inv.hive, invitedBy: inv.createdBy };
}

export const connectCommand = (c: string) => `npm run -s mongo-hive -- connect ${c}`;

// what the inviter pastes to a teammate (or straight into the teammate's coding agent)
export function invitePrompt(inv: Pick<Invite, "_id" | "hive" | "createdBy" | "expiresAt">) {
  return [
    `Join my MongoHive hive "${inv.hive}" so our coding agents share tested tools.`,
    `In your mongo-hive checkout (github.com/anipotts/mongo-hive), run:`,
    `  git pull && npm install && ${connectCommand(inv._id)}`,
    `Then restart Claude Code / Codex in that project. Invite from ${inv.createdBy}, valid until ${inv.expiresAt.toLocaleString("en-US", { timeZone: "America/New_York", dateStyle: "medium", timeStyle: "short" })} ET.`,
    `The invite holds no credentials; connect sets up your own Atlas login.`,
  ].join("\n");
}
