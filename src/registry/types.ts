// the hive's shared records. origin = directive + hidden tests (team-owned, never forked).
export type VersionStatus = "active" | "unverified" | "superseded" | "rejected" | "stale";

export interface CapabilityVersion {
  v: number;
  status: VersionStatus;
  collection: string;
  params: Record<string, "string" | "number">;
  pipeline: object[]; // read-only aggregation; "{{param}}" placeholders
  whenToUse: string;
  author: string; // hive user
  harness: string; // claude-code | codex | ...
  sourceRunId?: string; // private hive only; never copied on publish
  publishedFrom?: { hive: string; v: number };
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
  resumeToken?: unknown; // change stream position, so an offline agent catches up on missed head moves
  lastSeen: Date;
}

export interface HiveInfo {
  _id: string; // hive name; its database is hive_<name>
  visibility: "private" | "shared";
  owner: string;
  members: string[];
  createdAt: Date;
}
