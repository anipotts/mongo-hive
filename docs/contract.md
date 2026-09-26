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
{ _id, hive: string, sessionId?: string, trigger: "repetition" | "session_end" | "improve" | "compose" | "split",
  step: "queued" | "drafting" | "validating" | "proposed" | "rejected" | "skipped",
  capId?: string, v?: number, verdict?: { passed: number, total: number, headPassed?: number },
  model?: string, note?: string, claimedBy?: string, createdAt: Date, updatedAt: Date }
```
Claimed with `findOneAndUpdate({step:"queued"}, {$set:{step:"drafting", claimedBy}})`.

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
**No self-certifying:** `validate()` never scores a version on cases its own author added (`addedBy === version.author`).

## new: outputs (#7: run_capability writes, feedback reads)

```ts
{ _id: "out_xxxxxxxx", eventId, capId: string, v: number, args, result: object[], user, harness, at: Date,
  feedback?: { verdict: "correct" | "wrong", by: string, at: Date, caseIndex: number } }
```
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
