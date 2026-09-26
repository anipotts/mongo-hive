# ci failure triage rule

data lives in two collections.

| collection | shape |
|---|---|
| `ci_runs` | `{ _id: run_id, repo, branch, commit, status: "passed"\|"failed", trigger, started_at }` |
| `ci_steps` | `{ run_id, seq, name, stage: "setup"\|"build"\|"test"\|"cleanup", exit_code, log_tail, duration_s }` |

steps that never ran (because an earlier step failed) have no document. `cleanup` always runs.

## triage a failed run

given a `run_id`, produce `{ failing_step, cause, retry_safe }`.

1. **failing_step**: the step of that run with the lowest `seq` whose `exit_code != 0`. later failures (for example `cleanup`) are fallout and are ignored.
2. **cause**: evaluate these in order, first match wins. only the failing step's own `exit_code` and `log_tail` count.
   1. `infra`: `exit_code` is `124` (timeout), `137` (OOM kill) or `143` (SIGTERM), **or** `log_tail` contains, case-insensitively, one of `OOMKilled`, `out of memory`, `ECONNRESET`, `ETIMEDOUT`, `Could not resolve host`, `No space left on device`.
   2. `flaky`: some **earlier** run (`started_at` strictly before this run's) of the **same repo and commit**, on any branch, has a step with the **same name** and `exit_code == 0`.
   3. `test`: the failing step's `stage` is `test`.
   4. `build`: anything else (build, setup, lint, compile, dependency resolution).
3. **retry_safe**: `true` if cause is `infra` or `flaky`, else `false`.

notes

- a later run of the same commit passing does not make an earlier failure flaky.
- a test runner reporting its own per-test timeout (e.g. "Exceeded timeout of 5000 ms") is not an infra marker; only the listed markers and exit codes are.
- infra markers in steps that passed (e.g. a retried download) are irrelevant.
