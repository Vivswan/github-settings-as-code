/**
 * "*" discovery: enumerate the repositories the token's user can see and
 * apply the discovery filters. Filters apply to discovery only, never to
 * explicit targets.
 */

import type { components } from "@octokit/openapi-types";
import { err, ok, ResultAsync } from "neverthrow";
import { type GithubClient, isPermissionError } from "../github/api.js";
import { paginate } from "../github/paginate.js";
import { isPrivate, markPrivate, type Private } from "../private.js";
import { revealPrivate } from "../private-open.js";
import type { ProblemOf } from "../problem.js";

type DiscoveredRepo = Pick<
  components["schemas"]["repository"],
  "full_name" | "archived" | "fork" | "topics" | "visibility" | "private"
>;

export interface DiscoveredRepoRef {
  slug: string;
  visibility: "public" | "private" | "internal";
}

/**
 * A repository a filter dropped: only ever named in the skip notice, so a
 * non-public one carries its slug sealed (opened under `private-repos: show`).
 */
export type FilteredRepoRef =
  | { slug: string; visibility: "public" }
  | { slug: Private<string>; visibility: "private" | "internal" };

function sealFiltered(ref: DiscoveredRepoRef): FilteredRepoRef {
  return ref.visibility === "public"
    ? { slug: ref.slug, visibility: "public" }
    : { slug: markPrivate(ref.slug), visibility: ref.visibility };
}

/**
 * Fails closed for the REDACTION decision. `visibility` is a plain string in the API schema and optional on GHES, so
 * the always-present `private` flag is the authority: private === true wins over any `visibility` (even a stale
 * "public"), and with BOTH fields missing the repo is hidden, never exposed.
 */
function normalizeVisibility(repo: DiscoveredRepo): DiscoveredRepoRef["visibility"] {
  if (repo.private === true) {
    return "internal" === repo.visibility ? "internal" : "private";
  }
  const visibility = repo.visibility;
  if (visibility === "public" || visibility === "private" || visibility === "internal") {
    return visibility;
  }
  return repo.private === false ? "public" : "private";
}

/** Allowed values per discovery-filter input; the single source the input validation and types derive from. */
export const VISIBILITY_FILTERS = ["all", "public", "private", "internal"] as const;
export const ARCHIVED_FILTERS = ["skip", "include", "only"] as const;
export const FORKS_FILTERS = ["include", "exclude", "only"] as const;
export const AFFILIATIONS = ["owner", "collaborator", "organization_member"] as const;

/**
 * Shared by the rule that emits it and formatSkipNotice, which special-cases it for the unarchive-to-manage prose; a
 * literal in one place and not the other would silently drop that guidance.
 */
const ARCHIVED_REASON = "archived";

/** Filters applied to repos: "*" discovery only, never to explicit targets. */
export interface DiscoveryFilters {
  visibility: (typeof VISIBILITY_FILTERS)[number];
  archived: (typeof ARCHIVED_FILTERS)[number];
  forks: (typeof FORKS_FILTERS)[number];
  affiliation: string[];
  topics: string[];
  exclude: string[];
}

export const DEFAULT_DISCOVERY_FILTERS: DiscoveryFilters = {
  visibility: "all",
  archived: "skip",
  forks: "include",
  affiliation: ["owner"],
  topics: [],
  exclude: [],
};

function compileExcludePattern(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\?]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i");
}

export function excludeMatches(pattern: string, slug: string): boolean {
  const candidate = pattern.includes("/") ? slug : (slug.split("/")[1] ?? slug);
  return compileExcludePattern(pattern).test(candidate);
}

export interface DiscoveryResult {
  repos: DiscoveredRepoRef[];
  filtered: Array<{ reason: string; repos: FilteredRepoRef[] }>;
}

export type DiscoveryProblem = ProblemOf<
  "discovery-request-failed" | "discovery-transport-failed" | "discovery-response-not-a-list"
>;

export function discoverRepos(
  api: GithubClient,
  filters: DiscoveryFilters,
): ResultAsync<DiscoveryResult, DiscoveryProblem> {
  const params = [`affiliation=${filters.affiliation.join(",")}`];
  if (filters.visibility === "public" || filters.visibility === "private") {
    // The API's visibility param has no "internal" value; that case (and the
    // internal-vs-private distinction on GHEC) is settled client-side below.
    params.push(`visibility=${filters.visibility}`);
  }
  const path = `/user/repos?${params.join("&")}`;
  // Network-level failure: tryRequest throws once the retries are spent.
  return ResultAsync.fromPromise(
    paginate(api, path),
    (error): DiscoveryProblem => ({
      code: "discovery-transport-failed",
      reason: error instanceof Error ? error.message : String(error),
    }),
  ).andThen((page) => {
    if ("error" in page) {
      // A rate-limit 403 is NOT a permission problem (isPermissionError excludes it), so it never reads as denied and
      // never tells the operator to swap tokens; 401 (an invalid or expired token) does.
      return err<DiscoveryResult, DiscoveryProblem>({
        code: "discovery-request-failed",
        path,
        status: page.error.status,
        message: page.error.message,
        denied: isPermissionError(page.error) || page.error.status === 401,
      });
    }
    if ("malformed" in page) {
      return err<DiscoveryResult, DiscoveryProblem>({
        code: "discovery-response-not-a-list",
        path,
      });
    }
    return ok(applyFilters(page.items as DiscoveredRepo[], filters));
  });
}

/** Keep the repositories the filters admit; group the rest by the first reason that hit. */
function applyFilters(
  repos: readonly DiscoveredRepo[],
  filters: DiscoveryFilters,
): DiscoveryResult {

  const rules: Array<(repo: DiscoveredRepo) => string | null> = [
    (repo) => {
      const isInternal = repo.visibility === "internal";
      if (filters.visibility === "internal" && !isInternal) {
        return "visibility=internal";
      }
      if (filters.visibility === "private" && isInternal) {
        return "visibility=private";
      }
      return null;
    },
    (repo) => {
      if (filters.archived === "skip" && repo.archived) {
        return ARCHIVED_REASON;
      }
      if (filters.archived === "only" && !repo.archived) {
        return "archived=only";
      }
      return null;
    },
    (repo) => {
      if (filters.forks === "exclude" && repo.fork) {
        return "forks=exclude";
      }
      if (filters.forks === "only" && !repo.fork) {
        return "forks=only";
      }
      return null;
    },
    (repo) => {
      if (
        filters.topics.length > 0 &&
        !(repo.topics ?? []).some((topic) => filters.topics.includes(topic.toLowerCase()))
      ) {
        return `topics (has none of: ${filters.topics.join(", ")})`;
      }
      return null;
    },
    (repo) => {
      const hit = filters.exclude.find((pattern) => excludeMatches(pattern, repo.full_name));
      return hit ? `exclude pattern "${hit}"` : null;
    },
  ];
  const kept: DiscoveredRepoRef[] = [];
  const filtered = new Map<string, FilteredRepoRef[]>();
  for (const repo of repos) {
    let reason: string | null = null;
    for (const rule of rules) {
      reason = rule(repo);
      if (reason) {
        break;
      }
    }
    const ref: DiscoveredRepoRef = {
      slug: repo.full_name,
      visibility: normalizeVisibility(repo),
    };
    if (!reason) {
      kept.push(ref);
      continue;
    }
    const group = filtered.get(reason);
    if (group) {
      group.push(sealFiltered(ref));
    } else {
      filtered.set(reason, [sealFiltered(ref)]);
    }
  }
  return {
    repos: kept,
    filtered: [...filtered.entries()].map(([reason, group]) => ({ reason, repos: group })),
  };
}

/**
 * One aggregate notice per filter reason: per-repo notices for a "*" fleet would flood the annotations UI (GitHub caps
 * annotations per step). Under `redactPrivate` only public slugs are listed and hidden ones become a count; under
 * `show` the operator opted into naming them, so the seal opens here.
 */
export function formatSkipNotice(
  group: { reason: string; repos: FilteredRepoRef[] },
  redactPrivate: boolean,
): string {
  const named: string[] = redactPrivate
    ? group.repos.flatMap((repo) => (repo.visibility === "public" ? [repo.slug] : []))
    : group.repos.map((repo) => (isPrivate(repo.slug) ? revealPrivate(repo.slug) : repo.slug));
  const hidden = group.repos.length - named.length;
  const hiddenCount = `${hidden} private or internal ${hidden === 1 ? "repository" : "repositories"}`;
  const shown = named.slice(0, 20).join(", ");
  const more = named.length > 20 ? `, and ${named.length - 20} more` : "";
  const hiddenTail = hidden > 0 ? `, and ${hiddenCount}` : "";
  const names = named.length > 0 ? `: ${shown}${more}${hiddenTail}` : "";
  const count =
    named.length === 0 && hidden > 0
      ? hiddenCount
      : `${group.repos.length} ${group.repos.length === 1 ? "repository" : "repositories"}`;
  if (group.reason === ARCHIVED_REASON) {
    return `repos: "*" discovery skipped ${count} because settings writes fail on archived repositories; unarchive them to manage them${names}`;
  }
  return `repos: "*" discovery skipped ${count} by ${group.reason}${names}`;
}
