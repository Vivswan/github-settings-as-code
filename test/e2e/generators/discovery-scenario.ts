import type { MultiRepo, Scenario } from "../scenario.js";
import type { Rng } from "./prng.js";

export interface DiscoveryScenarioMeta {
  pool: Array<{
    slug: string;
    archived?: boolean;
    fork?: boolean;
    visibility?: string;
    topics?: string[];
  }>;
  filters: {
    visibility?: string;
    archived?: string;
    forks?: string;
    topics?: string;
    exclude?: string;
  };
  /**
   * Always redact: discovery targets are the one surface with TRUE non-disclosure (their names come only from the
   * private /user/repos listing, never the operator's config), so the fuzzer checks a kept private/internal repo is
   * keyed by a placeholder and its slug leaks nowhere.
   */
  privateRepos: "redact" | "show";
}

/**
 * Each pool repo carries one label, so a kept repo applies. The meta echoes the pool and filters, so predictDiscovery
 * computes the kept set INDEPENDENTLY and the fuzz asserts the action discovered exactly those.
 */
export function genDiscoveryScenario(
  rng: Rng,
  /**
   * Battery construction: "converges" pins pool repo 0 non-archived with no filters, so the convergence battery entry
   * exists for every master seed instead of being rejection-sampled. Deterministic per (seed, force); replays reapply it.
   */
  force?: "converges",
): {
  scenario: Scenario;
  meta: DiscoveryScenarioMeta;
} {
  const count = rng.int(5) + 4;
  const TOPIC_POOL = ["platform", "infra", "legacy", "misc"];
  // One pool repo forced non-public, or an all-public pool would hand the leak invariant an empty forbidden set.
  const forcedPrivateIndex = rng.int(count);
  const pool: DiscoveryScenarioMeta["pool"] = [];
  for (let i = 0; i < count; i++) {
    const repo: DiscoveryScenarioMeta["pool"][number] = { slug: `e2e-owner/disc-${i}` };
    if (rng.bool(0.3) && !(force === "converges" && i === 0)) {
      repo.archived = true;
    }
    if (rng.bool(0.3)) {
      repo.fork = true;
    }
    repo.visibility =
      i === forcedPrivateIndex
        ? rng.pick(["private", "internal"] as const)
        : rng.pick(["public", "private", "internal"]);
    if (rng.bool(0.6)) {
      repo.topics = [rng.pick(TOPIC_POOL)];
    }
    pool.push(repo);
  }

  const rolledFilters: DiscoveryScenarioMeta["filters"] = {};
  if (rng.bool(0.4)) {
    rolledFilters.visibility = rng.pick(["all", "public", "private", "internal"]);
  }
  if (rng.bool(0.4)) {
    rolledFilters.archived = rng.pick(["skip", "include", "only"]);
  }
  if (rng.bool(0.4)) {
    rolledFilters.forks = rng.pick(["include", "exclude", "only"]);
  }
  if (rng.bool(0.4)) {
    rolledFilters.topics = rng.pick(TOPIC_POOL);
  }
  if (rng.bool(0.3)) {
    rolledFilters.exclude = `disc-${rng.int(count)}`;
  }
  const filters: DiscoveryScenarioMeta["filters"] = force === "converges" ? {} : rolledFilters;

  const repos: Record<string, MultiRepo> = {};
  for (const repo of pool) {
    repos[repo.slug] = {
      settings: { labels: [{ name: "managed", color: "00ff00" }] },
    };
  }

  const inputs: Record<string, string> = {};
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined) {
      inputs[key] = value;
    }
  }

  const privateRepos = "redact" as const;
  const scenario: Scenario = {
    name: `fuzz-discovery-${rng.seed}`,
    tiers: ["mock"],
    settings: {},
    inputs: { mode: "apply", on_missing_permission: "warn", private_repos: privateRepos },
    denial_style: "fine_grained",
    owner_kind: "org",
    discovery: { pool, inputs },
    repos,
    token_permissions: { issues: "write", contents: "read" },
    expect: { exit_code: 0 },
  };
  return { scenario, meta: { pool, filters, privateRepos } };
}
