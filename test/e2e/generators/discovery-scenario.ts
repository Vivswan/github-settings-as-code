import type { MultiRepo, Scenario } from "../scenario.js";
import type { Rng } from "./prng.js";

const TOPIC_POOL = ["platform", "infra", "legacy", "misc"];

export interface DiscoveryScenarioMeta {
  /** What the mock's /user/repos listing enumerates, each repo carrying the attributes the filters read. */
  pool: Array<{
    slug: string;
    archived?: boolean;
    fork?: boolean;
    visibility?: string;
    topics?: string[];
  }>;

  /** The discovery-filter inputs the scenario passes, so predictDiscovery recomputes the kept set from the pool alone. */
  filters: {
    visibility?: string;
    archived?: string;
    forks?: string;
    topics?: string;
    exclude?: string;
  };

  /** Always "redact": discovery targets' names come only from the private /user/repos listing, so the fuzzer checks a kept private repo is keyed by a placeholder and its slug leaks nowhere. */
  privateRepos: "redact" | "show";
}

/** One pool repo is forced non-public, or an all-public pool would hand the leak invariant an empty forbidden set. */
function genDiscoveryPool(
  rng: Rng,
  count: number,
  force?: "converges",
): DiscoveryScenarioMeta["pool"] {
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
  return pool;
}

/** Rolled under a force too, so the main stream and every recorded seed stay stable; "converges" then discards the roll. */
function genDiscoveryFilters(
  rng: Rng,
  count: number,
  force?: "converges",
): DiscoveryScenarioMeta["filters"] {
  const rolled: DiscoveryScenarioMeta["filters"] = {};
  if (rng.bool(0.4)) {
    rolled.visibility = rng.pick(["all", "public", "private", "internal"]);
  }
  if (rng.bool(0.4)) {
    rolled.archived = rng.pick(["skip", "include", "only"]);
  }
  if (rng.bool(0.4)) {
    rolled.forks = rng.pick(["include", "exclude", "only"]);
  }
  if (rng.bool(0.4)) {
    rolled.topics = rng.pick(TOPIC_POOL);
  }
  if (rng.bool(0.3)) {
    rolled.exclude = `disc-${rng.int(count)}`;
  }
  return force === "converges" ? {} : rolled;
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
  const pool = genDiscoveryPool(rng, count, force);
  const filters = genDiscoveryFilters(rng, count, force);

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
