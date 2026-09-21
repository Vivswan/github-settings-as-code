import { describe, expect, test } from "bun:test";
import { err } from "neverthrow";
import {
  DEFAULT_DISCOVERY_FILTERS,
  type DiscoveredRepoRef,
  type DiscoveryFilters,
  discoverRepos,
  excludeMatches,
  type FilteredRepoRef,
  formatSkipNotice,
} from "../../src/discovery/discover.js";
import { markPrivate } from "../../src/private.js";
import { describeProblem } from "../../src/problem.js";
import { MockApi } from "../mock-api.js";

describe("excludeMatches", () => {
  test.each<[string, string, string, boolean]>([
    ["* spans any characters, anchored at both ends", "tmp-*", "o/tmp-x", true],
    ["* spans any characters, anchored at both ends", "tmp", "o/tmp-x", false],
    ["* spans any characters, anchored at both ends", "*-archive", "o/old-archive", true],
    ["regex metacharacters are literal", "a.b", "o/a.b", true],
    ["regex metacharacters are literal", "a.b", "o/axb", false],
    ["matching is case-insensitive", "TMP-*", "o/tmp-x", true],
    ["a pattern with a slash matches the full slug", "octo/*", "octo/anything", true],
    ["a pattern with a slash matches the full slug", "octo/*", "viv/anything", false],
    ["a pattern without a slash matches the name only", "web*", "weborg/api", false],
    ["a pattern without a slash matches the name only", "web*", "anyowner/web-x", true],
  ])("%s: %p against %p is %p", (_rule, pattern, slug, matches) => {
    expect(excludeMatches(pattern, slug)).toBe(matches);
  });
});

describe("discoverRepos", () => {
  const filters = (overrides: Partial<DiscoveryFilters>): DiscoveryFilters => ({
    ...DEFAULT_DISCOVERY_FILTERS,
    ...overrides,
  });
  const discover = async (
    routes: ConstructorParameters<typeof MockApi>[0],
    overrides: Partial<DiscoveryFilters> = {},
  ) => {
    return (await discoverRepos(new MockApi(routes), filters(overrides))).match(
      (discovered) => discovered,
      (problem) => {
        throw new Error(describeProblem(problem));
      },
    );
  };
  const slugs = (repos: DiscoveredRepoRef[]) => repos.map((repo) => repo.slug);
  /** Filtered refs by reason; a non-public one compares against its sealed slug (`hidden`). */
  const filteredSlugs = (filtered: Array<{ reason: string; repos: FilteredRepoRef[] }>) =>
    filtered.map((group) => ({ reason: group.reason, slugs: group.repos.map((r) => r.slug) }));
  type FilteredSlugs = ReturnType<typeof filteredSlugs>;
  const hidden = markPrivate;
  const OWNED = "GET /user/repos?affiliation=owner&per_page=100&page=1";

  test("a listing with no HTTP answer is the transport problem carrying the client's line", async () => {
    const failed =
      "GET /user/repos?affiliation=owner&per_page=100&page=1 failed: socket hang up. Check network connectivity from the runner to https://api.test, then re-run";
    const api = new MockApi({ [OWNED]: { failed } });
    expect(await discoverRepos(api, filters({}))).toEqual(
      err({ code: "discovery-transport-failed", reason: failed }),
    );
  });

  test.each<[string, Partial<DiscoveryFilters>, string[], FilteredSlugs]>([
    [
      "default filters list owned repos, skipping archived ones",
      {},
      ["o/x", "o/copy"],
      [{ reason: "archived", slugs: [hidden("o/y")] }],
    ],
    ["archived: include keeps them", { archived: "include" }, ["o/x", "o/y", "o/copy"], []],
    [
      "archived: only inverts the skip",
      { archived: "only" },
      ["o/y"],
      [{ reason: "archived=only", slugs: [hidden("o/x"), hidden("o/copy")] }],
    ],
    [
      "forks: exclude splits on the fork field",
      { forks: "exclude" },
      ["o/x"],
      [
        { reason: "archived", slugs: [hidden("o/y")] },
        { reason: "forks=exclude", slugs: [hidden("o/copy")] },
      ],
    ],
    [
      "forks: only splits on the fork field",
      { forks: "only" },
      ["o/copy"],
      [
        { reason: "forks=only", slugs: [hidden("o/x")] },
        { reason: "archived", slugs: [hidden("o/y")] },
      ],
    ],
  ])("%s", async (_case, overrides, kept, filtered) => {
    const data = [
      { full_name: "o/x" },
      { full_name: "o/y", archived: true },
      { full_name: "o/copy", fork: true },
    ];
    const discovered = await discover({ [OWNED]: { data } }, overrides);
    expect(slugs(discovered.repos)).toEqual(kept);
    expect(filteredSlugs(discovered.filtered)).toEqual(filtered);
  });

  test("visibility normalization fails closed: private wins, both-missing is private", async () => {
    const discovered = await discover({
      [OWNED]: {
        data: [
          { full_name: "o/int", visibility: "internal" },
          { full_name: "o/priv", private: true },
          // explicit public: private === false with no visibility -> public
          { full_name: "o/pub", private: false },
          // BOTH fields missing: an unknown repo is hidden, never exposed
          { full_name: "o/unknown" },
          // forged visibility: private === true overrides a bogus "public"
          { full_name: "o/liar", visibility: "public", private: true },
          { full_name: "o/old", visibility: "private", archived: true },
        ],
      },
    });
    expect(discovered.repos).toEqual([
      { slug: "o/int", visibility: "internal" },
      { slug: "o/priv", visibility: "private" },
      { slug: "o/pub", visibility: "public" },
      { slug: "o/unknown", visibility: "private" },
      { slug: "o/liar", visibility: "private" },
    ]);
    // A filtered non-public repo is never addressed again, so its slug is sealed.
    expect(discovered.filtered).toEqual([
      { reason: "archived", repos: [{ slug: markPrivate("o/old"), visibility: "private" }] },
    ]);
  });

  // public and private go to the server as a query parameter; internal has no server parameter, and the private
  // route still returns internal repos, so both of those split client-side.
  test.each<
    [
      string,
      DiscoveryFilters["visibility"],
      string,
      Array<{ full_name: string; visibility?: string }>,
      string[],
      FilteredSlugs,
    ]
  >([
    [
      "visibility: public and private go into the query string",
      "public",
      "&visibility=public",
      [{ full_name: "o/pub" }],
      ["o/pub"],
      [],
    ],
    [
      "visibility: private drops internal repos client-side",
      "private",
      "&visibility=private",
      [{ full_name: "o/priv" }, { full_name: "o/int", visibility: "internal" }],
      ["o/priv"],
      [{ reason: "visibility=private", slugs: [hidden("o/int")] }],
    ],
    [
      "visibility: internal filters client-side with no server param",
      "internal",
      "",
      [{ full_name: "o/pub" }, { full_name: "o/int", visibility: "internal" }],
      ["o/int"],
      [{ reason: "visibility=internal", slugs: [hidden("o/pub")] }],
    ],
  ])("%s", async (_case, visibility, param, data, kept, filtered) => {
    const discovered = await discover(
      { [`GET /user/repos?affiliation=owner${param}&per_page=100&page=1`]: { data } },
      { visibility },
    );
    expect(slugs(discovered.repos)).toEqual(kept);
    expect(filteredSlugs(discovered.filtered)).toEqual(filtered);
  });

  test("topics keep repos carrying at least one listed topic, case-insensitively", async () => {
    const discovered = await discover(
      {
        [OWNED]: {
          data: [
            { full_name: "o/a", topics: ["Team-B", "misc"] },
            { full_name: "o/b", topics: ["other"] },
            { full_name: "o/c" },
          ],
        },
      },
      { topics: ["team-a", "team-b"] },
    );
    expect(slugs(discovered.repos)).toEqual(["o/a"]);
    expect(filteredSlugs(discovered.filtered)).toEqual([
      { reason: "topics (has none of: team-a, team-b)", slugs: [hidden("o/b"), hidden("o/c")] },
    ]);
  });

  test("exclude patterns name the specific glob that fired", async () => {
    const discovered = await discover(
      {
        [OWNED]: {
          data: [{ full_name: "o/keep" }, { full_name: "o/tmp-1" }, { full_name: "octo/keep" }],
        },
      },
      { exclude: ["tmp-*", "octo/*"] },
    );
    expect(slugs(discovered.repos)).toEqual(["o/keep"]);
    expect(filteredSlugs(discovered.filtered)).toEqual([
      { reason: 'exclude pattern "tmp-*"', slugs: [hidden("o/tmp-1")] },
      { reason: 'exclude pattern "octo/*"', slugs: [hidden("octo/keep")] },
    ]);
  });

  test("a repo is attributed to the first filter that drops it", async () => {
    const discovered = await discover(
      {
        [OWNED]: { data: [{ full_name: "o/tmp-fork", archived: true, fork: true }] },
      },
      { forks: "exclude", exclude: ["tmp-*"] },
    );
    expect(discovered.repos).toEqual([]);
    expect(filteredSlugs(discovered.filtered)).toEqual([
      { reason: "archived", slugs: [hidden("o/tmp-fork")] },
    ]);
  });

  test("affiliation list lands in the query string", async () => {
    const discovered = await discover(
      {
        "GET /user/repos?affiliation=owner,collaborator&per_page=100&page=1": {
          data: [{ full_name: "o/x" }],
        },
      },
      { affiliation: ["owner", "collaborator"] },
    );
    expect(slugs(discovered.repos)).toEqual(["o/x"]);
  });

  // isPermissionError decides the denial (test/github/api.test.ts); the rows here pin how discovery reads its answer.
  test.each<[string, number, string, boolean]>([
    ["a denied listing", 403, "Resource not accessible", true],
    ["a rate-limit 403", 403, "API rate limit exceeded for user", false],
    ["an expired-token 401", 401, "Bad credentials", true],
    ["a server error", 500, "boom", false],
  ])(
    "%s (%i %s) reads denied=%p: true picks PAT advice, false re-run advice",
    async (_case, status, message, denied) => {
      const api = new MockApi({
        "GET /user/repos?affiliation=owner&per_page=100&page=1": {
          error: { status, message, body: "" },
        },
      });
      expect(await discoverRepos(api, DEFAULT_DISCOVERY_FILTERS)).toEqual(
        err({
          code: "discovery-request-failed",
          path: "/user/repos?affiliation=owner",
          status,
          message,
          denied,
        }),
      );
    },
  );
});

describe("formatSkipNotice", () => {
  const ref = (
    slug: string,
    visibility: FilteredRepoRef["visibility"] = "public",
  ): FilteredRepoRef =>
    visibility === "public" ? { slug, visibility } : { slug: markPrivate(slug), visibility };
  const forks = (...repos: FilteredRepoRef[]) => ({ reason: "forks=exclude", repos });
  const archived = (...repos: FilteredRepoRef[]) => ({ reason: "archived", repos });
  const ARCHIVED_PROSE =
    "because settings writes fail on archived repositories; unarchive them to manage them";
  const twentyTwoPublic = Array.from({ length: 22 }, (_, i) => ref(`o/pub${i}`));
  const firstTwenty = twentyTwoPublic
    .slice(0, 20)
    .map((repo) => repo.slug)
    .join(", ");

  test.each<[string, { reason: string; repos: FilteredRepoRef[] }, boolean, string]>([
    [
      "without redaction, every slug is listed regardless of visibility",
      forks(ref("o/a"), ref("o/b", "private"), ref("o/c", "internal")),
      false,
      'repos: "*" discovery skipped 3 repositories by forks=exclude: o/a, o/b, o/c',
    ],
    [
      "without redaction, one repo takes the singular",
      forks(ref("o/a")),
      false,
      'repos: "*" discovery skipped 1 repository by forks=exclude: o/a',
    ],
    [
      "redaction lists public slugs and counts the rest",
      forks(ref("o/a"), ref("o/b", "private"), ref("o/c"), ref("o/d", "internal")),
      true,
      'repos: "*" discovery skipped 4 repositories by forks=exclude: o/a, o/c, and 2 private or internal repositories',
    ],
    [
      "the archived prose survives without redaction",
      archived(ref("o/a"), ref("o/b", "private")),
      false,
      `repos: "*" discovery skipped 2 repositories ${ARCHIVED_PROSE}: o/a, o/b`,
    ],
    [
      "the archived prose survives redaction",
      archived(ref("o/a"), ref("o/b", "private")),
      true,
      `repos: "*" discovery skipped 2 repositories ${ARCHIVED_PROSE}: o/a, and 1 private or internal repository`,
    ],
    // The count-only branch at both of its boundaries: one hidden repository and more than one.
    [
      "the archived prose survives a count-only notice of one",
      archived(ref("o/b", "private")),
      true,
      `repos: "*" discovery skipped 1 private or internal repository ${ARCHIVED_PROSE}`,
    ],
    [
      "the archived prose survives a count-only notice of many",
      archived(ref("o/b", "private"), ref("o/c", "internal")),
      true,
      `repos: "*" discovery skipped 2 private or internal repositories ${ARCHIVED_PROSE}`,
    ],
    [
      "redaction caps the public list at 20 before counting the hidden",
      forks(...twentyTwoPublic, ref("o/secret", "private")),
      true,
      `repos: "*" discovery skipped 23 repositories by forks=exclude: ${firstTwenty}, and 2 more, and 1 private or internal repository`,
    ],
  ])("%s", (_case, group, redact, notice) => {
    expect(formatSkipNotice(group, redact)).toBe(notice);
  });
});
