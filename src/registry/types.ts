// the hive's shared records. origin = directive + hidden tests (team-owned, never forked).
export type VersionStatus = "active" | "superseded" | "rejected" | "stale";

export interface CapabilityVersion {
  v: number;
  status: VersionStatus;
  collection: string;
  params: Record<string, "string" | "number">;
  pipeline: object[]; // read-only aggregation; "{{param}}" placeholders
  whenToUse: string;
  author: string; // hive user
  harness: string; // claude-code | codex | ...
  sourceRunId?: string;
  hash: string;
  score?: { passed: number; total: number; ms: number };
  reason?: string;
  createdAt: Date;
}

export interface Capability {
  _id: string;
  directive: string; // the origin: what this tool is for
  scope: string; // workspace / domain
  activeVersion: number | null;
  nextVersion?: number;
  versions: CapabilityVersion[];
  updatedAt: Date;
}

// hidden cases live apart from capabilities and are never returned by any tool
export interface AnswerKey {
  _id: string; // capability id
  cases: { args: Record<string, unknown>; expect: Record<string, unknown> }[];
}

export interface HiveAgent {
  _id: string; // `${user}:${harness}`
  user: string;
  harness: string;
  pulled: Record<string, number>;
  pinned: Record<string, number>;
  lastSeen: Date;
}
