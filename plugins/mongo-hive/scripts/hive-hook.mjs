#!/usr/bin/env node
// agent hook entrypoint (claude code + codex). must never slow or break the agent:
// read the payload, hand it to a detached writer, exit 0 right away. not joined = silently do nothing.
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectHarness, readConfig } from "./shim-common.mjs";

const harness = detectHarness(process.argv[2]);
let input = "";
let finished = false;

function done() {
  if (finished) return;
  finished = true;
  try {
    const cfg = readConfig();
    if (cfg?.repoPath && input.trim()) {
      const file = join(mkdtempSync(join(tmpdir(), "mongo-hive-")), "payload.json");
      writeFileSync(file, input, { mode: 0o600 });
      const child = spawn(
        join(cfg.repoPath, "node_modules", ".bin", "tsx"),
        [`--env-file=${cfg.envPath}`, join(cfg.repoPath, "bin", "hive-hook-writer.ts"), file, harness],
        { detached: true, stdio: "ignore", cwd: cfg.repoPath, env: { ...process.env, HIVE_USER: cfg.user, HIVE_SHARED: cfg.hive } },
      );
      child.on("error", () => {});
      child.unref();
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
