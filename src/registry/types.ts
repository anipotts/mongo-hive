// the hive's shared records. origin = directive + hidden tests (team-owned, never forked).
export type VersionStatus = "active" | "unverified" | "superseded" | "rejected" | "stale" | "archived";

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
  kept?: boolean; // owner chose to keep this draft (still unverified until it has passing cases)
  // accountability, written by syncHead at every head change (docs/contract.md)
  supersedes?: number; // the head this version replaced
  supersededBy?: number; // set on the old head when it loses #1
  replacedReason?: string; // e.g. "8/8 in 690ms beat 7/8 in 702ms"
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
  // category names the rule a case exercises; agents only ever see failing category names, never args/expect
  cases: { args: Record<string, unknown>; expect: Record<string, unknown>; category?: string }[];
}

// the worker's work queue (docs/contract.md). one doc per job, updated at every step so the console can narrate it.
export interface WorkerJob {
  _id: string;
  hive: string;
  sessionId?: string;
  trigger: "repetition" | "session_end" | "improve" | "compose" | "split";
  step: "queued" | "drafting" | "validating" | "proposed" | "rejected" | "skipped";
  capId?: string;
  v?: number;
  verdict?: { passed: number; total: number; headPassed?: number };
  model?: string;
  note?: string;
  claimedBy?: string;
  createdAt: Date;
  updatedAt: Date;
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
