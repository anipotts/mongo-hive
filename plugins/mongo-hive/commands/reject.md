---
description: Mark a hive tool's answer as wrong and give the right one; it becomes an eval the tool must pass
argument-hint: "[outputId] <right answer as JSON or words>"
---

The person is judging a MongoHive tool run as **wrong**. This is a human judgment: only run it because the person typed this command, never on your own initiative, and never invent the right answer yourself.

1. From `$ARGUMENTS`, take the outputId (an `out_...` token) if present; otherwise use the `outputId` from the most recent `run_capability` result in this conversation.
2. The rest of `$ARGUMENTS` is the person's right answer. Turn it into a JSON object with the same field names as the tool's result doc (for example `{"culprit_deploy_id":"dep_1033","rollback":false}`), using only values the person stated. If they gave no right answer, ask for it and stop.
3. Read `repoPath` from `~/.mongo-hive/config.json`.
4. Run: `npx tsx <repoPath>/bin/mongo-hive.ts feedback <outputId> wrong --expect '<json>'`
5. Reply with the command's one-line summary. Don't add commentary.
