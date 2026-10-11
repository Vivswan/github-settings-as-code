import { afterEach, describe, expect, test } from "bun:test";
import { MAX_RETRIES } from "../../src/github/api.js";
import { getRepoFile } from "../../src/github/repo-file.js";
import { api, restoreFetch, stubFetch } from "./stub.js";

afterEach(restoreFetch);

const FILE = ".github/settings.yml";
const CONTENTS = `/repos/o/r/contents/${FILE}`;
const REPO = "/repos/o/r";
const REF = "/repos/o/r/git/ref/heads/main";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
const notFound = () => json(404, { message: "Not Found" });
const forbidden = () => json(403, { message: "Resource not accessible by personal access token" });
const repo =
  (defaultBranch = "main") =>
  () =>
    json(200, { default_branch: defaultBranch });
const repoWithoutDefaultBranch = () => json(200, { full_name: "o/r" });
const ref = () => json(200, { ref: "refs/heads/main", object: { sha: "a".repeat(40) } });

describe("getRepoFile", () => {
  test("a present file is returned from the contents read alone", async () => {
    const state = stubFetch([() => new Response("labels: []\n")]);
    const result = await getRepoFile(api(), "o/r", FILE);
    expect(state.paths).toEqual([CONTENTS]);
    expect(result).toEqual({ content: "labels: []\n" });
  });

  test("a contents 404 is missing only once the default branch ref proves Contents access", async () => {
    const state = stubFetch([notFound, repo(), ref]);
    const result = await getRepoFile(api(), "o/r", FILE);
    expect(state.paths).toEqual([CONTENTS, REPO, REF]);
    expect(result).toEqual({ missing: true });
  });

  test.each([
    ["a slash stays a segment separator", "release/1.x", "/repos/o/r/git/ref/heads/release/1.x"],
    ["a URL-significant character is encoded", "release#1", "/repos/o/r/git/ref/heads/release%231"],
  ])("the ref read follows the repo's default branch: %s", async (_name, branch, refPath) => {
    const state = stubFetch([notFound, repo(branch), ref]);
    const result = await getRepoFile(api(), "o/r", FILE);
    expect(state.paths).toEqual([CONTENTS, REPO, refPath]);
    expect(result).toEqual({ missing: true });
  });

  const unproven = (status: number) => ({
    unproven:
      `cannot prove ${FILE} is absent: reading the default branch ref heads/main returned ` +
      `${status}. Grant the token Contents: read on this repository, or initialize its ` +
      `default branch; a repository whose file cannot be read never receives the defaults`,
  });
  const limited = () =>
    new Response(JSON.stringify({ message: "API rate limit exceeded for user ID 1." }), {
      status: 403,
      headers: { "content-type": "application/json", "x-ratelimit-remaining": "0" },
    });
  test.each([
    [
      "404",
      "is an inconclusive proof naming the grant and the empty-branch case, never a missing file",
      notFound,
      1,
      unproven(404),
    ],
    [
      "403",
      "is an inconclusive proof naming the grant and the empty-branch case, never a missing file",
      forbidden,
      1,
      unproven(403),
    ],
    [
      "rate-limited 403",
      "keeps its classification instead of blaming the grant",
      limited,
      1 + MAX_RETRIES,
      {
        error: {
          status: 403,
          message: "API rate limit exceeded for user ID 1.",
          body: JSON.stringify({ message: "API rate limit exceeded for user ID 1." }),
        },
      },
    ],
    [
      "500",
      "surfaces as itself, after the client's own retries",
      () => json(500, { message: "boom" }),
      1 + MAX_RETRIES,
      { error: { status: 500, message: "boom", body: JSON.stringify({ message: "boom" }) } },
    ],
  ])("a %s on the ref read %s", async (_status, _outcome, refResponse, refReads, expected) => {
    const state = stubFetch([notFound, repo(), refResponse]);
    const result = await getRepoFile(api(), "o/r", FILE);
    expect(state.paths).toEqual([CONTENTS, REPO, ...Array<string>(refReads).fill(REF)]);
    expect(result).toEqual(expected);
  });

  test("a contents 404 on an invisible repo surfaces the repo-level error before any ref read", async () => {
    const state = stubFetch([notFound, notFound]);
    const result = await getRepoFile(api(), "o/r", FILE);
    expect(state.paths).toEqual([CONTENTS, REPO]);
    expect(result).toEqual({
      error: {
        status: 404,
        message: "Not Found",
        body: JSON.stringify({ message: "Not Found" }),
      },
    });
  });

  test("a transport failure on any of the three reads comes back as the client's failed line, never a throw", async () => {
    // The socket dies on the ref read, once per retry; the line names the request and the remedy, and the caller renders it.
    const drop = () => {
      throw new Error("socket hang up");
    };
    const state = stubFetch([notFound, repo(), drop, drop, drop]);
    const result = await getRepoFile(api(), "o/r", FILE);
    expect(state.paths).toEqual([CONTENTS, REPO, ...Array<string>(1 + MAX_RETRIES).fill(REF)]);
    expect(result).toEqual({
      failed:
        "GET /repos/o/r/git/ref/heads/main failed: socket hang up. Check network connectivity from the runner to https://api.test, then re-run",
    });
  });

  test("a repo object without a default branch cannot prove anything and is an error", async () => {
    const state = stubFetch([notFound, repoWithoutDefaultBranch]);
    const result = await getRepoFile(api(), "o/r", FILE);
    expect(state.paths).toEqual([CONTENTS, REPO]);
    expect(result).toEqual({
      error: {
        status: 500,
        message: `the repository object names no default branch, so Contents access cannot be proven and ${FILE} cannot be fetched`,
        body: "",
      },
    });
  });
});
