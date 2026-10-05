import { describe, expect, test } from "bun:test";
import type { EndpointDecl } from "../../src/sections/contract/endpoints.js";
import type { SectionContext, SectionMeta } from "../../src/sections/contract/module.js";
import { listAll, listAllEnveloped } from "../../src/sections/contract/requests.js";
import { MockApi } from "../mock-api.js";

const section: SectionMeta = {
  key: "rulesets",
  permission: { repo: ["administration"] },
  endpoints: {},
  undeclaredDefault: "untouched",
};

const list = {
  route: "GET /repos/{owner}/{repo}/rulesets",
  statuses: { 200: "the rulesets" },
} as const satisfies EndpointDecl;

const secrets = {
  route: "GET /repos/{owner}/{repo}/actions/secrets",
  statuses: { 200: "the secrets" },
} as const satisfies EndpointDecl;

const PATH = "/repos/o/r/rulesets";
const PAGE_1 = `GET ${PATH}?per_page=100&page=1`;
const PAGE_2 = `GET ${PATH}?per_page=100&page=2`;

const ctx = (api: MockApi): SectionContext => ({
  api,
  repo: { owner: "o", name: "r", slug: "o/r" },
  check: false,
  resolveSecret: () => "",
});

const fullPage = (prefix: string) =>
  Array.from({ length: 100 }, (_, i) => ({ id: i, name: `${prefix}${i}` }));

describe("the list helpers over the port's walk", () => {
  test("listAll concatenates the pages in order", async () => {
    const api = new MockApi({
      [PAGE_1]: { data: fullPage("a") },
      [PAGE_2]: { data: [{ id: 100, name: "b0" }] },
    });
    const listed = await listAll(ctx(api), section, list);
    expect(listed.isOk() && listed.value).toEqual([...fullPage("a"), { id: 100, name: "b0" }]);
    expect(api.calls.map((call) => `${call.method} ${call.path}`)).toEqual([PAGE_1, PAGE_2]);
  });

  test("listAllEnveloped flattens the envelopes by the named key, page by page", async () => {
    const path = "/repos/o/r/actions/secrets";
    const first = Array.from({ length: 100 }, (_, i) => ({ name: `S${i}` }));
    const api = new MockApi({
      [`GET ${path}?per_page=100&page=1`]: { data: { total_count: 101, secrets: first } },
      [`GET ${path}?per_page=100&page=2`]: {
        data: { total_count: 101, secrets: [{ name: "LAST" }] },
      },
    });
    const listed = await listAllEnveloped(ctx(api), section, secrets, "secrets");
    expect(listed.isOk() && listed.value).toEqual([...first, { name: "LAST" }]);
  });

  test("a full page is read off the named list, not off an empty list beside it in the envelope", async () => {
    const path = "/repos/o/r/actions/secrets";
    const first = Array.from({ length: 100 }, (_, i) => ({ name: `S${i}` }));
    const api = new MockApi({
      [`GET ${path}?per_page=100&page=1`]: {
        data: { total_count: 101, metadata: [], secrets: first },
      },
      [`GET ${path}?per_page=100&page=2`]: {
        data: { total_count: 101, metadata: [], secrets: [{ name: "LAST" }] },
      },
    });
    const listed = await listAllEnveloped(ctx(api), section, secrets, "secrets");
    expect(listed.isOk() && listed.value).toHaveLength(101);
  });

  test("an envelope without the named key is malformed, whichever list it carries instead", async () => {
    const api = new MockApi({
      "GET /repos/o/r/actions/secrets?per_page=100&page=1": {
        data: { total_count: 1, variables: [{ name: "X" }] },
      },
    });
    const listed = await listAllEnveloped(ctx(api), section, secrets, "secrets");
    expect(listed.isErr() && listed.error).toEqual({
      kind: "malformed",
      message:
        'rulesets: GET /repos/o/r/actions/secrets returned a JSON value without a "secrets" list, so the response cannot be paginated. Check the "api-version" input against the GitHub REST docs for this endpoint',
    });
  });

  test("a page without the list ends the walk: its malformed diagnosis stands, and the next page is never asked for", async () => {
    const path = "/repos/o/r/actions/secrets";
    const api = new MockApi({
      [`GET ${path}?per_page=100&page=1`]: {
        data: {
          total_count: 101,
          variables: Array.from({ length: 100 }, (_, i) => ({ name: `V${i}` })),
        },
      },
      [`GET ${path}?per_page=100&page=2`]: {
        error: {
          status: 403,
          message: "Resource not accessible by personal access token",
          body: "",
        },
      },
    });
    const listed = await listAllEnveloped(ctx(api), section, secrets, "secrets");
    expect(listed.isErr() && listed.error.kind).toBe("malformed");
    expect(api.calls).toHaveLength(1);
  });

  test("a denial on the second page fails exactly as one on the first: the list's own path, never the page's", async () => {
    const denial = {
      status: 403,
      message: "Resource not accessible by personal access token",
      body: "",
    };
    const onFirst = await listAll(ctx(new MockApi({ [PAGE_1]: { error: denial } })), section, list);
    const onSecond = await listAll(
      ctx(new MockApi({ [PAGE_1]: { data: fullPage("a") }, [PAGE_2]: { error: denial } })),
      section,
      list,
    );
    expect(onSecond.isErr() && onSecond.error).toEqual(onFirst.isErr() && onFirst.error);
    expect(onSecond.isErr() && onSecond.error.message).toBe(
      `rulesets: the token was denied GET ${PATH}: 403 Resource not accessible by personal access token. ` +
        `To fix, grant "Administration" (read and write) under the PAT's Repository permissions`,
    );
  });
});
