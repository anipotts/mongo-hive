#!/usr/bin/env node
// starts the repo's mongo-hive mcp server as the joined user. stdio passes straight through.
import { spawn } from "node:child_process";
import { join } from "node:path";
import { detectHarness, readConfig } from "./shim-common.mjs";

const harness = detectHarness(process.argv[2]);
const cfg = readConfig();
if (!cfg?.repoPath) {
  console.error("mongo-hive: not joined yet. run `npx mongo-hive join <hive>` in the mongo-hive repo.");
  process.exit(1);
}
const child = spawn(
  join(cfg.repoPath, "node_modules", ".bin", "tsx"),
  [`--env-file=${cfg.envPath}`, join(cfg.repoPath, "src", "mcp", "server.ts")],
  { stdio: "inherit", cwd: cfg.repoPath, env: { ...process.env, HIVE_USER: cfg.user, HIVE_HARNESS: harness } },
);
child.on("exit", (code) => process.exit(code ?? 0));
