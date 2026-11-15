/**
 * "*" discovery: enumerate the repositories the token's user can see and
 * apply the discovery filters. Filters apply to discovery only, never to
 * explicit targets.
 */

import type { components } from "@octokit/openapi-types";
import { err, ok, ResultAsync } from "neverthrow";
import type { GitHubClient } from "../github/api.js";
import { classifyApiError } from "../github/api-error.js";
import { classifyVisibility } from "../github/repo-visibility.js";
import { isPrivate, markPrivate, type Private } from "../private.js";
import { revealPrivate } from "../private-open.js";
import type { ProblemOf } from "../problem.js";
import { countNoun } from "../text.js";
import { type ExcludePattern, excludeMatches } from "./exclude-pattern.js";

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

/** Discovery never re-probes, so a repository the listing proves neither public nor private is hidden, never exposed. */
function normalizeVisibility(repo: DiscoveredRepo): DiscoveredRepoRef["visibility"] {
  const visibility = classifyVisibility(repo);
  return visibility === "unknown" ? "private" : visibility;
}

// Allowed values per discovery-filter input; the single source the input validation and types derive from.

export const VISIBILITY_FILTERS = ["all", "public", "private", "internal"] as const;
export const ARCHIVED_FILTERS = ["skip", "include", "only"] as const;
export const FORKS_FILTERS = ["include", "exclude", "only"] as const;
export const AFFILIATIONS = ["owner", "collaborator", "organization_member"] as const;

/** Filters applied to repos: "*" discovery only, never to explicit targets. */
export interface DiscoveryFilters {
  visibility: (typeof VISIBILITY_FILTERS)[number];
  archived: (typeof ARCHIVED_FILTERS)[number];
  forks: (typeof FORKS_FILTERS)[number];
  affiliation: string[];
  topics: string[];
  exclude: ExcludePattern[];
}

export const DEFAULT_DISCOVERY_FILTERS: DiscoveryFilters = {
  visibility: "all",
  archived: "skip",
  forks: "include",
  affiliation: ["owner"],
  topics: [],
  exclude: [],
};

/**
 * The repositories one filter dropped. `reason` quotes the operator's filter; `sealedReason` is its form for a run that
 * hides private repositories, set only where the quoted text could name one: an exclude pattern, told by its 1-based
 * position in the `exclude` list. A pattern names a repository it skipped, or one a negated pattern kept.
 */
export interface SkipGroup {
  reason: string;
  sealedReason?: string;
  repos: FilteredRepoRef[];
}

export interface DiscoveryResult {
  repos: DiscoveredRepoRef[];
  filtered: SkipGroup[];
}

/** One filter's verdict on one repository: null keeps it. */
type SkipReason = Pick<SkipGroup, "reason" | "sealedReason"> | null;

const skippedBy = (reason: string): SkipReason => ({ reason });

/** Shared by the rule that emits it and formatSkipNotice, which special-cases it for the unarchive-to-manage prose; a literal in one place and not the other would silently drop that guidance. */
const ARCHIVED_REASON = "archived";

export type DiscoveryProblem = ProblemOf<
  "discovery-request-failed" | "discovery-transport-failed" | "discovery-response-not-a-list"
>;

export function discoverRepos(
  api: GitHubClient,
  filters: DiscoveryFilters,
): ResultAsync<DiscoveryResult, DiscoveryProblem> {
  const params = [`affiliation=${filters.affiliation.join(",")}`];
  if (filters.visibility === "public" || filters.visibility === "private") {
    // The API's visibility param has no "internal" value; that case (and the
    // internal-vs-private distinction on GHEC) is settled client-side below.
    params.push(`visibility=${filters.visibility}`);
  }
  const path = `/user/repos?${params.join("&")}`;
  // A client that throws breaks the GitHubClient contract; its message is folded like the `failed` line it owed.
  return ResultAsync.fromPromise(
    // A page that is not a list ends the walk there, so that diagnosis stands ahead of a later page's answer.
    api.tryList(path, { until: (page) => !Array.isArray(page) }),
    (error): DiscoveryProblem => ({
      code: "discovery-transport-failed",
      reason: error instanceof Error ? error.message : String(error),
    }),
  ).andThen((answer) => {
    if ("failed" in answer) {
      return err<DiscoveryResult, DiscoveryProblem>({
        code: "discovery-transport-failed",
        reason: answer.failed,
      });
    }
    if ("error" in answer) {
      // A rate-limit 403 is NOT a permission problem (classifyApiError keeps the kinds apart), so it never reads as denied
      // and never tells the operator to swap tokens; 401 (an invalid or expired token) does.
      return err<DiscoveryResult, DiscoveryProblem>({
        code: "discovery-request-failed",
        path,
        status: answer.error.status,
        message: answer.error.message,
        denied: classifyApiError(answer.error) === "permission" || answer.error.status === 401,
      });
    }
    const repos: DiscoveredRepo[] = [];
    for (const page of answer.data) {
      if (!Array.isArray(page)) {
        return err<DiscoveryResult, DiscoveryProblem>({
          code: "discovery-response-not-a-list",
          path,
        });
      }
      repos.push(...(page as DiscoveredRepo[]));
    }
    return ok(applyFilters(repos, filters));
  });
}

function applyFilters(
  repos: readonly DiscoveredRepo[],
  filters: DiscoveryFilters,
): DiscoveryResult {
  const rules: Array<(repo: DiscoveredRepo) => SkipReason> = [
    (repo) => {
      const isInternal = repo.visibility === "internal";
      if (filters.visibility === "internal" && !isInternal) {
        return skippedBy("visibility=internal");
      }
      if (filters.visibility === "private" && isInternal) {
        return skippedBy("visibility=private");
      }
      return null;
    },
    (repo) => {
      if (filters.archived === "skip" && repo.archived) {
        return skippedBy(ARCHIVED_REASON);
      }
      if (filters.archived === "only" && !repo.archived) {
        return skippedBy("archived=only");
      }
      return null;
    },
    (repo) => {
      if (filters.forks === "exclude" && repo.fork) {
        return skippedBy("forks=exclude");
      }
      if (filters.forks === "only" && !repo.fork) {
        return skippedBy("forks=only");
      }
      return null;
    },
    (repo) => {
      if (
        filters.topics.length > 0 &&
        !(repo.topics ?? []).some((topic) => filters.topics.includes(topic.toLowerCase()))
      ) {
        return skippedBy(`topics (has none of: ${filters.topics.join(", ")})`);
      }
      return null;
    },
    (repo) => {
      const at = filters.exclude.findIndex((exclude) => excludeMatches(exclude, repo.full_name));
      const hit = filters.exclude[at];
      return hit === undefined
        ? null
        : {
            reason: `exclude pattern "${hit.pattern}"`,
            sealedReason: `exclude pattern #${at + 1} (its text is hidden under private-repos: redact)`,
          };
    },
  ];
  const kept: DiscoveredRepoRef[] = [];
  const filtered = new Map<string, SkipGroup>();
  for (const repo of repos) {
    let skipped: SkipReason = null;
    for (const rule of rules) {
      skipped = rule(repo);
      if (skipped) {
        break;
      }
    }
    const ref: DiscoveredRepoRef = {
      slug: repo.full_name,
      visibility: normalizeVisibility(repo),
    };
    if (!skipped) {
      kept.push(ref);
      continue;
    }
    const group = filtered.get(skipped.reason);
    if (group) {
      group.repos.push(sealFiltered(ref));
    } else {
      filtered.set(skipped.reason, { ...skipped, repos: [sealFiltered(ref)] });
    }
  }
  return { repos: kept, filtered: [...filtered.values()] };
}

/**
 * One aggregate notice per filter reason: per-repo notices for a "*" fleet would flood the annotations UI (GitHub caps
 * annotations per step). Under `redactPrivate` only public slugs are listed, hidden ones become a count, and every
 * notice states the sealed reason, so no pattern's text is printed; under `show` the operator opted into naming them,
 * so the seal opens here.
 */
export function formatSkipNotice(group: SkipGroup, redactPrivate: boolean): string {
  const named: string[] = redactPrivate
    ? group.repos.flatMap((repo) => (repo.visibility === "public" ? [repo.slug] : []))
    : group.repos.map((repo) => (isPrivate(repo.slug) ? revealPrivate(repo.slug) : repo.slug));
  const hidden = group.repos.length - named.length;
  const hiddenCount = countNoun(
    hidden,
    "private or internal repository",
    "private or internal repositories",
  );
  const shown = named.slice(0, 20).join(", ");
  const more = named.length > 20 ? `, and ${named.length - 20} more` : "";
  const hiddenTail = hidden > 0 ? `, and ${hiddenCount}` : "";
  const names = named.length > 0 ? `: ${shown}${more}${hiddenTail}` : "";
  const count =
    named.length === 0 && hidden > 0
      ? hiddenCount
      : countNoun(group.repos.length, "repository", "repositories");
  if (group.reason === ARCHIVED_REASON) {
    return `repos: "*" discovery skipped ${count} because settings writes fail on archived repositories; unarchive them to manage them${names}`;
  }
  const reason = redactPrivate ? (group.sealedReason ?? group.reason) : group.reason;
  return `repos: "*" discovery skipped ${count} by ${reason}${names}`;
}
