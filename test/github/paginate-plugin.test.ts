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

type Answer = (page: EndpointOptions) => Promise<unknown>;

/** A request method as the list walk builds one: a function of its own, with only `endpoint` borrowed from Octokit. */
function requestMethod(answer: Answer): { request: RequestInterface; asked: Mock<Answer> } {
  const asked = mock(answer);
  const request = Object.assign(asked, { endpoint: octokit.request.endpoint });
  return { request: request as unknown as RequestInterface, asked };
}

/** The first page's parameters, whole, as the list walk hands them over. */
const firstPage = {
  method: "GET",
  url: "/things",
  per_page: 2,
  page: 1,
} as unknown as Parameters<RequestInterface>[0];

/** Every page the plugin yields for `request`, in order. */
const walk = (request: RequestInterface): Promise<unknown[]> =>
  Array.fromAsync(octokit.paginate.iterator(request, firstPage), (page) => page.data);

const emptyPage = (link?: string) => ({ status: 200, url: "", headers: { link }, data: [] });

describe("paginate plugin assumptions of the list walk", () => {
  test("the plugin rewrites an enveloped page into its items, which is why the walk keeps each body itself", async () => {
    const { request } = requestMethod(async (page) => ({
      status: 200,
      url: page.url,
      headers: {},
      data: { total_count: 3, workflows: [{ id: 1 }] },
    }));
    const yielded = await walk(request);
    expect(
      yielded.map((data) => [Array.isArray(data), JSON.stringify(data)]),
      `the plugin no longer replaces a {total_count, <key>: []} envelope with the bare list, so ${LIST} may read the plugin's page instead of withholding the body`,
    ).toEqual([[true, '[{"id":1}]']]);
  });

  test("a function carrying `endpoint` is called once per page with one options object and an absolute url", async () => {
    const { request, asked } = requestMethod(async (page) =>
      emptyPage(page.url === NEXT ? undefined : `<${NEXT}>; rel="next"`),
    );
    await walk(request);
    expect(
      asked.mock.calls.map((args) => [args.length, args[0].method, args[0].url]),
      `the plugin changed how it calls a request method (first page through request.endpoint, one options object with an absolute url per page, next page from the Link header alone): ${LIST} reads page.url and withholds every body`,
    ).toEqual([
      [1, "GET", "https://api.test/things?per_page=2&page=1"],
      [1, "GET", NEXT],
    ]);
  });

  test("a Link header that names no next page ends the walk", async () => {
    const { request, asked } = requestMethod(async () =>
      emptyPage(`<${NEXT}>; rel="prev", <${NEXT}>; rel="last"`),
    );
    await walk(request);
    expect(
      asked,
      `the plugin now asks for a page GitHub's Link header does not name as next: ${LIST} leaves ending the walk to it`,
    ).toHaveBeenCalledTimes(1);
  });
});
