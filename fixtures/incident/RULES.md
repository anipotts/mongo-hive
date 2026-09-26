# incident blame rules

on-call question: which deploy most likely caused the error spike on service S that started at minute T, and should we roll it back?

## data

| collection | shape |
|---|---|
| `inc_services` | `{_id: service name, owner, tier, depends_on: [service names]}` (direct upstream dependencies only) |
| `inc_deploys` | `{_id: "dep_NNNN", service, at: Date, kind: "code" \| "config", status: "succeeded" \| "failed", author, commit, summary}` |
| `inc_errors` | `{service, minute: Date, count}` one doc per service per minute (UTC) |

## rule

1. candidate deploys are deploys whose `service` is S itself or one of S's direct `depends_on` services (not transitive, not services that depend on S).
2. only `status: "succeeded"` deploys count. failed deploys never went live.
3. only deploys with `T - 30 minutes <= at <= T` count (both ends inclusive). deploys after T cannot be the cause.
4. culprit = the candidate with the latest `at`. if there is none, the spike is infra: culprit is null.
5. rollback = true only if a culprit exists and its `kind` is not `"config"` (config changes are reverted by flag/config push, not rollback).

## answer shape

exactly one document: `{culprit_deploy_id: "dep_NNNN" | null, rollback: true | false}`. `culprit_deploy_id` must be present and explicitly `null` when there is no culprit.

`inc_errors` confirms the spike start (first minute where the count jumps well above that service's baseline); T is given as an ISO-8601 UTC string like `2026-09-24T04:00:00Z`.
