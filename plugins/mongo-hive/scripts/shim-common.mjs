// shared by the plugin shims: read the identity written by `mongo-hive join`. plain node, no deps.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const CONFIG_PATH = process.env.MONGO_HIVE_CONFIG ?? join(homedir(), ".mongo-hive", "config.json");

// the same plugin runs under claude code and codex; claude code marks its subprocesses with CLAUDECODE=1
export const detectHarness = (fallback) => process.env.MONGO_HIVE_HARNESS ?? (process.env.CLAUDECODE ? "claude-code" : fallback ?? "codex");

export function readConfig() {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    return null;
  }
}
