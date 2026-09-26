// ci/cd failure triage fixture. drops and re-seeds ONLY ci_runs and ci_steps,
// and upserts the hidden answer key `triage_ci_failure`. rule: fixtures/ci/RULES.md
// run: npx tsx --env-file=.env fixtures/ci/seed.ts
import { createHash } from "node:crypto";
import { answerKeys, client, db } from "../../src/registry/db.js";

type Stage = "setup" | "build" | "test" | "cleanup";
interface Run { _id: string; repo: string; branch: string; commit: string; status: "passed" | "failed"; trigger: string; started_at: Date }
interface Step { run_id: string; seq: number; name: string; stage: Stage; exit_code: number; log_tail: string; duration_s: number }

// deterministic prng so the dataset is stable across seeds
let s = 0x5eed;
const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const pick = <T,>(a: T[]) => a[Math.floor(rnd() * a.length)];
const sha = (k: string) => createHash("sha1").update(k).digest("hex").slice(0, 10);

const PIPELINES: Record<string, [string, Stage][]> = {
  "acme/api": [["checkout", "setup"], ["install", "setup"], ["build", "build"], ["typecheck", "build"], ["unit-tests", "test"], ["integration-tests", "test"], ["cleanup", "cleanup"]],
  "acme/web": [["checkout", "setup"], ["install", "setup"], ["lint", "build"], ["build", "build"], ["unit-tests", "test"], ["e2e", "test"], ["cleanup", "cleanup"]],
  "acme/worker": [["checkout", "setup"], ["deps", "setup"], ["build", "build"], ["unit-tests", "test"], ["cleanup", "cleanup"]],
};
const OK_LOGS: Record<string, string[]> = {
  checkout: ["HEAD is now at {c}"],
  install: ["added 1284 packages in 41s", "added 1284 packages in 38s\nwarn: retry 1/3 after ECONNRESET, succeeded"],
  deps: ["go: downloading 42 modules", "go: downloading 42 modules (retry after ETIMEDOUT ok)"],
  build: ["build complete in 22.4s", "compiled 318 files"],
  typecheck: ["tsc: 0 errors"],
  lint: ["eslint: 0 problems"],
  "unit-tests": ["Tests: 412 passed, 412 total", "ok  \tacme/worker/queue\t3.21s"],
  "integration-tests": ["Tests: 88 passed, 88 total"],
  e2e: ["27 passed (1.9m)"],
  cleanup: ["removed workspace"],
};

interface Fail { step: string; exit: number; log: string }
interface Spec { key?: string; repo: string; branch: string; commitKey: string; trigger?: string; fail?: Fail; cleanupFail?: Fail }

const runs: Run[] = [];
const steps: Step[] = [];
let clock = Date.parse("2026-09-20T08:00:00Z");
let n = 1000;
const named: Record<string, string> = {};

function emit(spec: Spec) {
  const id = `R${++n}`;
  clock += Math.floor(20 + rnd() * 70) * 60_000;
  const commit = sha(spec.repo + spec.commitKey);
  const pipe = PIPELINES[spec.repo];
  let failed = false;
  pipe.forEach(([name, stage], i) => {
    if (failed && stage !== "cleanup") return; // skipped steps have no doc
    let exit = 0;
    let log = pick(OK_LOGS[name]).replace("{c}", commit);
    if (spec.fail?.step === name) { exit = spec.fail.exit; log = spec.fail.log; failed = true; }
    if (stage === "cleanup" && spec.cleanupFail) { exit = spec.cleanupFail.exit; log = spec.cleanupFail.log; }
    steps.push({ run_id: id, seq: i + 1, name, stage, exit_code: exit, log_tail: log, duration_s: Math.round(3 + rnd() * (stage === "test" ? 400 : 90)) });
  });
  const anyFail = steps.some((x) => x.run_id === id && x.exit_code !== 0);
  runs.push({ _id: id, repo: spec.repo, branch: spec.branch, commit, status: anyFail ? "failed" : "passed", trigger: spec.trigger ?? "push", started_at: new Date(clock) });
  if (spec.key) named[spec.key] = id;
  return id;
}

let fc = 0;
const filler = (k = 1) => {
  for (let i = 0; i < k; i++) {
    const repo = pick(Object.keys(PIPELINES));
    emit({ repo, branch: pick(["main", "main", "feat/billing", "fix/retry", "chore/deps"]), commitKey: `filler${fc++}` });
  }
};

const ASSERT = (t: string) => `FAIL src/${t}.test.ts\n  ● ${t} › returns totals\n    AssertionError: expected 3 to equal 4\nTests: 1 failed, 411 passed, 412 total`;

// scenario timeline. prior runs are emitted before the runs that depend on them.
filler(3);
// F1 flaky: same commit passed unit-tests earlier, then failed
emit({ repo: "acme/api", branch: "feat/billing", commitKey: "f1" });
filler(2);
emit({ key: "F1", repo: "acme/api", branch: "feat/billing", commitKey: "f1", trigger: "rerun", fail: { step: "unit-tests", exit: 1, log: ASSERT("invoice") } });
filler(2);
// T1 test: same commit failed the same step before too -> not flaky
emit({ repo: "acme/api", branch: "fix/retry", commitKey: "t1", fail: { step: "unit-tests", exit: 1, log: ASSERT("retry") } });
filler(1);
emit({ key: "T1", repo: "acme/api", branch: "fix/retry", commitKey: "t1", trigger: "rerun", fail: { step: "unit-tests", exit: 1, log: ASSERT("retry") } });
filler(2);
// B1 build: typescript compile error
emit({ key: "B1", repo: "acme/api", branch: "feat/billing", commitKey: "b1", fail: { step: "build", exit: 2, log: "src/billing/charge.ts(42,17): error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.\nFound 1 error." } });
filler(2);
// I1 infra: integration tests OOM killed (test stage, but infra wins)
emit({ key: "I1", repo: "acme/api", branch: "main", commitKey: "i1", fail: { step: "integration-tests", exit: 137, log: "Starting postgres fixture...\nRunning 88 tests\nKilled" } });
filler(2);
// F2 flaky: passed on a PR branch, same commit fails e2e on main
emit({ repo: "acme/web", branch: "feat/checkout", commitKey: "f2" });
filler(1);
emit({ key: "F2", repo: "acme/web", branch: "main", commitKey: "f2", fail: { step: "e2e", exit: 1, log: "  1) checkout.spec.ts:31 › pays with saved card\n     Error: locator('#pay').click: element is not attached to the DOM\n  1 failed, 26 passed (2.1m)" } });
filler(2);
// T2 test: per-test runner timeout is NOT infra
emit({ key: "T2", repo: "acme/web", branch: "feat/search", commitKey: "t2", fail: { step: "unit-tests", exit: 1, log: "FAIL src/search.test.tsx\n  ● search › debounces input\n    thrown: Exceeded timeout of 5000 ms for a test.\nTests: 1 failed, 211 passed" } });
filler(2);
// B2 build: dependency resolution error in setup ("resolve" but not an infra marker)
emit({ key: "B2", repo: "acme/web", branch: "chore/deps", commitKey: "b2", fail: { step: "install", exit: 1, log: "npm ERR! code ERESOLVE\nnpm ERR! ERESOLVE unable to resolve dependency tree\nnpm ERR! peer react@\"^18\" from react-dom@19.0.0" } });
filler(2);
// I2 infra: network reset in install
emit({ key: "I2", repo: "acme/web", branch: "main", commitKey: "i2", fail: { step: "install", exit: 1, log: "npm ERR! code ECONNRESET\nnpm ERR! network aborted\nnpm ERR! request to https://registry.npmjs.org/react failed" } });
filler(2);
// T3 (learn): integration test failure, cleanup also fails, a LATER rerun of the same commit passes
emit({ key: "T3", repo: "acme/api", branch: "feat/refunds", commitKey: "t3", fail: { step: "integration-tests", exit: 1, log: ASSERT("refunds") }, cleanupFail: { exit: 1, log: "rm: cannot remove 'tmp/pg': Device or resource busy" } });
filler(1);
emit({ repo: "acme/api", branch: "feat/refunds", commitKey: "t3", trigger: "rerun" });
filler(2);
// I3 (reuse): worker unit tests killed by the 20m step limit (exit 124, no text marker)
emit({ key: "I3", repo: "acme/worker", branch: "main", commitKey: "i3", fail: { step: "unit-tests", exit: 124, log: "=== RUN   TestQueueDrain\nstep exceeded 20m limit, terminated" } });
filler(2);
// F3 (baseline): worker commit passed once, rerun fails unit-tests with an assertion
emit({ repo: "acme/worker", branch: "fix/retry", commitKey: "f3" });
filler(1);
emit({ key: "F3", repo: "acme/worker", branch: "fix/retry", commitKey: "f3", trigger: "rerun", fail: { step: "unit-tests", exit: 1, log: "--- FAIL: TestBackoffJitter (0.02s)\n    backoff_test.go:57: got 412ms, want <= 400ms\nFAIL\tacme/worker/queue\t2.88s" } });
filler(2);
// extra unkeyed failures for variety
emit({ key: "B3", repo: "acme/worker", branch: "feat/billing", commitKey: "b3", fail: { step: "build", exit: 2, log: "./internal/cfg/load.go:42:13: undefined: parseCfg" } });
filler(2);
emit({ key: "I4", repo: "acme/api", branch: "chore/deps", commitKey: "i4", fail: { step: "build", exit: 1, log: "Error: ENOSPC: No space left on device, write" } });
filler(2);
emit({ key: "B4", repo: "acme/web", branch: "feat/search", commitKey: "b4", fail: { step: "lint", exit: 1, log: "src/search.tsx\n  12:7  error  'q' is assigned a value but never used  no-unused-vars\n✖ 1 problem (1 error, 0 warnings)" } });
while (runs.length < 60) filler(1);

// reference implementation of RULES.md, computed from the in-memory rows
const INFRA_EXIT = new Set([124, 137, 143]);
const MARKERS = ["oomkilled", "out of memory", "econnreset", "etimedout", "could not resolve host", "no space left on device"];
function triage(runId: string) {
  const run = runs.find((r) => r._id === runId)!;
  const failing = steps.filter((x) => x.run_id === runId && x.exit_code !== 0).sort((a, b) => a.seq - b.seq)[0];
  const infra = INFRA_EXIT.has(failing.exit_code) || MARKERS.some((m) => failing.log_tail.toLowerCase().includes(m));
  const earlier = runs.filter((r) => r.repo === run.repo && r.commit === run.commit && r.started_at < run.started_at).map((r) => r._id);
  const flaky = steps.some((x) => earlier.includes(x.run_id) && x.name === failing.name && x.exit_code === 0);
  const cause = infra ? "infra" : flaky ? "flaky" : failing.stage === "test" ? "test" : "build";
  return { failing_step: failing.name, cause, retry_safe: cause === "infra" || cause === "flaky" };
}

// double check: reference output must match what each scenario was designed to be
const intended: Record<string, [string, string]> = {
  F1: ["unit-tests", "flaky"], F2: ["e2e", "flaky"], F3: ["unit-tests", "flaky"],
  T1: ["unit-tests", "test"], T2: ["unit-tests", "test"], T3: ["integration-tests", "test"],
  B1: ["build", "build"], B2: ["install", "build"], B3: ["build", "build"], B4: ["lint", "build"],
  I1: ["integration-tests", "infra"], I2: ["install", "infra"], I3: ["unit-tests", "infra"], I4: ["build", "infra"],
};
for (const [k, [step, cause]] of Object.entries(intended)) {
  const got = triage(named[k]);
  if (got.failing_step !== step || got.cause !== cause) throw new Error(`fixture self-check failed for ${k} (${named[k]}): ${JSON.stringify(got)}`);
}

const KEYED = ["F1", "F2", "T1", "T2", "B1", "B2", "I1", "I2"];
const cases = KEYED.map((k) => ({ args: { run_id: named[k] }, expect: triage(named[k]) }));

await db.collection("ci_runs").drop().catch(() => {});
await db.collection("ci_steps").drop().catch(() => {});
await db.collection("ci_runs").insertMany(runs as any[]);
await db.collection("ci_steps").insertMany(steps);
await db.collection("ci_steps").createIndex({ run_id: 1, seq: 1 });
await db.collection("ci_runs").createIndex({ repo: 1, commit: 1, started_at: 1 });
await answerKeys.updateOne({ _id: "triage_ci_failure" }, { $set: { cases } }, { upsert: true });

const failedRuns = runs.filter((r) => r.status === "failed").length;
console.log({ runs: runs.length, steps: steps.length, failedRuns, keyedCases: cases.length });
// ids only (not expectations) for picking learn/reuse/baseline targets outside the key
console.log({ learn: named.T3, reuse: named.I3, baseline: named.F3, extra: [named.B3, named.I4, named.B4] });
if (process.argv.includes("--show-key")) console.log(JSON.stringify(cases, null, 1));
await client.close();
