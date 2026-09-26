// deps domain: repos, lockfiles, advisories + hidden answer key for advisory_impact.
// touches only dep_repos, dep_lockfiles, dep_advisories and answer_keys/_id=advisory_impact.
import { answerKeys, client, db } from "../../src/registry/db.js";

type Ver = { major: number; minor: number; patch: number };
const parse = (s: string): Ver => {
  const [major, minor, patch] = s.split(".").map(Number);
  return { major, minor, patch };
};
const cmp = (a: Ver, b: Ver) => a.major - b.major || a.minor - b.minor || a.patch - b.patch;

const repos: [string, string, boolean][] = [
  ["web-app", "frontend", false],
  ["admin-dashboard", "frontend", false],
  ["marketing-site", "frontend", true],
  ["api-gateway", "platform", false],
  ["auth-service", "platform", false],
  ["billing-service", "payments", false],
  ["invoice-worker", "payments", false],
  ["notification-service", "platform", false],
  ["search-indexer", "data", false],
  ["etl-pipeline", "data", false],
  ["ml-feature-store", "data", false],
  ["mobile-bff", "mobile", false],
  ["legacy-monolith", "platform", true],
  ["cli-tools", "devex", false],
  ["docs-site", "devex", false],
];

// "pkg@ver" ; trailing "!" = direct dependency
const locks: Record<string, string[]> = {
  "web-app": ["lodash@4.17.15!", "axios@1.6.2!", "follow-redirects@1.15.4", "braces@3.0.2", "semver@7.5.4", "cookie@0.5.0"],
  "admin-dashboard": ["lodash@4.17.21!", "lodash-es@4.17.15!", "axios@1.4.0!", "follow-redirects@1.15.2", "braces@3.0.3", "ws@8.16.0"],
  "marketing-site": ["lodash@4.17.10!", "axios@1.5.0!", "follow-redirects@1.14.0", "minimist@1.2.0", "braces@2.3.2"],
  "api-gateway": ["express@4.18.2!", "cookie@0.5.0", "jsonwebtoken@9.0.0!", "ws@8.13.0!", "semver@7.3.8", "minimist@1.2.8"],
  "auth-service": ["express@4.19.2!", "cookie@0.6.0", "jsonwebtoken@8.5.1!", "semver@7.5.1", "lodash@4.17.20"],
  "billing-service": ["express@4.17.1!", "cookie@0.4.0", "axios@1.6.7!", "follow-redirects@1.15.5", "lodash@4.17.19!", "lodash@4.16.6"],
  "invoice-worker": ["axios@1.6.8!", "follow-redirects@1.15.6", "tar@6.1.11", "minimist@1.2.5", "semver@6.3.1"],
  "notification-service": ["ws@8.17.0!", "express@4.19.1!", "cookie@0.6.0", "jsonwebtoken@7.4.3!"],
  "search-indexer": ["tar@6.2.0!", "minimist@1.2.6", "braces@3.0.2", "semver@7.5.0", "semver@6.3.1", "lodash@4.17.21"],
  "etl-pipeline": ["tar@5.0.5!", "minimist@0.2.1", "axios@0.27.2", "lodash@4.17.11", "braces@3.0.2"],
  "ml-feature-store": ["ws@7.5.9", "axios@1.3.4!", "follow-redirects@1.15.1", "semver@7.5.2", "braces@3.0.1"],
  "mobile-bff": ["express@4.18.1!", "cookie@0.5.0", "ws@8.11.0", "jsonwebtoken@8.5.1!", "axios@1.6.5!", "follow-redirects@1.15.3", "follow-redirects@1.14.9"],
  "legacy-monolith": ["express@4.16.0!", "jsonwebtoken@5.0.0!", "lodash@3.10.1!", "minimist@0.0.8", "tar@6.0.1", "cookie@0.3.1", "follow-redirects@1.13.0"],
  "cli-tools": ["minimist@1.2.5!", "semver@7.3.5!", "semver@5.7.1", "tar@6.1.0!", "braces@3.0.0", "lodash@4.17.21"],
  "docs-site": ["lodash@4.17.20!", "braces@3.0.2", "ws@8.17.1", "cookie@0.7.1", "follow-redirects@1.15.6"],
};

// affected range is inclusive on both ends; fixed_in null = no fix released
const advisories: [string, string, string, string, string | null, string][] = [
  ["ADV-001", "lodash", "4.0.0", "4.17.20", "4.17.21", "prototype pollution in zipObjectDeep"],
  ["ADV-002", "axios", "1.3.0", "1.6.7", "1.6.8", "SSRF via protocol-relative URL"],
  ["ADV-003", "minimist", "0.0.0", "1.2.5", "1.2.6", "prototype pollution"],
  ["ADV-004", "express", "4.0.0", "4.19.1", "4.19.2", "open redirect in res.location"],
  ["ADV-005", "jsonwebtoken", "0.0.0", "8.5.1", "9.0.0", "insecure key type validation"],
  ["ADV-006", "semver", "7.0.0", "7.5.1", "7.5.2", "ReDoS in range parsing"],
  ["ADV-007", "ws", "8.0.0", "8.17.0", "8.17.1", "DoS via many HTTP headers"],
  ["ADV-008", "follow-redirects", "0.0.0", "1.15.5", "1.15.6", "proxy-authorization header leak"],
  ["ADV-009", "tar", "6.0.0", "6.2.0", null, "unbounded memory in header parsing"],
  ["ADV-010", "braces", "0.0.0", "3.0.2", "3.0.3", "uncontrolled resource consumption"],
  ["ADV-011", "cookie", "0.0.0", "0.6.0", "0.7.0", "out-of-bounds characters in cookie name"],
  ["ADV-012", "lodash", "4.0.0", "4.17.15", "4.17.16", "prototype pollution in merge"],
];

const repoDocs = repos.map(([name, team, archived]) => ({ name, team, archived }));
const lockDocs = Object.entries(locks).flatMap(([repo, entries]) =>
  entries.map((e) => {
    const direct = e.endsWith("!");
    const [pkg, version] = e.replace("!", "").split("@");
    return { repo, package: pkg, version, ...parse(version), direct };
  }),
);
const advDocs = advisories.map(([id, pkg, min, max, fixed, summary]) => ({
  id,
  package: pkg,
  summary,
  affected: { min: parse(min), max: parse(max) },
  affected_range: `>=${min} <=${max}`,
  fixed_in: fixed ? { version: fixed, ...parse(fixed) } : null,
}));

// reference implementation of fixtures/deps/RULES.md
function answer(advId: string) {
  const a = advDocs.find((x) => x.id === advId)!;
  const archived = new Set(repoDocs.filter((r) => r.archived).map((r) => r.name));
  const byRepo = new Map<string, boolean[]>();
  for (const l of lockDocs) {
    if (l.package !== a.package || archived.has(l.repo)) continue;
    if (cmp(l, a.affected.min) < 0 || cmp(l, a.affected.max) > 0) continue;
    const fix = !!a.fixed_in && a.fixed_in.major === l.major && a.fixed_in.minor === l.minor;
    byRepo.set(l.repo, [...(byRepo.get(l.repo) ?? []), fix]);
  }
  const affected_repos = [...byRepo.keys()].sort();
  const patch_fixable = [...byRepo].filter(([, f]) => f.every(Boolean)).map(([r]) => r).sort();
  return { affected_repos, patch_fixable };
}

const KEY = ["ADV-003", "ADV-004", "ADV-005", "ADV-007", "ADV-008", "ADV-009", "ADV-010", "ADV-011"];

await db.collection("dep_repos").drop().catch(() => {});
await db.collection("dep_lockfiles").drop().catch(() => {});
await db.collection("dep_advisories").drop().catch(() => {});
await db.collection("dep_repos").insertMany(repoDocs);
await db.collection("dep_lockfiles").insertMany(lockDocs);
await db.collection("dep_advisories").insertMany(advDocs);
await db.collection("dep_lockfiles").createIndex({ package: 1, repo: 1 });

await answerKeys.replaceOne(
  { _id: "advisory_impact" },
  { cases: KEY.map((id) => ({ args: { advisory_id: id }, expect: answer(id) })) },
  { upsert: true },
);

console.log(`seeded ${repoDocs.length} repos, ${lockDocs.length} lockfile entries, ${advDocs.length} advisories`);
for (const a of advDocs) {
  const r = answer(a.id);
  console.log(`${KEY.includes(a.id) ? "key " : "free"} ${a.id} ${a.package.padEnd(16)} affected=${r.affected_repos.join(",")} | patch=${r.patch_fixable.join(",")}`);
}
await client.close();
