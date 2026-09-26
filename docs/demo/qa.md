# Q&A prep (1–2 minutes)

Answer in one or two sentences, then point at something real: a terminal, the console or a file.

**Why MongoDB and not a queue plus Postgres?**
Atlas holds every role in the system:
- **Change streams with resume tokens** push a new head to every teammate's agent, and an agent that was offline catches up on what it missed.
- **A head change is one atomic document write** (`commitVersion`): a version number is reserved, then the version is pushed and the head moved together.
- **Each hive is its own database**, so membership and isolation map onto a real boundary.
- **The tools themselves are read-only aggregation pipelines** executed next to the data.
- **The worker's queue** is `worker_jobs`, claimed with `findOneAndUpdate`, so there's no extra infrastructure.

**Can a teammate's tool hurt me?**
Only by beating the current head on hidden tests it can't see. Beyond that:
- pipelines must be read-only and limited to allowed collections
- hard-coded data values are refused at publish
- anything under a 50% pass rate can't lead
- you can pin a version
- demo: `npm run poison`, where a real member's broken versions are rejected and never reach anyone

**Can an agent game the tests?**
- Agents never see test inputs or expected outputs. They see only the names of the categories they fail.
- No agent tool can read or edit the hidden tests.
- Grading a run as correct will be human-only, in the console (#7, in progress), so an agent can't certify itself.

**A 9/10 head is leading. Isn't that unsafe?**
A partial head can lead only until something beats it. Every surface shows its score and what it still fails, and the worker targets exactly those categories. That's the recursive loop.

**What's "recursive" here?**
The harness improves its own tools while agents use them. Traces become drafts, drafts are judged by hidden tests, the weakest tool gets v+1 from its failing categories, and the winner reaches every agent mid-session.

**What was built today?**
Everything except the vendored MongoDB agent skills, which are labelled third-party in the README. The first commit is 10:39 ET, and `git log --reverse` is the record.

**Why isn't this a dashboard?**
The product is the MCP server, the plugin hooks and the worker, all living in the agents' terminals. The console only shows evidence of what the hive did, and the demo runs in the terminals.

**Does it work with more than Claude and Codex?**
Any MCP client can use the tools. The session hooks are harness-specific, and we ship them for Claude Code and Codex.

**What do you record about my session?**
- **recorded:** your prompts and tool-call names, each with a 500-character redacted preview
- **never recorded:** `.env` values or file contents
- **fail-open:** if Atlas is down, your agent keeps working

**What's next?** (cut for today)
- savings benchmark
- schema fingerprints
- a hosted worker
- per-hive Atlas roles
- invite links without Atlas access
- worker budgets
- Voyage vector search in `find_capability` (#8)
