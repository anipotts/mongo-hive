# MongoHive glossary

One word per idea, used the same way in code comments, agent replies, the console, the README and the pitch.

| say | means | not |
|---|---|---|
| **honeycomb** | the Atlas cluster: every hive together | cluster |
| **hive** | one team or person's workspace, one database `hive_<name>` | project, room |
| **tool** | a reusable, parameterized, read-only implementation an agent can run | capability, skill, recipe |
| **implementation** | a tool version's code (a MongoDB aggregation today) | recipe |
| **version** | one implementation of a tool (`v1`, `v2` ...), never overwritten | revision |
| **evals** | the hive's held-out test cases; agents never see their inputs | hidden cases, answer key, tests |
| **promoted version** | the version currently #1 on a tool's leaderboard | head, active |
| **leaderboard** | a tool's versions ranked by eval pass rate, then speed, then age | ranking |
| **worker** | the background agent that drafts, tests and improves tools | keeper, forager |
| **feedback** | a person marking a tool's answer correct or wrong; it becomes an eval | accept run, grading |
| **publish** | copy a version from your private hive into a shared hive, where its evals decide | push, share |
| **pin** | stay on a specific version regardless of the leaderboard | lock |
| **up to date / update available / yours is better, publish it / pinned** | your standing on a tool | on #1 / better available / yours beats team |

Pitch line: *npm and CI for the tools your agents invent. Tools are code, evals are tests, promotion is a release, sync is an update.*
