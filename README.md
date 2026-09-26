# MongoHive

**my agent learned it, so yours already knows it.**


built at the MongoDB Harness Engineering & Model Wrangling Hackathon, NYC, 2026-09-26. **statement one: recursive harnessing.**

a shared hive of tested, versioned agent tools in MongoDB Atlas. when one teammate's agent learns a tool and it passes hidden tests, every other teammate's agent (claude code, codex, any MCP client) is notified via change streams and uses the same version. bad versions are rejected before they reach anyone.

## how it works

- **honeycomb** = the Atlas cluster. **hive** = one database (`hive_<name>`) with its own tools, hidden test cases, agents and traces. `honeycomb.hives` records who owns and belongs to each hive.
- every user has a **private hive**. agents `explore` work data, then `propose_capability` saves a parameterized, read-only recipe there. with no hidden cases it stays `unverified`: usable by you, trusted by nobody else.
- `publish_capability` copies only the recipe (never your trace) into a **shared hive** you belong to. hard-coded data values are refused. the shared hive's own hidden cases decide: pass all and beat the head, and it becomes the head in one atomic write.
- teammates' agents get a change-stream notice, find it with `find_capability`, and use it with `run_capability`. `npm run status` shows who is behind or ahead.
- the server refuses any hive you are not a member of, and agent pipelines can never read hive internals like the hidden cases.

## layout

| path | what |
|---|---|
| `src/mcp` | the two stable tools |
| `src/learner` | trace to recipe |
| `src/validator` | hidden-case evaluation + activation |
| `src/registry` | atlas collections and capability types |
| `fixtures` | demo dataset and expected answers |
| `web` | activity view |

## run

```bash
cp .env.example .env   # fill in the atlas sandbox uri
npm install
npm run ping
```

## team

ani potts, kapil. all code written during the event.

## license

MIT
