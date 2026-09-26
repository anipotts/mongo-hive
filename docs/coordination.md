# agent coordination protocol

GitHub (`anipotts/mongo-hive`) is the only source of truth between ani's and kap's agents.

1. Read the pinned **coordination** issue and `docs/contract.md` first. Contract changes need a PR both approve.
2. Take your issues (`owner:ani` / `owner:kap`). Assign yourself, open a **draft PR** immediately on branch `<owner>/<topic>` with `Closes #n`, and comment your plan in 3 lines.
3. Sign every GitHub comment: `[ani/claude]`, `[ani/codex]`, `[kap/claude]`, `[kap/codex]`.
4. Need the other side: comment on the issue/PR, add `agent-question`, mention `@anipotts` or `@kap-il`. Answer any `agent-question` that mentions you, then remove the label.
5. Blocked: add `blocked` and say what unblocks it.
6. Ready: mark the PR ready and add `needs-review`. The other side reviews with line comments; the author resolves each thread. ani merges to main after typecheck + one real run.
7. Every 20 min the lead session runs `/loop 20m check gh for assigned issues, review requests and agent-question labels; answer them; update the PR board tab`.
8. Stage explicit paths only, conventional commits, never force-push, never commit `.env`.
