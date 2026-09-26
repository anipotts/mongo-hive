import { BRAND_PATHS } from "./brand-paths";

// one place maps a harness string to its official brand mark; unknown harnesses get a terminal glyph
const BRAND: Record<string, { icon: string; label: string }> = {
  "claude-code": { icon: "claude", label: "Claude Code" },
  claude: { icon: "claude", label: "Claude" },
  codex: { icon: "openai", label: "Codex" },
  cursor: { icon: "cursor", label: "Cursor" },
  gemini: { icon: "googlegemini", label: "Gemini" },
  "gemini-cli": { icon: "googlegemini", label: "Gemini CLI" },
  copilot: { icon: "githubcopilot", label: "GitHub Copilot" },
  windsurf: { icon: "windsurf", label: "Windsurf" },
};

export const harnessLabel = (h: string) => BRAND[h]?.label ?? (h === "worker" ? "worker" : h);

export function HarnessIcon({ harness, size = 14 }: { harness: string; size?: number }) {
  const d = BRAND_PATHS[BRAND[harness]?.icon ?? ""];
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" style={{ flex: "none", verticalAlign: "-2px" }}>
      {d ? <path d={d} fill="currentColor" /> : <path d="M3 5h18v14H3zM6 9l3 3-3 3m5 0h6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />}
    </svg>
  );
}
