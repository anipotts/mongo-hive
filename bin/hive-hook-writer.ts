// detached writer behind the agent hooks: turns one hook payload into sessions/events rows (docs/contract.md).
// runs after the hook already returned, so it can take its time; it still gives up after a few seconds.
import { appendFileSync, chmodSync, closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";
import { client, hive } from "../src/registry/db.js";
import { hiveNotices, noticeHives, type Notice } from "../src/hive/notices.js";

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

// notices for this person (src/hive/notices.ts) go to a local inbox the hook drains on the next prompt or tool call.
// cursor per hive so each thing is told once; the first run starts at now so nobody gets a backlog flood.
const DIR = join(homedir(), ".mongo-hive");
const INBOX = join(DIR, "inbox.jsonl");
const CURSOR = join(DIR, "notice-cursor.json");
const LOCK = join(DIR, "notice.lock");
const THROTTLE_MS = 5_000;
const INBOX_MAX_BYTES = 64 * 1024; // a codex-only machine never drains it; keep the newest lines

const ageMs = (p: string) => {
  try { return Date.now() - statSync(p).mtimeMs; } catch { return Infinity; }
};

// every hook call spawns a writer; one at a time fetches, and only if the last fetch is at least 5s old
function takeLock() {
  if (ageMs(LOCK) < 15_000) return false;
  rmSync(LOCK, { force: true }); // stale: a writer that hit its time limit
  try { closeSync(openSync(LOCK, "wx", 0o600)); return true; } catch { return false; }
}

function appendInbox(notices: Notice[]) {
  if (!notices.length) return;
  if (ageMs(INBOX) !== Infinity && statSync(INBOX).size > INBOX_MAX_BYTES) {
    const keep = readFileSync(INBOX, "utf8").trim().split("\n").slice(-100);
    writeFileSync(INBOX, keep.join("\n") + "\n", { mode: 0o600 });
  }
  appendFileSync(INBOX, notices.map((n) => JSON.stringify(n)).join("\n") + "\n", { mode: 0o600 });
  chmodSync(INBOX, 0o600);
}

async function notices() {
  if (user === "unknown" || ageMs(CURSOR) < THROTTLE_MS) return;
  mkdirSync(DIR, { recursive: true, mode: 0o700 });
  if (!takeLock()) return;
  try {
    let cursor: Record<string, string> = {};
    try { cursor = JSON.parse(readFileSync(CURSOR, "utf8")); } catch {}
    const until = new Date();
    const next = { ...cursor };
    const found: Notice[] = [];
    for (const h of await noticeHives(user, process.env.HIVE_SHARED)) {
      const since = cursor[h.name] ? new Date(cursor[h.name]) : null;
      if (since && !isNaN(+since)) found.push(...(await hiveNotices(h.name, user, since, until, h.shared)));
      next[h.name] = until.toISOString();
    }
    appendInbox(found);
    writeFileSync(CURSOR, JSON.stringify(next), { mode: 0o600 });
  } finally {
    rmSync(LOCK, { force: true });
  }
}

// both steps fail silently: the agent never waits on this process, and a dead atlas just means no capture and no notices
main().catch(() => {}).then(() => notices().catch(() => {})).finally(() => client.close().catch(() => {}));
