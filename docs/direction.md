# MongoHive product and implementation direction

Set by ani on 2026-09-26 (13:45 ET). This is the reference for every agent working on this repo; it sits under the repo instructions, the frozen `docs/contract.md` and native permission controls. Vocabulary: `docs/glossary.md`.

## goal

"my agent learned it, so yours already knows it." Ani and Kap work normally in their coding agents. MongoHive turns useful project work into tested, versioned tools that teammates' agents discover and invoke with minimal setup. The agents doing useful work together are the product; the console makes transfer, evaluation and improvement visible. A dashboard is not the product.

## architecture

A shared hive service with a small project-scoped connector and an MCP interface.

- **Atlas** stores shared evidence, tool versions, eval results and promotion state; change streams notify connected MongoHive services.
- **The connector** handles project binding, agent integration and selective background capture.
- **MCP** exposes callable tools to Claude Code and Codex. Do not rebuild the backend to change the agent-facing interface.

## native tools

- Eligible promoted tools are individually named MCP tools (`advisory_owners({ advisory_id })`) with a useful description and validated input schema, as a thin adapter over the existing executor. Named tools and the generic dispatcher share authorization, input validation, version resolution, execution restrictions and provenance.
- `find_capability` / `run_capability` stay for discovery, compatibility and tools outside the active catalog.
- **Compatible update:** same name and input/output contract; resolve pinned or promoted version once per invocation; return the version used. No catalog change.
- **New tool or changed schema:** refresh the catalog and send `notifications/tools/list_changed`. Breaking schema changes are explicit (new name), never silent. Claude Code documents live refresh; Codex needs a fresh session (verified: it sees tools at start, not mid-session), and that fallback must be stated and tested.
- A change-stream notice updates the service. It does not install a skill, rewrite instructions, wake an idle agent or force a call. No new SKILL.md or config rewrite per version.
- Advertise only relevant, authorized project tools; keep search for the long tail; never one tool name per version.

## one connection flow

Intended UX (adapt to existing commands):

```
mongo-hive connect --create my-team
mongo-hive connect <invite-url>
mongo-hive disconnect
```

- Connect establishes identity and membership through supported auth, binds **this project** to its hive, configures the chosen agent integration (Claude `.mcp.json`, Codex trusted-project config), preserves unrelated entries, is idempotent, and verifies a real connection.
- No machine-wide default that could route another repository's activity into a hive.
- Final output names: project, hive, agent integration, tool availability, capture state, disconnect command. Report only verified states.
- Auth and native trust prompts stay intact. "One command" means one guided entry point, deterministic installer logic.
- Disconnect removes only this binding's integration entries and task-owned processes. Disconnecting a project, leaving a hive and deleting shared history are separate operations. Never delete a hive as an onboarding or demo prerequisite.

## background learning

- Capture selected, relevant project events through supported adapters; don't assume Claude hooks exist identically in Codex.
- Filter sensitive content before sending: no secrets, env values or unrelated activity.
- Capture failures never block coding. Authorization, membership and execution restrictions fail closed.
- The worker is managed through the connection lifecycle where practical; users shouldn't operate a separate pipeline by hand.
- Eval integrity: candidate authors never receive eval inputs or expected outputs; evals stay out of descriptions, discovery, capture and public traces; authors get only contract-approved aggregates; objective tests, self-authored tests and independent human review stay distinguished. Don't relax promotion or reviewer-eligibility policy to make a solo demo succeed; propose changes through coordination.
- Learning grants no authority. Guardrails never silently loosen. Broader memory/context/rules sharing is a future extension point.

## priority: one vertical slice

Connect a project → publish and evaluate one tool → expose it as a named MCP tool → invoke it from the teammate's agent → promote a compatible improvement → invoke the same name and get the new version. Named-tool adapter and cross-agent execution first, then onboarding. No parallel legacy implementations. Use the existing domains and data.

## demo

Agents are the main screen, the console is evidence. Ani's agent solves a real problem and contributes a tool; Kap's agent invokes it by name on a different input without repeating the investigation; an independently supported improvement is promoted; the same named tool then runs the improved version. Show version, provenance and eval status; explain Atlas's role (shared state, promotion, change delivery). Preconfigure legitimate auth and trust; state any reconnect needed for discovery; never fake live refresh, independent validation or automatic learning.

Example projects: this repo's seeded domains (CI triage, incidents, dependency advisories) in `team`; real work in `live`; a solo private hive (for example quantercise-next) shows single-person use. Don't over-focus on MongoHive itself as the example.

## done means verified

- repeated connect preserves unrelated configuration
- activity and tools stay scoped to the intended hive and membership
- a real named MCP invocation uses the restricted executor
- a compatible promotion changes subsequent unpinned calls and preserves pins
- new-tool discovery works per tested client, or the fallback is demonstrated
- evals and secrets never appear in agent-facing responses
- disconnect preserves shared history and unrelated integrations

A config file existing or a dashboard changing is not proof; the actual agent call and its execution are.
