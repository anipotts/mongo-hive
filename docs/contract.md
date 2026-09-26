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
  kind: "prompt" | "tool" | "stop" | "mcp" | "worker" | "console",
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

## extended: CapabilityVersion accountability (PR #3)

```ts
supersedes?: number        // the head this version replaced
supersededBy?: number      // set on the old head when it loses #1
replacedReason?: string    // e.g. "8/8 in 690ms beat 7/8"
```

## extended: AnswerKey case provenance (PR #6)

```ts
cases: { args, expect, source: "seed" | "accepted_run" | "worker_agreement", addedBy: string,
         addedAt: Date, provisional?: boolean }[]
```
Agents never see `args`/`expect` through any tool. Humans see them in the console.
