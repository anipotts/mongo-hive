// events come from two writers: the mcp server (tool = explore, run_capability, ...) and the plugin hooks
// (kind = prompt | tool | stop, tool only on kind "tool"). every label must tolerate both shapes.
type AnyEvent = { tool?: unknown; kind?: unknown; [key: string]: unknown };

export function eventName(e: AnyEvent): string {
  const tool = typeof e.tool === "string" ? e.tool : "";
  switch (e.kind) {
    case "prompt": return "prompted";
    case "stop": return "ended session";
    case "tool": return tool ? `used ${tool}` : "used a tool";
  }
  return tool ? tool.replace(/_/g, " ") : typeof e.kind === "string" ? e.kind : "event";
}

export const eventTool = (e: AnyEvent): string => (typeof e.tool === "string" ? e.tool : "");
