// the worker's model access: the OpenAI SDK pointed at OpenRouter (hackathon sponsor), else OpenAI,
// traced with LangSmith when a key is present. with no key at all it falls back to `claude -p` so the loop still runs.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import OpenAI from "openai";

const run = promisify(execFile);

export interface Llm { model: string; complete(system: string, user: string): Promise<string> }

async function openaiClient(): Promise<Llm | null> {
  const router = process.env.OPENROUTER_API_KEY;
  const key = router ?? process.env.OPENAI_API_KEY;
  if (!key) return null;
  let client = new OpenAI({ apiKey: key, ...(router ? { baseURL: "https://openrouter.ai/api/v1" } : {}) });
  if (process.env.LANGSMITH_API_KEY) {
    const { wrapOpenAI } = await import("langsmith/wrappers");
    client = wrapOpenAI(client, { name: "mongo-hive-worker" } as any) as OpenAI;
  }
  const model = process.env.WORKER_MODEL ?? (router ? "openai/gpt-5.5" : "gpt-5.5");
  return {
    model: `${router ? "openrouter" : "openai"}:${model}`,
    async complete(system, user) {
      const r = await client.chat.completions.create({
        model,
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
        response_format: { type: "json_object" },
      });
      return r.choices[0]?.message?.content ?? "";
    },
  };
}

// no-key fallback: a headless claude with no tools, text in and json out
function claudeCli(): Llm {
  const model = process.env.WORKER_CLAUDE_MODEL ?? "sonnet";
  return {
    model: `claude-cli:${model}`,
    async complete(system, user) {
      const { stdout } = await run(
        "claude",
        ["-p", `${system}\n\n${user}`, "--output-format", "json", "--model", model, "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--disallowedTools", "Bash,Edit,Write,Read,Glob,Grep,WebFetch,WebSearch,Task"],
        { maxBuffer: 16 * 1024 * 1024, timeout: 240_000 },
      );
      return JSON.parse(stdout).result ?? "";
    },
  };
}

export async function workerLlm(): Promise<Llm> {
  return (await openaiClient()) ?? claudeCli();
}

// models wrap json in prose or fences sometimes; take the outermost object
export function parseJson<T>(text: string): T {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("model returned no json object");
  return JSON.parse(text.slice(start, end + 1)) as T;
}
