/**
 * The repository fuzz generator fragment, aggregated by test/e2e/generators.ts.
 */

import type { Json } from "../../../e2e/gen-support.js";
import type { Rng } from "../../../e2e/prng.js";

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
  // The GraphQL-routed keys are later draws on a forked stream, so recorded seeds keep reproducing.
  const toggleRng = rng.fork("repo-toggles");
  if (toggleRng.bool(0.3)) {
    repo.enable_sponsorships = toggleRng.bool();
  }
  if (toggleRng.bool(0.3)) {
    repo.issue_creation_policy = toggleRng.pick(["all", "collaborators_only"]);
  }
  if (Object.keys(repo).length === 0) {
    repo.has_issues = rng.bool();
  }
  // The clearable strings (null on GitHub is the empty field) are later draws on their own forked stream, after
  // the fallback, so every earlier draw keeps its value on every seed; a document may gain these two keys.
  const clearableRng = rng.fork("repo-clearable");
  if (clearableRng.bool(0.3)) {
    repo.description = clearableRng.pick([
      "Repository settings as code",
      "Managed by the settings action",
      "Fixture repository",
    ]);
  }
  if (clearableRng.bool(0.2)) {
    repo.homepage = clearableRng.pick([
      "https://example.test",
      "https://docs.example.test/settings",
    ]);
  }
  return repo;
}
