/**
 * The repository section's fuzz generator fragment, aggregated by
 * test/e2e/generators.ts. Imports only the test-tree leaf seams
 * (gen-support.ts, prng.ts) - the src -> test inversion is deliberate; the
 * bundle entry is src/main.ts, so this file never reaches lib/index.js.
 */

import type { Json } from "../../../test/e2e/gen-support.js";
import type { Rng } from "../../../test/e2e/prng.js";

export function genRepository(rng: Rng): Json {
  const repo: Json = {};
  if (rng.bool()) {
    repo.has_issues = rng.bool();
  }
  if (rng.bool()) {
    repo.has_wiki = rng.bool();
  }
  if (rng.bool()) {
    repo.allow_merge_commit = rng.bool();
  }
  if (rng.bool(0.5)) {
    repo.topics = Array.from({ length: rng.int(3) + 1 }, () =>
      rng.pick(["automation", "governance", "settings", "infra"]),
    );
  }
  if (rng.bool(0.4)) {
    repo.enable_vulnerability_alerts = rng.bool();
  }
  if (rng.bool(0.3)) {
    repo.enable_git_lfs = rng.bool();
  }
  if (rng.bool(0.3)) {
    repo.enable_immutable_releases = rng.bool();
  }
  // The GraphQL-routed keys are NEW draws, so they live on a forked stream:
  // the main stream stays stable and recorded seeds keep reproducing (the
  // required-signatures precedent in genBranches).
  const toggleRng = rng.fork("repo-toggles");
  if (toggleRng.bool(0.3)) {
    repo.enable_sponsorships = toggleRng.bool();
  }
  if (toggleRng.bool(0.3)) {
    repo.issue_creation_policy = toggleRng.pick(["all", "collaborators_only"]);
  }
  // Always leave at least one key so the section does real work.
  if (Object.keys(repo).length === 0) {
    repo.has_issues = rng.bool();
  }
  return repo;
}
