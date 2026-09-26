# advisory impact rules (deps domain)

collections

| collection | fields |
|---|---|
| `dep_repos` | `name`, `team`, `archived` (bool) |
| `dep_lockfiles` | `repo`, `package`, `version` (string), `major`, `minor`, `patch` (numbers), `direct` (bool). a repo can hold the same package at several versions. |
| `dep_advisories` | `id`, `package`, `affected.min` / `affected.max` (each `{major, minor, patch}`, both inclusive), `fixed_in` (`{version, major, minor, patch}` or `null` when no fix exists) |

question: for advisory A, which repos are affected, and which of those can be fixed by a patch bump?

1. a lockfile entry is **affected** when its `package` equals A's package exactly (no prefix or similar names) and `affected.min <= installed <= affected.max`, comparing major, then minor, then patch numerically.
2. direct and transitive entries count the same.
3. archived repos are never reported.
4. a repo is in `affected_repos` when it has at least one affected entry.
5. a repo is in `patch_fixable` when **every** affected entry for that package in the repo has the same major and minor as `fixed_in`. if `fixed_in` is null, nothing is patch fixable.
6. output: one document `{affected_repos: [...], patch_fixable: [...]}`, both arrays of repo names sorted ascending.
