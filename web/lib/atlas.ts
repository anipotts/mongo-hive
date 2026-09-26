// links from the console into the atlas data explorer, plus the one list of collections the console may peek at.
// answer_keys is never on the list: hidden evals stay out of every agent- and browser-facing surface.
export const PEEKABLE = ["capabilities", "outputs", "runs", "events", "sessions", "agents", "worker_jobs", "evaluations"] as const;
export type Peekable = (typeof PEEKABLE)[number];

// ATLAS_EXPLORER_URL is the data explorer url with {db} and {coll} placeholders, copied once from the atlas ui.
// unset: the console still shows hover previews, just without the "open in atlas" link
export function atlasUrl(hive: string, coll: Peekable): string | null {
  const t = process.env.ATLAS_EXPLORER_URL;
  return t ? t.replace("{db}", `hive_${hive}`).replace("{coll}", coll) : null;
}

// the filter to paste into the explorer's filter box
export const idFilter = (id: string) => (/^[0-9a-f]{24}$/.test(id) ? `{ _id: ObjectId("${id}") }` : `{ _id: ${JSON.stringify(id)} }`);
