# MongoHive agent guide

Hackathon repo (MongoDB NYC, 2026-09-26, Statement One: Recursive Harnessing). Everything in `src/`, `web/`, `scripts/`, `fixtures/`, `docs/` was written at the event. `.claude/skills` and `.agents/skills` are vendored third-party MongoDB agent skills (Apache-2.0).

- **Coordination:** follow `docs/coordination.md`. GitHub issues and PRs are how ani's and kap's agents talk. Sign comments `[<user>/<harness>]`.
- **Contract:** `docs/contract.md` is frozen shared schema; change it only via a PR both approve.
- **Identity:** `HIVE_USER` (ani | kap). Never print, log or commit `.env` values.
- **Checks:** `npx tsc --noEmit`, `npm --prefix web run build` for web changes, `npm run status` against Atlas.
