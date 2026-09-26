// mongo-hive cli: join a hive, wire codex, leave cleanly.
//   join <hive> [--user <name>]   feedback <outputId> correct|wrong [--expect '<json>']
//   install codex   uninstall codex   leave   whoami
// identity lives in ~/.mongo-hive/config.json (no secrets: only paths and names).
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ENV_PATH = join(REPO, ".env");
const CONFIG_DIR = join(homedir(), ".mongo-hive");
const CONFIG_PATH = process.env.MONGO_HIVE_CONFIG ?? join(CONFIG_DIR, "config.json");
const CODEX_CONFIG = process.env.CODEX_CONFIG ?? join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "config.toml");
const BEGIN = "# >>> mongo-hive (managed by `mongo-hive install codex`; remove with `mongo-hive uninstall codex`)";
const END = "# <<< mongo-hive";

const [cmd, arg, ...rest] = process.argv.slice(2);
const opt = (f: string) => (rest.includes(f) ? rest[rest.indexOf(f) + 1] : undefined);

const envHas = (key: string) => existsSync(ENV_PATH) && new RegExp(`^${key}=.+`, "m").test(readFileSync(ENV_PATH, "utf8"));
const envValue = (key: string) => (existsSync(ENV_PATH) ? readFileSync(ENV_PATH, "utf8").match(new RegExp(`^${key}=(.*)$`, "m"))?.[1]?.trim() : undefined);

function setEnvKey(key: string, value: string) {
  const text = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, "utf8") : "";
  const lines = text.split("\n").filter((l) => !l.startsWith(`${key}=`) && l !== "");
  writeFileSync(ENV_PATH, [...lines, `${key}=${value}`].join("\n") + "\n", { mode: 0o600 });
}

async function join_(hiveName: string) {
  const user = opt("--user") ?? envValue("HIVE_USER") ?? process.env.USER ?? "unknown";
  if (!envHas("MONGODB_URI")) {
    console.log(`no atlas login in .env yet; creating database user ${user} (password never printed)`);
    execFileSync(join(REPO, "scripts", "setup-db-user.sh"), [user], { stdio: "inherit", cwd: REPO });
  }
  setEnvKey("HIVE_USER", user);
  process.env.HIVE_USER = user;
  process.loadEnvFile?.(ENV_PATH);
  const { client, ensureHive, hives } = await import("../src/registry/db.js");
  try {
    await ensureHive(user, "private", user);
    const info = await hives.findOne({ _id: hiveName });
    if (!info) await ensureHive(hiveName, "shared", user);
    else if (info.visibility !== "shared" && info.owner !== user) throw new Error(`hive ${hiveName} is private to ${info.owner}`);
    else await hives.updateOne({ _id: hiveName }, { $addToSet: { members: user } });
  } finally {
    await client.close();
  }
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify({ user, hive: hiveName, repoPath: REPO, envPath: ENV_PATH }, null, 2) + "\n", { mode: 0o600 });
  console.log(`joined hive ${hiveName} as ${user}; private hive ${user}. identity: ${CONFIG_PATH}`);
}

function stripBlock(text: string) {
  const start = text.indexOf(BEGIN);
  if (start === -1) return text;
  const end = text.indexOf(END, start);
  if (end === -1) return text;
  let after = end + END.length;
  if (text[after] === "\n") after++;
  let before = start;
  if (before > 0 && text[before - 1] === "\n" && text[before - 2] === "\n") before--; // the blank line we added
  return text.slice(0, before) + text.slice(after);
}

function installCodex() {
  const script = join(REPO, "plugins", "mongo-hive", "scripts", "hive-mcp.mjs");
  const text = existsSync(CODEX_CONFIG) ? readFileSync(CODEX_CONFIG, "utf8") : "";
  if (existsSync(CODEX_CONFIG)) copyFileSync(CODEX_CONFIG, `${CODEX_CONFIG}.mongo-hive.bak`);
  const clean = stripBlock(text);
  const block = [BEGIN, "[mcp_servers.mongo-hive]", `command = "node"`, `args = [${JSON.stringify(script)}]`, `env = { MONGO_HIVE_HARNESS = "codex" }`, END].join("\n");
  const sep = clean === "" || clean.endsWith("\n\n") ? "" : clean.endsWith("\n") ? "\n" : "\n\n";
  mkdirSync(dirname(CODEX_CONFIG), { recursive: true });
  writeFileSync(CODEX_CONFIG, clean + sep + block + "\n");
  console.log(`codex: mongo-hive mcp server added to ${CODEX_CONFIG} (backup at ${CODEX_CONFIG}.mongo-hive.bak)`);
  console.log("codex hooks: run `codex plugin marketplace add anipotts/mongo-hive && codex plugin add mongo-hive@mongo-hive` to record sessions too");
}

function uninstallCodex() {
  if (!existsSync(CODEX_CONFIG)) return console.log("codex: no config, nothing to remove");
  const text = readFileSync(CODEX_CONFIG, "utf8");
  const clean = stripBlock(text);
  if (clean === text) return console.log("codex: no mongo-hive block found");
  writeFileSync(CODEX_CONFIG, clean);
  console.log(`codex: removed the mongo-hive block from ${CODEX_CONFIG}`);
}

// a person judges one agent run; it becomes an eval for that tool in its hive. never exposed as an mcp tool.
async function feedback(outputId: string, verdict: string) {
  if (verdict !== "correct" && verdict !== "wrong") throw new Error("usage: mongo-hive feedback <outputId> correct|wrong [--expect '<json>'] [--hive <name>]");
  const cfg = existsSync(CONFIG_PATH) ? JSON.parse(readFileSync(CONFIG_PATH, "utf8")) : {};
  const by = opt("--user") ?? cfg.user ?? envValue("HIVE_USER");
  if (!by) throw new Error("not joined: run `mongo-hive join <hive>` first");
  const raw = opt("--expect");
  let correction: Record<string, unknown> | undefined;
  if (raw) {
    try { correction = JSON.parse(raw); } catch { throw new Error("--expect must be a JSON object, e.g. '{\"culprit_deploy_id\":\"dep_1033\"}'"); }
  }
  process.loadEnvFile?.(ENV_PATH);
  const { client, hive, myHives } = await import("../src/registry/db.js");
  const { giveFeedback } = await import("../src/hive/feedback.js");
  try {
    const want = opt("--hive");
    let h: ReturnType<typeof hive> | undefined;
    for (const info of await myHives(by)) {
      if (want && info._id !== want) continue;
      const cand = hive(info._id);
      if (await cand.outputs.findOne({ _id: outputId }, { projection: { _id: 1 } })) { h = cand; break; }
    }
    if (!h) throw new Error(`no run ${outputId} in your hives${want ? ` (looked in ${want})` : ""}`);
    const r = await giveFeedback({ h, outputId, by, harness: "cli", verdict, correction });
    if (!r.ok) throw new Error(r.error);
    console.log(r.summary);
  } finally {
    await client.close();
  }
}

if (cmd === "join" && arg) await join_(arg);
else if (cmd === "feedback" && arg) await feedback(arg, rest[0]);
else if (cmd === "install" && arg === "codex") installCodex();
else if (cmd === "uninstall" && arg === "codex") uninstallCodex();
else if (cmd === "leave") {
  uninstallCodex();
  rmSync(CONFIG_PATH, { force: true });
  console.log("left: local identity removed. your work in atlas stays (archive, never delete). claude code: /plugin uninstall mongo-hive");
} else if (cmd === "whoami") console.log(existsSync(CONFIG_PATH) ? readFileSync(CONFIG_PATH, "utf8") : "not joined");
else console.log("usage: mongo-hive join <hive> [--user <name>] | feedback <outputId> correct|wrong [--expect '<json>'] | install codex | uninstall codex | leave | whoami");
