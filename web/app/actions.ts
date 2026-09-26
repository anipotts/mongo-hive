"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { hive, hives } from "../../src/registry/db";
import { publishCapability } from "../../src/hive/publish";
import { giveFeedback, type Verdict } from "../../src/hive/feedback";
import { createInvite } from "../../src/hive/invites";
import { openHiveFor, recordConsole, viewer } from "@/lib/hive";

const HARNESSES = ["claude-code", "codex"];

async function ownPrivate(name: string) {
  const as = await viewer();
  const info = await hives.findOne({ _id: name });
  if (!info || info.visibility !== "private" || info.owner !== as) throw new Error(`only the owner can curate drafts in hive ${name}`);
  return { as, h: hive(name) };
}

// keep a draft: it stays unverified (not trusted) until it has passing cases, but it won't be cleaned up
export async function keepVersion(form: FormData) {
  const name = String(form.get("hive")), id = String(form.get("id")), v = Number(form.get("v"));
  const { as, h } = await ownPrivate(name);
  await h.capabilities.updateOne({ _id: id, "versions.v": v }, { $set: { "versions.$.kept": true, updatedAt: new Date() } });
  await recordConsole(h, as, "keep_version", { id, v }, {});
  revalidatePath(`/hive/${name}`);
}

// dismiss a draft: archived, never deleted
export async function dismissVersion(form: FormData) {
  const name = String(form.get("hive")), id = String(form.get("id")), v = Number(form.get("v"));
  const { as, h } = await ownPrivate(name);
  await h.capabilities.updateOne({ _id: id, "versions.v": v }, { $set: { "versions.$.status": "archived", updatedAt: new Date() } });
  await recordConsole(h, as, "dismiss_version", { id, v }, {});
  revalidatePath(`/hive/${name}`);
}

// pin applies to all of the viewer's agents in this hive, so claude code and codex agree
export async function pinVersion(form: FormData) {
  const name = String(form.get("hive")), id = String(form.get("id"));
  const v = form.get("v") ? Number(form.get("v")) : null;
  const as = await viewer();
  const found = await openHiveFor(as, name);
  if (!found) throw new Error(`you (${as}) are not a member of hive ${name}`);
  const { h } = found;
  for (const harness of HARNESSES)
    await h.agents.updateOne(
      { _id: `${as}:${harness}` },
      v == null
        ? { $unset: { [`pinned.${id}`]: "" } }
        : { $set: { [`pinned.${id}`]: v, user: as, harness }, $setOnInsert: { pulled: {}, lastSeen: new Date() } },
      { upsert: v != null },
    );
  await recordConsole(h, as, "pin_capability", { id, version: v }, {});
  revalidatePath(`/hive/${name}/tool/${id}`);
}

// same publish path as the mcp server's publish_capability: target hive's hidden cases decide
export async function publishVersion(form: FormData) {
  const from = String(form.get("hive")), id = String(form.get("id")), to = String(form.get("to"));
  const v = form.get("v") ? Number(form.get("v")) : undefined;
  const as = await viewer();
  const src = await openHiveFor(as, from);
  const dst = await openHiveFor(as, to);
  let msg: string;
  let ok = false;
  if (!src || !dst) msg = `you (${as}) can't publish from ${from} to ${to}`;
  else {
    const r = await publishCapability({ home: src.h, target: dst.h, id, user: as, harness: "console", v });
    if (!r.ok) msg = r.error;
    else {
      ok = r.published;
      msg = r.published
        ? `published ${r.from} → ${r.to} as v${r.version}, now #1 (${r.score?.passed}/${r.score?.total})`
        : `not published: ${r.reason}${r.score?.total ? ` (${r.score.passed}/${r.score.total})` : ""}`;
      await recordConsole(dst.h, as, "publish_capability", { id, from: r.from, v: r.version }, { status: r.published ? "active" : "rejected", score: r.score });
    }
  }
  redirect(`/hive/${from}/tool/${id}?flash=${encodeURIComponent(msg)}&ok=${ok ? 1 : 0}`);
}

// ✓/✗ on a "ran" line: a person judges one run, and it becomes an eval for the whole hive (#18).
// this is the human boundary for feedback: agents have no mcp tool for it.
export async function giveRunFeedback(form: FormData) {
  const name = String(form.get("hive")), outputId = String(form.get("outputId")), verdict = String(form.get("verdict")) as Verdict;
  const back = String(form.get("back") || `/hive/${name}`);
  const as = await viewer();
  const found = await openHiveFor(as, name);
  let msg: string, ok = false;
  let correction: Record<string, unknown> | undefined;
  try {
    const raw = String(form.get("correction") ?? "").trim();
    if (verdict === "wrong") correction = raw ? JSON.parse(raw) : undefined;
  } catch {
    correction = undefined;
  }
  if (!found) msg = `you (${as}) are not a member of hive ${name}`;
  else if (verdict === "wrong" && !correction) msg = "a ✗ needs the right answer as a json object";
  else {
    const r = await giveFeedback({ h: found.h, outputId, by: as, harness: "console", verdict, correction });
    ok = r.ok;
    msg = r.ok ? r.summary : r.error;
  }
  revalidatePath(`/hive/${name}`);
  redirect(`${back}${back.includes("?") ? "&" : "?"}flash=${encodeURIComponent(msg)}&ok=${ok ? 1 : 0}`);
}

// invite button on a shared hive (#34): code + command + prompt, never credentials
export async function createHiveInvite(form: FormData) {
  const name = String(form.get("hive"));
  const as = await viewer();
  const r = await createInvite(name, as, { hours: 24 });
  redirect(r.ok ? `/hive/${name}?invite=${r.invite._id}` : `/hive/${name}?flash=${encodeURIComponent(r.error)}&ok=0`);
}
