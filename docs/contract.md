# MongoHive contract

Shared shapes both teams build against. Changing this file needs a PR approved by both ani and kap.
Existing types live in `src/registry/types.ts` (Capability, CapabilityVersion, AnswerKey, HiveAgent, HiveInfo).

## layout

- `honeycomb.hives`: registry of hives (`HiveInfo`)
- `hive_<name>`: one database per hive: `capabilities`, `answer_keys`, `agents`, `events`, `runs`, `evaluations`, plus the new collections below
- `harness`: shared work data (ci_*, inc_*, dep_*)

## new: sessions (PR #2 writes, console reads)

```ts
{ _id: string, user: string, harness: "claude-code" | "codex" | string, machine: string,
  cwd: string, title?: string, startedAt: Date, lastEventAt: Date, endedAt?: Date }
```

## extended: events (hooks + mcp server write)

```ts
{ runId?: string, sessionId?: string, user, harness,
  kind: "prompt" | "tool" | "stop" | "mcp" | "worker" | "console" | "feedback",
  tool?: string, argsPreview?: string /* <= 500 chars, redacted */, resultPreview?: string /* <= 500 */,
  ms?: number, at: Date }
```
Never store raw file contents, env values or secrets. Hooks are fail-open: if Atlas is down the agent keeps working.

## new: worker_jobs (PR #4 / #6 write, console reads)

```ts
{ _id, hive: string, sessionId?: string, trigger: "repetition" | "session_end" | "improve" | "compose" | "split" | "check",
  step: "queued" | "drafting" | "validating" | "proposed" | "rejected" | "skipped",
  capId?: string, v?: number, verdict?: { passed: number, total: number, headPassed?: number },
  model?: string, note?: string, claimedBy?: string, createdAt: Date, updatedAt: Date }
```
Claimed with `findOneAndUpdate({step:"queued"}, {$set:{step:"drafting", claimedBy}})`.

**check jobs (auto-check, 2026-09-26).** `trigger: "check"` checks one untested version: `capId` and `v` (the version being checked) are set at queue time; at most one open check job (`queued | drafting | validating`) per `capId` (`queueCheck()` in `src/worker/index.ts`). Queued when a publish lands unverified in a shared hive, when `run_capability` runs an unverified version in a shared hive, and by the worker's 30s sweep for any tool with no promoted version whose latest unverified version has runs with no `check` and no `feedback` (held off for 10 minutes after a check job for that tool closed). Steps: `queued → drafting` (the worker writes its own reference implementation) `→ validating` (replaying runs) `→ proposed` (finished normally, whatever the agreement; `verdict: {passed: <agreeing runs>, total: <checked runs>}`, `note` e.g. "agrees on 5 runs, promoted v1" / "agrees on 3 runs, 2 need a person to judge") or `skipped` (ineligible or unusable reference; `note` says why, e.g. "no runs to check yet").
- **eligibility:** in a shared hive the checking person's worker must not be the version's author and must be a member; otherwise the job is handed back (`step: "queued"`, `claimedBy` unset) for a teammate's worker. In a private hive only the owner's worker checks, record-only: `outputs.check` is set, no evals, no promotion.
- **reference prompt:** tool id, directive, whenToUse, params, the output field names with their JSON types (keys of a stored result doc, never values) and a work-data sample of the version's collection domain (with `_id`, so the model sees how records are keyed). Never the author's implementation, never any stored result value. The reference must pass the same read-only, allowed-collection and no-hard-coded-data rules as any draft.
- **runs checked:** outputs of that `capId` + `v` with no `check` and no `feedback`, newest first, at most 12 distinct inputs (every unchecked output with one of those inputs is checked). A run agrees when the author's run and the reference each returned exactly one document and they match under `validate()`'s rule (`matches()`).
- **shared hive:** one eval per agreeing input the tool has no eval for yet (see answer keys below). Zero disagreements and at least one agreement → re-score (`rescore()`), which promotes through `syncHead` when the pass rate clears the floor. Any disagreement → no re-score: a person judges the disagreeing runs and their feedback re-scores.
- **event:** `{ runId: "worker", kind: "worker", tool: "check", actor, verb: "checked", args: {id, v}, result: {agree, disagree, promoted} }`.

## tool contract: id + params, frozen (PR #27)

Every promoted tool is also a native MCP tool (`mcp__mongo-hive__<tool id>`, prefixed `<hive>__` on a cross-hive name clash).
Agents cache tool definitions, so a tool's definition never changes after it exists:

- **contract = tool id + params.** A version whose params differ from the tool's is rejected ("inputs changed: publish it under a new tool name").
- **description is timeless:** directive + whenToUse only. No version, score or author.
- **live status rides in every result:** `ran: "ran promoted v3 · 10/10 evals"`, plus `updated: "updated since you last ran it: v2 → v3 by kap's worker"` when your last run used another version.
- **`tools/list_changed` only on add or retire** of a tool, never on promotion. A call whose tool was retired or whose inputs no longer match fails with a clear error pointing to `find_capability` / `run_capability`.

## extended: CapabilityVersion accountability (PR #3)

```ts
supersedes?: number        // the head this version replaced
supersededBy?: number      // set on the old head when it loses #1
replacedReason?: string    // e.g. "8/8 in 690ms beat 7/8"
```

## extended: AnswerKey case provenance (#7, `EvalCase` in types.ts)

```ts
cases: { args, expect, category?: string,
         source?: "seed" | "accepted_run" | "corrected_run" | "worker_agreement",
         addedBy?: string, addedAt?: Date, outputId?: string, provisional?: boolean }[]
```
Seeded cases carry no `source`/`addedBy`. Agents never see `args`/`expect` through any tool. Humans see them in the console.
**Auto-check evals (auto-check, 2026-09-26):** `{ args, expect: <the author's stored single result doc>, category: "auto-check", source: "worker_agreement", addedBy: <checker person>, addedAt, outputId, provisional: true }`. Written only in shared hives, only for runs where an independent reference agreed, and never by the version's author, so they can score that author's version. `provisional` marks them as machine agreement, distinct from seeded evals and human feedback.
**No self-certifying:** `validate()` never scores a version on cases its own author added (`addedBy === version.author`).

## new: outputs (#7: run_capability writes, feedback reads)

```ts
{ _id: "out_xxxxxxxx", eventId, capId: string, v: number, args, result: object[], user, harness, at: Date,
  feedback?: { verdict: "correct" | "wrong", by: string, at: Date, caseIndex: number },
  check?: { agree: boolean, by: string /* checker person */, at: Date, jobId: string } /* auto-check, 2026-09-26 */ }
```
`check` is set once by a check job and never changes the run's result. `check.agree === false` with no `feedback` means the run is waiting for a person to judge it.
`run_capability` returns `outputId`. Feedback is human-only (CLI `mongo-hive feedback`, `/mongo-hive:accept|reject`, console via `giveFeedback()` in `src/hive/feedback.ts`); there is no MCP tool for it. One judgment per output (idempotent).
- `correct` → case `{args, expect: result[0], source: "accepted_run"}`; `wrong` → case `{args, expect: <person's answer>, source: "corrected_run"}`.
- Every new case re-scores the tool's active / superseded / unverified versions; the leaderboard picks the head; a head below 100% queues a `worker_jobs` `{trigger: "improve", step: "queued"}` (one open job per tool).
- A shared hive with no evals for a tool takes a publish as `unverified`: runnable on trial by members, can't lead until feedback gives it evals.
- Feedback events: `{ kind: "feedback", tool: "feedback", actor, verb: "gave feedback", args: {id, v, outputId, verdict}, result: {verdict, evals, head, score} }`.

## new: invites (#34, #42): `honeycomb.invites`

```ts
{ _id: string /* code, "hv-" + 10 chars */, hive: string, createdBy: string, for?: string,
  createdAt: Date, expiresAt: Date, usedBy: { user: string, at: Date }[], revoked?: boolean }
```
Only members of a shared hive create invites. An invite never carries credentials or connection strings; redeeming adds membership only if the hive is still shared, otherwise it fails. Untargeted codes admit anyone holding them until `expiresAt` (24h by default).
