---
description: Mark a hive tool's answer as correct, turning that run into an eval for the whole hive
argument-hint: "[outputId]"
---

The person is judging a MongoHive tool run as **correct**. This is a human judgment: only run it because the person typed this command, never on your own initiative.

1. Use `$ARGUMENTS` as the outputId. If it is empty, use the `outputId` from the most recent `run_capability` result in this conversation; if there is none, ask which run they mean and stop.
2. Read `repoPath` from `~/.mongo-hive/config.json`.
3. Run: `npx tsx <repoPath>/bin/mongo-hive.ts feedback <outputId> correct`
4. Reply with the command's one-line summary (eval count, promoted version and score, whether the worker was queued). Don't add commentary.
