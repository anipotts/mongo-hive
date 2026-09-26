#!/usr/bin/env node
// starts the repo's mongo-hive mcp server as the joined user. stdio passes straight through.
import { spawn } from "node:child_process";
import { join } from "node:path";
import { bindingFor, detectHarness, readConfig } from "./shim-common.mjs";

const harness = detectHarness(process.argv[2]);
const cfg = readConfig();
if (!cfg?.repoPath) {
  console.error("mongo-hive: not joined yet. run `npx mongo-hive join <hive>` in the mongo-hive repo.");
  process.exit(1);
}
// one project, one hive: the session sees only the hive this project was connected to (`mongo-hive connect`)
const project = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
const bound = bindingFor(cfg, project);
if (!bound?.hive) {
  console.error(`mongo-hive: ${project} isn't connected to a hive. run \`npm run -s mongo-hive -- connect <invite>\` in it.`);
  process.exit(1);
}
const child = spawn(
  join(cfg.repoPath, "node_modules", ".bin", "tsx"),
  [`--env-file=${cfg.envPath}`, join(cfg.repoPath, "src", "mcp", "server.ts")],
  { stdio: "inherit", cwd: cfg.repoPath, env: { ...process.env, HIVE_USER: cfg.user, HIVE_HARNESS: harness, HIVE_HOME: bound.hive, HIVE_SCOPE: bound.hive } },
);
child.on("exit", (code) => process.exit(code ?? 0));
