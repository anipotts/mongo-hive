// promoted hive tools as native MCP tools: advisory_owners shows up to the agent as its own function
// (mcp__mongo-hive__advisory_owners), with its own description and input schema. the handler still resolves
// pin ?? promoted version from Atlas at call time, so an improvement never needs a client restart.
// the definition is a frozen contract (tool id + params, timeless description), so a promotion never changes
// it: tools/list_changed goes out only when a tool is added or retired. version, score and author ride in each
// result. find_capability / run_capability stay as the fallback.
import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { hive, myHives, type Hive } from "../registry/db.js";
import type { Capability, CapabilityVersion } from "../registry/types.js";
import { sameParams, toolContract } from "../validator/index.js";

type Reply = { content: { type: "text"; text: string }[] };
type Run = (h: Hive, cap: Capability, args: Record<string, unknown>) => Promise<unknown>;

interface Wanted { name: string; hive: string; id: string; v: number; params: CapabilityVersion["params"]; description: string }

const NAME_OK = /^[a-zA-Z0-9_-]{1,64}$/;

// timeless on purpose: clients cache tool definitions, so version, score and author live in each result instead
function describe(cap: Capability, contractVersion: CapabilityVersion): string {
  const when = contractVersion.whenToUse;
  return [cap.directive, when && when !== cap.directive ? `Use when: ${when}` : "",
    "MongoHive tool: its promoted version passed this hive's evals, so trust the result and answer from it."].filter(Boolean).join("\n");
}

function shape(params: CapabilityVersion["params"]) {
  return Object.fromEntries(Object.entries(params).map(([k, t]) => [k, t === "number" ? z.number() : z.string()]));
}

export function nativeTools(opts: { server: McpServer; reserved: string[]; run: Run; reply: (p: unknown) => Reply; notify: (line: string) => void }) {
  const live = new Map<string, { tool: RegisteredTool; sig: string }>();
  let first = true;
  let pending: Promise<void> | null = null;
  let again = false;

  async function wanted(): Promise<Wanted[]> {
    const found: Omit<Wanted, "name">[] = [];
    for (const info of await myHives()) {
      const h = hive(info._id);
      for (const cap of await h.capabilities.find({ activeVersion: { $ne: null } }).toArray()) {
        const head = cap.versions.find((x) => x.v === cap.activeVersion && x.status === "active");
        // the definition comes from the version that set the tool's contract, so promotions never change it
        const first = cap.versions.find((x) => sameParams(x.params, head?.params ?? {}) && x.status !== "rejected") ?? head;
        if (head && first) found.push({ hive: info._id, id: cap._id, v: head.v, params: head.params, description: describe(cap, first) });
      }
    }
    const count = new Map<string, number>();
    for (const f of found) count.set(f.id, (count.get(f.id) ?? 0) + 1);
    return found
      .map((f) => ({ ...f, name: count.get(f.id)! > 1 || opts.reserved.includes(f.id) ? `${f.hive}__${f.id}`.slice(0, 64) : f.id }))
      .filter((f) => NAME_OK.test(f.name));
  }

  async function sync() {
    const want = await wanted();
    const names = new Set(want.map((w) => w.name));
    for (const [name, entry] of live) if (!names.has(name)) { entry.tool.remove(); live.delete(name); }
    for (const w of want) {
      // the definition is the frozen contract (hive, tool id, params); promotions don't touch it, so
      // tools/list_changed only goes out when a tool is added or retired
      const sig = JSON.stringify([w.hive, w.id, w.params]);
      const callback = async (args: Record<string, unknown>) => {
        const h = hive(w.hive);
        const cap = await h.capabilities.findOne({ _id: w.id });
        if (!cap) return opts.reply({ error: `${w.name} was retired from hive ${w.hive}; refresh your tools or call find_capability` });
        const contract = toolContract(cap);
        if (!contract || !sameParams(contract, w.params))
          return opts.reply({ error: `${w.name} changed inputs; refresh your tools or call run_capability` });
        return opts.reply(await opts.run(h, cap, args));
      };
      const have = live.get(w.name);
      if (have?.sig === sig) continue;
      have?.tool.remove();
      const tool = opts.server.registerTool(w.name, { description: w.description, inputSchema: shape(w.params) }, callback as any);
      live.set(w.name, { tool, sig });
      if (!first) opts.notify(`new tool available: ${w.name} (hive ${w.hive}, promoted v${w.v}); call it directly`);
    }
    first = false;
  }

  // coalesce bursts of change-stream events into one sync at a time
  function schedule() {
    if (pending) { again = true; return; }
    pending = (async () => {
      do { again = false; await sync().catch(() => {}); } while (again);
    })().finally(() => { pending = null; });
  }

  return { sync, schedule, names: () => [...live.keys()] };
}
