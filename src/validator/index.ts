// runs a candidate recipe against the hidden answer key. nothing here is exposed to agents.
import { answerKeys, db, evaluations } from "../registry/db.js";
import type { CapabilityVersion } from "../registry/types.js";
import { execute } from "../learner/index.js";

export interface Verdict { passed: number; total: number; ms: number; failures: string[] }

const matches = (got: any, expect: Record<string, unknown>) =>
  Object.entries(expect).every(([k, v]) => JSON.stringify(got?.[k]) === JSON.stringify(v));

export async function validate(capId: string, version: CapabilityVersion): Promise<Verdict> {
  const key = await answerKeys.findOne({ _id: capId });
  const t0 = Date.now();
  if (!key || key.cases.length === 0) return { passed: 0, total: 0, ms: 0, failures: ["no answer key for this capability"] };
  const failures: string[] = [];
  let passed = 0;
  for (const c of key.cases) {
    try {
      const out = await execute(db, version, c.args);
      if (matches(out[0], c.expect)) passed++;
      else failures.push(`case ${JSON.stringify(c.args)}: wrong result`);
    } catch (e) {
      failures.push(`case ${JSON.stringify(c.args)}: ${(e as Error).message}`);
    }
  }
  const verdict = { passed, total: key.cases.length, ms: Date.now() - t0, failures };
  await evaluations.insertOne({ capId, v: version.v, hash: version.hash, ...verdict, at: new Date() });
  return verdict;
}
