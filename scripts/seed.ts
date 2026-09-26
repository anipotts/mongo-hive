// seeds every demo domain (work data in DATA_DB + hidden answer keys in hive_team) and makes sure the hives exist.
import { execFileSync } from "node:child_process";
import { readdirSync, existsSync } from "node:fs";

const run = (args: string[]) => execFileSync("npx", ["tsx", "--env-file=.env", ...args], { stdio: "inherit" });

for (const domain of readdirSync("fixtures").filter((d) => existsSync(`fixtures/${d}/seed.ts`))) {
  console.log(`seeding ${domain}`);
  run([`fixtures/${domain}/seed.ts`]);
}
for (const [name, flag, owner] of [["ani", "--private", "ani"], ["kap", "--private", "kap"], ["team", "--shared", "ani"]] as const) {
  run(["scripts/hive.ts", "create", name, flag, "--owner", owner]);
}
run(["scripts/hive.ts", "invite", "team", "kap"]);
run(["scripts/hive.ts", "list"]);
