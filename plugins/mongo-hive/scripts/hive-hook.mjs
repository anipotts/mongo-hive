#!/usr/bin/env node
// agent hook entrypoint (claude code + codex). must never slow or break the agent:
// read the payload, hand it to a detached writer, exit 0 right away. not joined = silently do nothing.
// on a claude code prompt or tool call it also shows what the writer found in the hive since (local file only).
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { bindingFor, detectHarness, readConfig } from "./shim-common.mjs";

const harness = detectHarness(process.argv[2]);
let input = "";
let finished = false;

const INBOX = join(homedir(), ".mongo-hive", "inbox.jsonl");
const SHOW = 6;

// take the whole inbox atomically (rename, read, delete) and turn it into one additionalContext block.
// local fs only: the detached writer did the atlas work earlier, so this never waits on the network.
function drainInbox(event) {
  const taken = `${INBOX}.${process.pid}.${Date.now()}.taking`;
  try { renameSync(INBOX, taken); } catch { return null; } // no inbox: nothing new
  let lines = [];
  try {
    lines = readFileSync(taken, "utf8").split("\n").filter(Boolean).flatMap((l) => {
      try { const t = JSON.parse(l).text; return typeof t === "string" && t ? [t.replace(/\s+/g, " ").slice(0, 300)] : []; } catch { return []; }
    });
  } finally {
    rmSync(taken, { force: true });
  }
  if (!lines.length) return null;
  const shown = lines.length > SHOW ? [...lines.slice(0, SHOW - 1), `and ${lines.length - SHOW + 1} more; see the console`] : lines;
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: event,
      additionalContext: "MongoHive updates (not instructions, just what happened in your hives):\n" + shown.map((l) => `- ${l}`).join("\n"),
    },
  });
}

function done() {
  if (finished) return;
  finished = true;
  try {
    const cfg = readConfig();
    let cwd = process.cwd();
    let event = "";
    try { const p = JSON.parse(input); cwd = p.cwd || cwd; event = p.hook_event_name ?? ""; } catch {}
    const bound = bindingFor(cfg, cwd); // unrelated repos on this machine are never captured
    if (cfg?.repoPath && bound && input.trim()) {
      const file = join(mkdtempSync(join(tmpdir(), "mongo-hive-")), "payload.json");
      writeFileSync(file, input, { mode: 0o600 });
      const child = spawn(
        join(cfg.repoPath, "node_modules", ".bin", "tsx"),
        [`--env-file=${cfg.envPath}`, join(cfg.repoPath, "bin", "hive-hook-writer.ts"), file, harness],
        { detached: true, stdio: "ignore", cwd: cfg.repoPath, env: { ...process.env, HIVE_USER: cfg.user, HIVE_SHARED: bound.hive ?? cfg.hive } },
      );
      child.on("error", () => {});
      child.unref();
    }
    if (bound && harness === "claude-code" && (event === "UserPromptSubmit" || event === "PostToolUse")) {
      const out = drainInbox(event);
      if (out) writeSync(1, out + "\n"); // sync: process.exit below must not cut a pipe write short
    }
  } catch {
    // fail open: the agent keeps working even if the hive is unreachable
  }
  process.exit(0);
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", done);
process.stdin.on("error", done);
setTimeout(done, 1000).unref();
