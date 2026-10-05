import { afterEach, describe, expect, test } from "bun:test";
import { MAX_RETRIES } from "../../src/github/api.js";
import { api, restoreFetch, stubFetch, traceIo } from "./stub.js";

afterEach(restoreFetch);

const JSON_HEADERS = { "content-type": "application/json" };

/** A page as GitHub serves one: the JSON body, and the `next` Link when more pages follow. */
const page = (body: unknown, next?: string) => () =>
  new Response(JSON.stringify(body), {
    headers: next === undefined ? JSON_HEADERS : { ...JSON_HEADERS, link: `<${next}>; rel="next"` },
  });

const fullPage = (prefix: string) => Array.from({ length: 100 }, (_, i) => `${prefix}${i}`);

describe("tryList", () => {
  test("follows the Link header and hands back every page's body as GitHub sent it, in order", async () => {
    const next = "https://api.test/repos/o/r/actions/workflows?per_page=2&page=2";
    const stub = stubFetch([
      page({ total_count: 3, workflows: [{ id: 1 }, { id: 2 }] }, next),
      page({ total_count: 3, workflows: [{ id: 3 }] }),
    ]);
    const result = await api().tryList("/repos/o/r/actions/workflows", { perPage: 2 });
    expect(result).toEqual({
      data: [
        { total_count: 3, workflows: [{ id: 1 }, { id: 2 }] },
        { total_count: 3, workflows: [{ id: 3 }] },
      ],
    });
    expect(stub.urls).toEqual([
      "https://api.test/repos/o/r/actions/workflows?per_page=2&page=1",
      next,
    ]);
  });

  test("a page without a Link header ends the walk, however full", async () => {
    const stub = stubFetch([page(fullPage("a"))]);
    const result = await api().tryList("/things");
    expect(result).toEqual({ data: [fullPage("a")] });
    expect(stub.urls).toEqual(["https://api.test/things?per_page=100&page=1"]);
  });

  test("an existing query string keeps its params and gains the page ones", async () => {
    const stub = stubFetch([page(["only"])]);
    expect(await api().tryList("/things?state=all")).toEqual({ data: [["only"]] });
    expect(stub.urls).toEqual(["https://api.test/things?state=all&per_page=100&page=1"]);
  });

  test("a denial mid-walk is the error, and every page fetched leaves a trace line", async () => {
    const trace = traceIo();
    stubFetch([
      page(fullPage("a"), "https://api.test/repos/o/r/labels?per_page=100&page=2"),
      () =>
        new Response(JSON.stringify({ message: "Forbidden" }), {
          status: 403,
          headers: JSON_HEADERS,
        }),
    ]);
    const result = await api(trace.io).tryList("/repos/o/r/labels");
    expect("error" in result && result.error).toMatchObject({ status: 403, message: "Forbidden" });
    // The request-log plugin writes its own lines beside the client's; the client's carry the arrow.
    const traced = trace.lines.filter((line) => line.includes(" -> "));
    expect(traced.map((line) => line.replace(/\(\d+ms\)/, "(ms)"))).toEqual([
      "GET /repos/o/r/labels?per_page=100&page=1 -> 200 (ms)",
      "GET /repos/o/r/labels?per_page=100&page=2 -> 403 (ms)",
    ]);
  });

  test("every page is requested on the route the caller named, so a masked slug redacts every page's trace", async () => {
    // GitHub's next Link addresses the repository by id, a form the slug redaction cannot match.
    const trace = traceIo();
    trace.io.mask("o/private");
    const listPath = "/repos/o/private/environments/secret-environment/secrets";
    const stub = stubFetch([
      page(
        { total_count: 101, secrets: fullPage("s") },
        "https://api.test/repositories/123/environments/secret-environment/secrets?per_page=100&page=2",
      ),
      page({ total_count: 101, secrets: ["last"] }),
    ]);
    const result = await api(trace.io).tryList(listPath);
    expect("data" in result && result.data).toHaveLength(2);
    expect(stub.urls).toEqual([
      `https://api.test${listPath}?per_page=100&page=1`,
      `https://api.test${listPath}?per_page=100&page=2`,
    ]);
    expect(trace.lines.join("\n")).not.toContain("secret-environment");
    const traced = trace.lines.filter((line) => line.includes(" -> "));
    expect(traced.map((line) => line.replace(/\(\d+ms\)/, "(ms)"))).toEqual([
      "GET <redacted> -> 200 (ms)",
      "GET <redacted> -> 200 (ms)",
    ]);
  });

  test("a 409 is the error it is, never an empty list", async () => {
    stubFetch([
      () =>
        new Response(JSON.stringify({ message: "Git Repository is empty." }), {
          status: 409,
          headers: JSON_HEADERS,
        }),
    ]);
    const result = await api().tryList("/repos/o/r/commits");
    expect("error" in result && result.error).toMatchObject({
      status: 409,
      message: "Git Repository is empty.",
    });
  });

  test("until ends the walk after the page it accepts", async () => {
    const stub = stubFetch([
      page([{ number: 7 }], "https://api.test/repos/o/r/issues?per_page=100&page=2"),
      page([{ number: 6 }]),
    ]);
    const result = await api().tryList("/repos/o/r/issues", {
      until: (body) => Array.isArray(body) && body.length > 0,
    });
    expect(result).toEqual({ data: [[{ number: 7 }]] });
    expect(stub.calls).toBe(1);
  });

  test("a transport failure, once the retries are spent, names the page being fetched", async () => {
    const stub = stubFetch([
      () => {
        throw new Error("socket hang up");
      },
    ]);
    const result = await api().tryList("/things");
    expect(stub.calls).toBe(1 + MAX_RETRIES);
    expect(result).toEqual({
      failed:
        "GET /things?per_page=100&page=1 failed: socket hang up. Check network connectivity from the runner to https://api.test, then re-run",
    });
  });
});
