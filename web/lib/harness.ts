// harness string -> brand icon, in one place so the feed, roster and version rows agree (#6).
// slugs are Simple Icons (CC0; `simple-icons` npm or inlined paths, never fetched at runtime), drawn at 14px in
// currentColor. worker renders as the W chip, everything unknown as a terminal glyph.
export type HarnessIcon = { kind: "brand"; slug: string; label: string } | { kind: "worker" } | { kind: "terminal"; label: string };

const BRANDS: Record<string, { slug: string; label: string }> = {
  "claude-code": { slug: "claude", label: "Claude Code" },
  claude: { slug: "claude", label: "Claude Code" },
  codex: { slug: "openai", label: "Codex" },
  cursor: { slug: "cursor", label: "Cursor" },
  gemini: { slug: "googlegemini", label: "Gemini" },
  "gemini-cli": { slug: "googlegemini", label: "Gemini CLI" },
  copilot: { slug: "githubcopilot", label: "GitHub Copilot" },
  windsurf: { slug: "windsurf", label: "Windsurf" },
};

export function harnessIcon(harness: string | undefined): HarnessIcon {
  if (harness === "worker") return { kind: "worker" };
  const b = harness ? BRANDS[harness] : undefined;
  return b ? { kind: "brand", ...b } : { kind: "terminal", label: harness ?? "unknown" };
}
