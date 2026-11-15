/**
 * What GitHubApi's list walk (src/github/api.ts) assumes of @octokit/plugin-paginate-rest beyond its types: the casts
 * there hide these from the compiler, so an upgrade that changes one would otherwise fail in list.test.ts without
 * saying which. Each test drives the plugin alone, with no request sent, and names the assumption in its failure.
 */

import { describe, expect, type Mock, mock, test } from "bun:test";
import { Octokit } from "@octokit/core";
import { paginateRest } from "@octokit/plugin-paginate-rest";
import type { EndpointOptions, RequestInterface } from "@octokit/types";

const LIST = "src/github/api.ts list()";
const NEXT = "https://api.test/things?per_page=2&page=2";
const octokit = new (Octokit.plugin(paginateRest))({ baseUrl: "https://api.test" });

const firstPage = {
  method: "GET",
  url: "/things",
  per_page: 2,
  page: 1,
} as unknown as Parameters<RequestInterface>[0];

type Ask = (page: EndpointOptions) => Promise<unknown>;

/**
 * A request method as the list walk builds one: a function of its own, with only `endpoint` borrowed from Octokit. Its
 * first answer is an empty page under `link` and every later one an empty page with none, whatever it was handed, so
 * a plugin that calls it another way still ends the walk and fails the assertion.
 */
function requestMethod(link: string): { request: RequestInterface; asked: Mock<Ask> } {
  const page = (headers: { link?: string }) => ({ status: 200, url: "", headers, data: [] });
  const asked: Mock<Ask> = mock(async () => page({})).mockResolvedValueOnce(page({ link }));
  const request = Object.assign(asked, { endpoint: octokit.request.endpoint });
  return { request: request as unknown as RequestInterface, asked };
}

/** The whole walk from the first page's parameters, as the list walk hands them over. */
async function walk(request: RequestInterface): Promise<void> {
  await Array.fromAsync(octokit.paginate.iterator(request, firstPage));
}

describe("paginate plugin assumptions of the list walk", () => {
  test("a function carrying `endpoint` is called once per page with one options object and an absolute url", async () => {
    const { request, asked } = requestMethod(`<${NEXT}>; rel="next"`);
    await walk(request);
    expect(
      asked.mock.calls.map((args) => [args.length, args[0].method, args[0].url]),
      `the plugin changed how it calls a request method (first page through request.endpoint, one options object with an absolute url per page, next page from the Link header alone): ${LIST} reads page.url and withholds every body`,
    ).toEqual([
      [1, "GET", "https://api.test/things?per_page=2&page=1"],
      [1, "GET", NEXT],
    ]);
  }, 5_000);

  test("a Link header that names no next page ends the walk", async () => {
    const { request, asked } = requestMethod(`<${NEXT}>; rel="prev", <${NEXT}>; rel="last"`);
    await walk(request);
    expect(
      asked,
      `the plugin now asks for a page GitHub's Link header does not name as next: ${LIST} leaves ending the walk to it`,
    ).toHaveBeenCalledTimes(1);
  }, 5_000);
});
