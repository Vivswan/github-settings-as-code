/**
 * "*" discovery: enumerate the repositories the token's user can see and
 * apply the discovery filters. Filters apply to discovery only, never to
 * explicit targets.
 */

import type { components } from "@octokit/openapi-types";
import { err, ok, type Result, ResultAsync } from "neverthrow";
import picomatch from "picomatch";
import type { GitHubClient } from "../github/api.js";
import { classifyApiError } from "../github/api-error.js";
import { classifyVisibility } from "../github/repo-visibility.js";
import { isPrivate, markPrivate, type Private } from "../private.js";
import { revealPrivate } from "../private-open.js";
import type { ProblemOf } from "../problem.js";
import { countNoun, quote } from "../text.js";

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
 * One `exclude` entry, compiled once at the input boundary. Plain data on purpose: a config built from argv must
 * equal one built from the environment, so the matcher is picomatch's RegExp, not a closure over it.
 */
export interface ExcludePattern {
  /** The operator's text, for the skip notice. */
  readonly pattern: string;
  /** "slug" when the pattern has a "/" and is compared against owner/name, "name" when against the name alone. */
  readonly scope: "slug" | "name";
  readonly regex: RegExp;
}

/**
 * `nocase`: repository names compare case-insensitively on GitHub. `dot`: a leading "." is an ordinary character
 * in a repository name (".github"), not the hidden-file marker picomatch skips by default. `posix`: "[!ab]" is a
 * negated class, as in a shell, instead of a class holding "!". `fastpaths: false`: the shortcut regexes picomatch
 * mints for star-led patterns demand a character after a literal dot, so "*.*" would miss "archive."; the full
 * parser keeps "*" any run of characters. `debug`: an invalid class like "[z-a]" throws instead of compiling to a
 * never-matching regex. `windows: false`: the main entry otherwise follows the host OS, and a slug is a GitHub
 * identifier, not a path, so the matcher is the same on every runner. `literalBrackets: false`: a class compiles
 * to the class alone, not an alternation with its literal text, which no name holds; thousands of classes then
 * compile in milliseconds instead of reaching the engine's size limit.
 */
const EXCLUDE_GLOB_OPTIONS = {
  nocase: true,
  dot: true,
  posix: true,
  fastpaths: false,
  debug: true,
  windows: false,
  literalBrackets: false,
} as const;

/** Every character no owner or repository name holds and no glob operator here uses. */
const EXCLUDE_STRAYS = /[^\w.\-/*?[\]!^]/g;

/**
 * A class: "!" or "^" may open it, its members are name characters, and a "-" is a range between two of them or
 * a literal first or last. Nothing else, so turning a backwards range around can never pair a new one.
 */
const EXCLUDE_CLASS = /^\[[!^]?(?:-?(?:[\w.](?:-[\w.])?)+-?|-)\]$/;

/** One side of the "/": name characters, "*", "?", and classes. */
const EXCLUDE_SEGMENT = new RegExp(`^(?:[\\w.\\-*?]|${EXCLUDE_CLASS.source.slice(1, -1)})+$`);

/** picomatch refuses a longer pattern; judged here so the refusal names the fix beside the pattern's other flaws. */
const EXCLUDE_MAX_LENGTH = picomatch.constants.MAX_LENGTH;

/** `where` of every unpaired bracket: a "[" pairs with the next "]" on its side of the "/", nothing else does. */
function unpairedBrackets(view: string): number[] {
  const unpaired: boolean[] = [];
  let open = -1;
  for (let i = 0; i < view.length; i++) {
    const char = view[i];
    if (char === "[") {
      if (open >= 0) {
        unpaired[i] = true;
      } else {
        open = i;
      }
    } else if (char === "]") {
      if (open >= 0) {
        open = -1;
      } else {
        unpaired[i] = true;
      }
    } else if (char === "/" && open >= 0) {
      unpaired[open] = true;
      open = -1;
    }
  }
  if (open >= 0) {
    unpaired[open] = true;
  }
  const where: number[] = [];
  for (let i = 0; i < view.length; i++) {
    if (unpaired[i]) {
      where.push(i);
    }
  }
  return where;
}

/** `where` of every "!" or "^" that neither negates (a "!" first) nor opens a class (right after "["). */
function misplacedMarks(view: string): number[] {
  const where: number[] = [];
  for (let i = 0; i < view.length; i++) {
    const char = view[i];
    if ((char === "!" || char === "^") && !(i === 0 && char === "!") && view[i - 1] !== "[") {
      where.push(i);
    }
  }
  return where;
}

function without(view: string, where: readonly number[]): string {
  const skip = new Set(where);
  return view
    .split("")
    .filter((_, i) => !skip.has(i))
    .join("");
}

/** The classes of a view whose brackets pair, in order: each "[" up to the next "]", with where it starts. */
function classesOf(view: string): Array<{ at: number; text: string }> {
  const classes: Array<{ at: number; text: string }> = [];
  let open = view.indexOf("[");
  while (open >= 0) {
    const close = view.indexOf("]", open);
    if (close < 0) {
      break;
    }
    classes.push({ at: open, text: view.slice(open, close + 1) });
    open = view.indexOf("[", close);
  }
  return classes;
}

/** The members of one class with every literal "-" moved last, the one interior place the grammar refuses it. */
function withHyphensLast(members: string): string {
  const kept: string[] = [];
  let literal = false;
  for (let i = 0; i < members.length; i++) {
    const char = members[i] ?? "";
    const high = members[i + 2] ?? "";
    if (char === "-") {
      literal = true;
    } else if (members[i + 1] === "-" && /[\w.]/.test(high)) {
      kept.push(`${char}-${high}`);
      i += 2;
    } else {
      kept.push(char);
    }
  }
  return `${kept.join("")}${literal ? "-" : ""}`;
}

const listed = <T>(items: readonly T[], render: (item: T) => string): string =>
  items.map(render).join(" and ");

/** A step's result: the view with its fix applied and the sentence naming it; `done` ends the pass. */
interface Pass {
  readonly view: string;
  readonly flaws: readonly string[];
  readonly done?: boolean;
  /** The view compiled, from the step that probes the engine, so the clean path compiles once. */
  readonly regex?: RegExp;
}

/** Every step reads only the view the steps before it left, so none can judge the raw pattern. */
type Step = (view: string) => Pass;

const unchanged = (view: string): Pass => ({ view, flaws: [] });

const applied = (view: string, fixed: string, flaw: string): Pass =>
  fixed === view ? unchanged(view) : { view: fixed, flaws: [flaw] };

const named = (view: string, flaw: string): Pass => ({ view, flaws: [flaw] });

/** The classes are rewritten in one walk, so a pattern of many flawed classes costs one pass, not one per class. */
const rewriteClasses: Step = (view) => {
  const flaws: string[] = [];
  let rebuilt = "";
  let cursor = 0;
  for (const { at, text } of classesOf(view)) {
    rebuilt += view.slice(cursor, at);
    cursor = at + text.length;
    let cls = text;
    const rewrite = (to: string, flaw: string): void => {
      if (to !== cls) {
        flaws.push(flaw);
        cls = to;
      }
    };
    const kept = cls.replace(/[*?]/g, "");
    rewrite(kept, `the class "${cls}" takes name characters only, so write it as "${kept}"`);
    if (/^\[[!^]?\]$/.test(cls)) {
      rewrite("", `the class "${cls}" matches nothing, so delete it`);
      continue;
    }
    if (!EXCLUDE_CLASS.test(cls)) {
      const [, opener = "", members = ""] = /^\[([!^]?)(.*)\]$/.exec(cls) ?? [];
      const settled = `[${opener}${withHyphensLast(members)}]`;
      rewrite(
        settled,
        `the class "${cls}" has a "-" where it reads as a range operator, so write it as "${settled}"`,
      );
    }
    const backwards: string[] = [];
    const turned = cls.replace(/([\w.])-([\w.])/g, (range, low: string, high: string) => {
      if (low <= high) {
        return range;
      }
      backwards.push(range);
      return `${high}-${low}`;
    });
    rewrite(
      turned,
      `the class "${cls}" has the backwards range ${listed(backwards, quote)}, so write it as "${turned}"`,
    );
    rebuilt += cls;
  }
  return { view: rebuilt + view.slice(cursor), flaws };
};

const ENGINE_REFUSAL =
  "it compiles to a regular expression the runtime refuses, so shorten it or split it across several patterns";

/**
 * The grammar is owned here, not left to picomatch, because picomatch accepts far more than a repository name can
 * hold ("(a)+" a quantifier, "\d" a digit class, "{az..bz}" a range, "./" silently dropped, "***" losing the
 * escape of a later dot) and compiles several such inputs to a wrong or never-matching regex with no option to
 * refuse them. The pattern is the user's input, so a flaw is refused naming its fix, never repaired, and every
 * flaw of one pattern is named at once, so N flaws cost one run to discover, not N: each step names one fix and
 * hands the next step the view with it applied, in the order the sentences take. What is left for the user to
 * write is named last with no fix applied: the length cap, an empty body, the sides around a "/", a side that is
 * only dots, and a regex the engine itself refuses.
 */
const EXCLUDE_STEPS: readonly Step[] = [
  (view) => applied(view, view.trim(), "it is wrapped in whitespace, so trim it"),
  (view) => {
    const strays = [...new Set(view.match(EXCLUDE_STRAYS) ?? [])];
    return applied(
      view,
      view.replace(EXCLUDE_STRAYS, ""),
      `it holds ${strays.map(quote).join(", ")}, which no owner or repository name contains, so remove ` +
        `${strays.length === 1 ? "it" : "them"}`,
    );
  },
  (view) => {
    const where = unpairedBrackets(view);
    return applied(
      view,
      without(view, where),
      `its ${listed(where, (i) => `${quote(view[i])} at ${i}`)} ${where.length === 1 ? "has" : "have"} no ` +
        `partner, so remove ${where.length === 1 ? "it" : "them"}`,
    );
  },
  (view) => {
    const where = misplacedMarks(view);
    const one = where.length === 1;
    return applied(
      view,
      without(view, where),
      `its ${listed(where, (i) => `${quote(view[i])} at ${i}`)} neither negate${one ? "s" : ""} ` +
        `nor open${one ? "s" : ""} a class, so remove ${one ? "it" : "them"}`,
    );
  },
  rewriteClasses,
  (view) =>
    applied(
      view,
      view.replace(/^(!?)(?:\.\/)+/, "$1"),
      `it starts with "./", which names no owner, so drop every leading "./"`,
    ),
  (view) =>
    applied(
      view,
      view.replace(/\*{2,}/g, "*"),
      `it holds a run of stars, which matches no more than one "*" does, so write one "*"`,
    ),
  (view) =>
    view.length > EXCLUDE_MAX_LENGTH
      ? named(
          view,
          `it is ${view.length} characters long, past the cap of ${EXCLUDE_MAX_LENGTH}, so shorten it`,
        )
      : unchanged(view),
  (view) => {
    const negated = view.startsWith("!");
    const body = negated ? view.slice(1) : view;
    return body === ""
      ? { view, flaws: [negated ? `"!" has nothing to negate` : "it is empty"], done: true }
      : unchanged(view);
  },
  (view) => {
    const segments = view.replace(/^!/, "").split("/");
    return segments.length > 2 || segments.includes("")
      ? named(view, `it takes at most one "/", with a non-empty glob on each side of it`)
      : unchanged(view);
  },
  (view) =>
    view
      .replace(/^!/, "")
      .split("/")
      .some((side) => side === "." || side === "..")
      ? named(view, `"." and ".." are never names`)
      : unchanged(view),
  (view) =>
    view
      .replace(/^!/, "")
      .split("/")
      .every((side) => side === "" || EXCLUDE_SEGMENT.test(side))
      ? unchanged(view)
      : named(
          view,
          `it is not name characters, "*", "?", and classes "[abc]" or "[!abc]" on each side of the "/"`,
        ),
  (view) => {
    if (view.length > EXCLUDE_MAX_LENGTH) {
      return unchanged(view);
    }
    try {
      // V8 compiles a RegExp on its first use, so the engine's own refusal (a class too wide for its tables, a
      // nesting too deep) surfaces here, in the same refusal as the other flaws.
      const regex = picomatch.makeRe(view, EXCLUDE_GLOB_OPTIONS);
      regex.test("");
      return { view, flaws: [], regex };
    } catch {
      return named(view, ENGINE_REFUSAL);
    }
  },
];

/** Every flaw of the pattern, and the compiled view when the engine step reached and accepted it. */
function judgeExcludePattern(pattern: string): { flaws: string[]; regex: RegExp | undefined } {
  const flaws: string[] = [];
  let view = pattern;
  let regex: RegExp | undefined;
  for (const step of EXCLUDE_STEPS) {
    const next = step(view);
    for (const flaw of next.flaws) {
      flaws.push(flaw);
    }
    view = next.view;
    regex = next.regex;
    if (next.done) {
      break;
    }
  }
  return { flaws, regex };
}

/**
 * The scope split mirrors the repos-dir `<name>.yml` vs `<owner>/<name>.yml` pairing; picomatch's own basename
 * mode cannot express it (a slashed pattern stops matching the whole slug under it).
 */
export function compileExcludePattern(
  pattern: string,
): Result<ExcludePattern, ProblemOf<"input-exclude-pattern-invalid">> {
  const { flaws, regex } = judgeExcludePattern(pattern);
  if (flaws.length > 0) {
    return err({ code: "input-exclude-pattern-invalid", pattern, reason: flaws.join(", and ") });
  }
  if (regex === undefined) {
    throw new Error(
      `BUG: the exclude pattern ${quote(pattern)} passed every step but the engine step never ran`,
    );
  }
  const scope = pattern.includes("/") ? "slug" : "name";
  return ok({ pattern, scope, regex });
}

export function excludeMatches(exclude: ExcludePattern, slug: string): boolean {
  const candidate = exclude.scope === "slug" ? slug : slug.slice(slug.indexOf("/") + 1);
  return exclude.regex.test(candidate);
}

export interface DiscoveryResult {
  repos: DiscoveredRepoRef[];
  filtered: Array<{ reason: string; repos: FilteredRepoRef[] }>;
}

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
      const hit = filters.exclude.find((exclude) => excludeMatches(exclude, repo.full_name));
      return hit ? `exclude pattern "${hit.pattern}"` : null;
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
  return `repos: "*" discovery skipped ${count} by ${group.reason}${names}`;
}
