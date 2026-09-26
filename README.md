# MongoHive

**my agent learned it, so yours already knows it.**


built at the MongoDB Harness Engineering & Model Wrangling Hackathon, NYC, 2026-09-26. **statement one: recursive harnessing.**

a shared hive of tested, versioned agent tools in MongoDB Atlas. when one teammate's agent learns a tool and it passes hidden tests, every other teammate's agent (claude code, codex, any MCP client) is notified via change streams and uses the same version. bad versions are rejected before they reach anyone.

## how it works

1. an agent solves a task; every tool call is recorded in `events`
2. the learner turns the trace into a parameterized, read-only recipe
3. the validator runs hidden cases; passing versions activate atomically
4. any agent calls `find_capability` / `run_capability` to reuse it
5. schema fingerprint mismatch marks a version stale and triggers repair

## layout

| path | what |
|---|---|
| `src/mcp` | the two stable tools |
| `src/adapters` | claude code + codex run wrappers |
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
