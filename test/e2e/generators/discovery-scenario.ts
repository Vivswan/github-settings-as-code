import type { MultiRepo, Scenario } from "../scenario.js";
import type { Rng } from "./prng.js";

/** The topics a pool repo carries and a topics filter names. */
const TOPIC_POOL = ["platform", "infra", "legacy", "misc"];

/** The owner every pool repo sits under. */
const POOL_OWNER = "e2e-owner";

/** Patterns the exclude grammar refuses, one flaw each: an unpaired bracket, a backwards range, an empty class, a stray character, a run of stars, a second "/", a dots-only name, a bare "!", a leading "./", and an operator inside a class. */
export const REFUSED_EXCLUDE_PATTERNS: readonly string[] = [
  "disc-[",
  "disc-[9-0]",
  "disc-[]",
  "(disc)+",
  "disc-**",
  `${POOL_OWNER}/disc/0`,
  "..",
  "!",
  "./disc-0",
  "disc-[*]",
];

/**
 * The accepted shapes that drop a repo or two, aimed at pool repo `n`: literals, either case, "*", "?", classes, slugs,
 * and ones that match nothing. The whole slug is spelled for a non-public repository too: a redacted run tells such a
 * pattern by its position, so the leak check judges that on every draw.
 */
export function narrowExcludePatterns(n: number): readonly string[] {
  const name = `disc-${n}`;
  return [
    `${POOL_OWNER}/${name}`,
    `E2E-Owner/Disc-${n}`,
    name,
    name.toUpperCase(),
    `*-${n}`,
    `d?sc-${n}`,
    `disc-[${n}]`,
    `disc-[${n}-${Math.min(n + 1, 9)}]`,
    `[a-d]isc-${n}`,
    `[D-Z]isc-${n}`,
    `*/${name}`,
    "other-owner/*",
    "tmp-*",
  ];
}

/** The accepted shapes that drop most of the pool, drawn rarely so the kept set is seldom empty: bare stars, a negated class, and negated patterns. */
export function wideExcludePatterns(n: number): readonly string[] {
  const name = `disc-${n}`;
  return [
    "*",
    "disc-*",
    "disc-?",
    `${POOL_OWNER}/*`,
    `disc-[!${n}]`,
    `disc-[^0-${n}]`,
    `!${name}`,
    `!${POOL_OWNER}/disc-[0-${n}]`,
  ];
}

/**
 * Battery construction, deterministic per (seed, force), so a replay reapplies it:
 *   "converges" -> pool repo 0 non-archived and no filters, so the kept set is never empty
 *   "lists"     -> no refused exclude pattern, so the run reaches the repository listing a fault targets
 */
export type DiscoveryForce = "converges" | "lists";

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

  /** Whether `filters.exclude` holds a pattern the grammar refuses, so the run stops at its inputs and discovers nothing. */
  excludeRefused: boolean;

  /** Always "redact": discovery targets' names come only from the private /user/repos listing, so the fuzzer checks a kept private repo is keyed by a placeholder and its slug leaks nowhere. */
  privateRepos: "redact" | "show";
}

/** One pool repo is forced non-public, or an all-public pool would hand the leak invariant an empty forbidden set. */
function genDiscoveryPool(
  rng: Rng,
  count: number,
  force?: DiscoveryForce,
): DiscoveryScenarioMeta["pool"] {
  const forcedPrivateIndex = rng.int(count);
  const pool: DiscoveryScenarioMeta["pool"] = [];
  for (let i = 0; i < count; i++) {
    const repo: DiscoveryScenarioMeta["pool"][number] = { slug: `${POOL_OWNER}/disc-${i}` };
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

/**
 * The `exclude` input aimed at pool repo `n`: one to three patterns, comma-joined with or without a space, one of
 * them refused about one draw in six, never under "lists". `rng` is the exclude fork, so its draws move no other field.
 */
function genExclude(
  rng: Rng,
  n: number,
  pool: DiscoveryScenarioMeta["pool"],
  force?: DiscoveryForce,
): { exclude: string; refused: boolean } {
  // Rolled under "lists" too and then discarded, as the main stream's rolls are.
  const refused = rng.bool(1 / 6) && force !== "lists";
  const patterns = Array.from({ length: rng.int(3) + 1 }, () => {
    const target = rng.bool(0.7) ? n : rng.int(pool.length);
    return rng.pick(rng.bool(0.06) ? wideExcludePatterns(target) : narrowExcludePatterns(target));
  });
  if (refused) {
    patterns[rng.int(patterns.length)] = rng.pick(REFUSED_EXCLUDE_PATTERNS);
  }
  return { exclude: patterns.join(rng.pick([",", ", "])), refused };
}

/** Rolled under a force too, so the main stream and every recorded seed stay stable; "converges" then discards the roll. */
function genDiscoveryFilters(
  rng: Rng,
  pool: DiscoveryScenarioMeta["pool"],
  force?: DiscoveryForce,
): { filters: DiscoveryScenarioMeta["filters"]; excludeRefused: boolean } {
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
  let excludeRefused = false;
  if (rng.bool(0.3)) {
    // The main stream still spends the one draw the literal `disc-N` took, so every other field of a recorded seed reproduces.
    const drawn = genExclude(rng.fork("discovery-exclude"), rng.int(pool.length), pool, force);
    rolled.exclude = drawn.exclude;
    excludeRefused = drawn.refused;
  }
  return force === "converges"
    ? { filters: {}, excludeRefused: false }
    : { filters: rolled, excludeRefused };
}

/**
 * Each pool repo carries one label, so a kept repo applies. The meta echoes the pool and filters, so predictDiscovery
 * computes the kept set INDEPENDENTLY and the fuzz asserts the action discovered exactly those.
 */
export function genDiscoveryScenario(
  rng: Rng,
  /** Constructs a battery entry for every master seed instead of rejection-sampling one. */
  force?: DiscoveryForce,
): {
  scenario: Scenario;
  meta: DiscoveryScenarioMeta;
} {
  const count = rng.int(5) + 4;
  const pool = genDiscoveryPool(rng, count, force);
  const { filters, excludeRefused } = genDiscoveryFilters(rng, pool, force);

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
    settings: {},
    inputs: { mode: "apply", on_missing_permission: "warn", private_repos: privateRepos },
    denial_style: "fine_grained",
    owner_kind: "org",
    discovery: { pool, inputs },
    repos,
    token_permissions: { issues: "write", contents: "read" },
    expect: { exit_code: 0 },
  };
  return { scenario, meta: { pool, filters, excludeRefused, privateRepos } };
}
