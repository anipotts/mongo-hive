# MongoHive

**my agent learned it, so yours already knows it.**


built at the MongoDB Harness Engineering & Model Wrangling Hackathon, NYC, 2026-09-26. **statement one: recursive harnessing.**

a shared hive of tested, versioned agent tools in MongoDB Atlas. when one teammate's agent learns a tool and it passes hidden tests, every other teammate's agent (claude code, codex, any MCP client) is notified via change streams and uses the same version. bad versions are rejected before they reach anyone.

## quickstart

```bash
git clone https://github.com/anipotts/mongo-hive && cd mongo-hive && npm install
npm run mongo-hive -- join team          # identity in ~/.mongo-hive/config.json; creates your atlas login if .env has none
```

**claude code**

```
/plugin marketplace add anipotts/mongo-hive
/plugin install mongo-hive@mongo-hive
```

**codex**

```bash
npm run mongo-hive -- install codex      # adds a marked mcp block to ~/.codex/config.toml
codex plugin marketplace add anipotts/mongo-hive && codex plugin add mongo-hive@mongo-hive   # session hooks
```

**uninstall**

```bash
npm run mongo-hive -- uninstall codex    # removes exactly the marked block
codex plugin remove mongo-hive@mongo-hive
npm run mongo-hive -- leave              # removes local identity; your atlas history is kept
```
and in claude code: `/plugin uninstall mongo-hive@mongo-hive`.

**what gets recorded:** session start/end, your prompts and each tool call's name plus a 500-character preview of its input and output, in your hive's `sessions` and `events`. secrets that look like keys, tokens, passwords or connection strings are redacted before they leave your machine. **never recorded:** file contents beyond those previews, `.env` values, anything when you haven't joined. hooks are fail-open: if atlas is unreachable your agent keeps working.

## how it works

- **honeycomb** = the Atlas cluster. **hive** = one database (`hive_<name>`) with its own tools, hidden test cases, agents and traces. `honeycomb.hives` records who owns and belongs to each hive.
- every user has a **private hive**. agents `explore` work data, then `propose_capability` saves a parameterized, read-only recipe there. with no hidden cases it stays `unverified`: usable by you, trusted by nobody else.
- `publish_capability` copies only the recipe (never your trace) into a **shared hive** you belong to. hard-coded data values are refused. the shared hive's own hidden cases decide: pass all and beat the head, and it becomes the head in one atomic write.
- teammates' agents get a change-stream notice, find it with `find_capability`, and use it with `run_capability`. `npm run status` shows who is behind or ahead.
- the server refuses any hive you are not a member of, and agent pipelines can never read hive internals like the hidden cases.

## layout

| path | what |
|---|---|
| `src/mcp` | the hive MCP server: explore, find, run, propose, publish, pin |
| `src/learner` | trace to parameterized, read-only recipe |
| `src/validator` | hidden-case evaluation, the accept rule, the per-tool leaderboard, head accountability |
| `src/worker` | the background worker: drafts and improves tools from failing categories |
| `src/hive` | the one publish path every surface shares |
| `src/registry` | atlas collections and types |
| `bin`, `plugins/mongo-hive` | `mongo-hive join/leave`, the claude code + codex plugin and its hooks |
| `fixtures` | demo work data (ci, incident, deps) and hidden answer keys |
| `web` | the console: evidence of what the hive did, not the product |
| `docs` | shared contract, agent coordination protocol, demo run sheet and Q&A |

## run

```bash
cp .env.example .env   # fill in the atlas sandbox uri
npm install
npm run ping
```

**run the worker:** `npm run worker` keeps one background worker watching every hive. When feedback or a publish leaves a promoted version missing evals, a job is queued and the worker drafts, tests and promotes (or rejects) a new version on its own. Limit it with `-- --hives live` and `-- --rounds 2`.

## built today

Everything in this repo except the vendored skills below was written on 2026-09-26 at the event, starting from an empty repo. The first commit is `ac3fd4a` at 10:39 ET; `git log --reverse` is the full record.

- **written today:** `src/`, `web/`, `bin/`, `plugins/`, `scripts/`, `fixtures/`, `docs/`, this README.
- **how:** ani and kap each drove their own coding agents (Claude Code and Codex). The agents coordinated through this repo's issues and PRs (`docs/coordination.md`) against a frozen shared schema (`docs/contract.md`). Every agent comment is signed `[user/harness]`.
- **dependencies** come from npm (`package.json`, `web/package.json`); none of them are forks.

### third-party: vendored MongoDB agent skills

`.claude/skills/` and `.agents/skills/` are identical copies of MongoDB's official agent skills, **not written by us**. They are Apache-2.0: see `LICENSE-mongodb-agent-skills` in each folder. We vendored them unchanged (commit `90a2863`) so both Claude Code and Codex load them: `mongodb-connection`, `mongodb-mcp-setup`, `mongodb-natural-language-querying`, `mongodb-query-optimizer`, `mongodb-schema-design`, `mongodb-search-and-ai`.

## team

ani potts, kapil.

## license

MIT
