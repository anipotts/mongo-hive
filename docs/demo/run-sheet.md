# 3-minute run sheet

**The agent terminals are the demo.** The console sits beside them as evidence and is never the hero, because dashboard-first projects are banned. There are no slides.

## screen

| left | right | side strip (narrow) |
|---|---|---|
| kap's Claude Code | ani's Codex | console on `http://localhost:3000/hive/team` |

- Terminal font at 18pt or larger. Turn notifications off on both laptops.
- Use the `team` hive: it's seeded and deterministic. `live` is only for "it works on real work" questions.

## before we go on (T-10 min)

- [ ] both laptops: `npm run ping` is OK and `npm run status` lists `team` with 4 tools
- [ ] both agents joined: `~/.mongo-hive/config.json` says kap / ani, and the plugin is installed
- [ ] console running on both laptops; the feed shows the other person's session within 2s
- [ ] `npm run demo:reset` run right before (restores `team` to the baseline snapshot and clears its traces)
- [ ] the fallback video is open in a background tab (see the end)

## beats

| time | who | do | say (one line) | the audience sees |
|---|---|---|---|---|
| 0:00–0:15 | kap | nothing typed yet | "My agent learned it, so yours already knows it. Two laptops, two different coding agents, one hive in Atlas." | two terminals and a quiet console |
| 0:15–0:50 | kap | prompt Claude: *"Which teams own repos affected by advisory ADV-001, and which can clear it with a patch bump?"* | "Claude doesn't re-derive this. It asks the hive." | `find_capability` → `run_capability advisory_owners v2`, answered in under a second. Console: **kap ran advisory_owners v2** |
| 0:50–1:40 | ani | run `npm run improve -- --hive team --id advisory_owners` in a third pane, or show it already running | "v2 was written by our worker, not a person. It only ever sees which *categories* it fails, never the eval inputs, and the evals decide if v+1 leads." | worker rows move queued → drafting → testing → done. The tool page timeline: **v2 replaced v1 (6/10) · fixed: team_rollup · still fails: archived_only_team** |
| 1:40–2:10 | kap → ani | kap publishes a better version (or the worker's v+1 takes the lead); ani prompts Codex with the same question | "Ani's Codex never saw my session. It gets the new promoted version over a change stream." | Codex shows a `better_available` notice, runs the new promoted version, and its standing goes to **up to date** |
| 2:10–2:40 | ani | `npm run poison` | "A teammate can't hurt you. Mallory is a real member pushing broken versions." | mallory's v8 **0/8 rejected**, v9 **7/8 rejected**. Promoted version unchanged; ani's agent never sees them |
| 2:40–3:00 | kap | nothing | "Atlas is the only memory: change streams, an atomic promotion, one database per hive. All of it built today." | console timeline for the tool |

**Swap in if #7 lands (in-session worker):** replace 0:50–1:40 with kap repeating a query shape twice. The worker drafts mid-session, and kap's next `find_capability` returns the draft. It's the stronger Statement One moment, so use it only if it has passed both rehearsals.

## if something breaks live

| symptom | do |
|---|---|
| the agent is slow or rambles | say "it's asking the hive" and point at the console line; don't wait more than 10s |
| the improve round doesn't beat the promoted version | that's the point: "rejected, the tests decided". Show the timeline instead |
| Atlas or Wi-Fi drops | switch to the fallback video from the same beat; keep talking |
| the console is stale | `npm run status` in either terminal gives the same facts as text |

**Fallback video:** the 60s submission video, scrubbed to the matching beat.

## rehearsals

| # | time | length | what broke | fix |
|---|---|---|---|---|
| 1 | | | | |
| 2 | | | | |
