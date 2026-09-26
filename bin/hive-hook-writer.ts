// detached writer behind the agent hooks: turns one hook payload into sessions/events rows (docs/contract.md).
// runs after the hook already returned, so it can take its time; it still gives up after a few seconds.
import { readFileSync, rmSync } from "node:fs";
import { hostname } from "node:os";
import { dirname } from "node:path";
import { client, hive } from "../src/registry/db.js";

const [file, harness = "claude-code"] = process.argv.slice(2);
const user = process.env.HIVE_USER ?? "unknown";
const target = hive(process.env.HIVE_SHARED ?? "team");
setTimeout(() => process.exit(0), 8000).unref();

// strip anything that looks like a credential before it can reach atlas
const SECRET = [
  /mongodb(\+srv)?:\/\/[^\s"']+/gi,
  /\b(sk|pk|rk)-[A-Za-z0-9_-]{16,}/g,
  /\b(ghp|gho|ghs|ghu|github_pat)_[A-Za-z0-9_]{16,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
];
const KEY_VALUE = /((?:api[_-]?key|token|secret|password|passwd|authorization)["']?\s*[:=]\s*["']?)[^\s"',}]+/gi;

export function redact(text: string): string {
  let out = text;
  for (const re of SECRET) out = out.replace(re, "[redacted]");
  return out.replace(KEY_VALUE, "$1[redacted]");
}
const preview = (v: unknown) => {
  if (v == null) return undefined;
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return redact(s).slice(0, 500);
};

async function main() {
  const raw = readFileSync(file, "utf8");
  rmSync(dirname(file), { recursive: true, force: true });
  const p = JSON.parse(raw);
  const event: string = p.hook_event_name ?? p.hookEventName ?? "";
  const sessionId: string = p.session_id ?? p.sessionId ?? "unknown";
  const now = new Date();
  const sessions = target.db.collection("sessions");
  const base = { sessionId, user, harness, at: now };

  await sessions.updateOne(
    { _id: sessionId as any },
    {
      $setOnInsert: { user, harness, machine: hostname(), cwd: p.cwd ?? "", startedAt: now },
      $set: { lastEventAt: now },
    },
    { upsert: true },
  );

  if (event === "SessionStart") return;
  if (event === "UserPromptSubmit") {
    const prompt = preview(p.prompt);
    await target.events.insertOne({ ...base, kind: "prompt", argsPreview: prompt });
    // first prompt names the session
    await sessions.updateOne({ _id: sessionId as any, title: { $exists: false } }, { $set: { title: prompt?.slice(0, 80) } });
    return;
  }
  if (event === "PostToolUse") {
    await target.events.insertOne({
      ...base, kind: "tool", tool: p.tool_name ?? p.toolName,
      argsPreview: preview(p.tool_input ?? p.toolInput), resultPreview: preview(p.tool_response ?? p.toolResponse),
    });
    return;
  }
  if (event === "Stop" || event === "SessionEnd") {
    await target.events.insertOne({ ...base, kind: "stop" });
    await sessions.updateOne({ _id: sessionId as any }, { $set: { endedAt: now } });
  }
}

main().catch(() => {}).finally(() => client.close().catch(() => {}));
