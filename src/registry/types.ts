// capability document shape. freeze this before splitting work.
export type CapabilityStatus = "candidate" | "active" | "stale" | "rejected";

export interface CapabilityVersion {
  v: number;
  status: CapabilityStatus;
  params: Record<string, "string" | "number">;
  collection: string;
  pipeline: object[]; // read-only aggregation, $param placeholders
  whenToUse: string;
  schemaFingerprint: string;
  sourceRunId: string;
  evalId?: string;
  hash: string;
  creationCost: { tokens: number; ms: number };
}

export interface Capability {
  _id: string;
  activeVersion: number | null;
  versions: CapabilityVersion[];
  scope: { workspace: string; permissions: "read-only" };
}
