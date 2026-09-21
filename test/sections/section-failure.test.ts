import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  type GitHubClient,
  SECRET_RESPONSE_WITHHELD,
  SECRET_TRANSPORT_WITHHELD,
} from "../../src/github/api.js";
import type { EndpointDecl } from "../../src/sections/contract/endpoints.js";
import { failureFor, type SectionFailure } from "../../src/sections/contract/errors.js";
import { parseLive } from "../../src/sections/contract/live.js";
import type { SectionContext, SectionMeta } from "../../src/sections/contract/module.js";
import { callDeclared, listAll } from "../../src/sections/contract/requests.js";
import { MockApi } from "../mock-api.js";

/** The ladder's order decides the kind (a rate-limited 403 is never a denial); the line is the one the loops report. */
const section: SectionMeta = {
  key: "rulesets",
  permission: { repo: ["administration"] },
  endpoints: {},
  undeclaredDefault: "untouched",
};

const create: EndpointDecl = {
  route: "POST /repos/{owner}/{repo}/rulesets",
  statuses: { 201: "created" },
  rejections: [
    {
      status: 404,
      message: "Branch not found",
      advice: "the declared branch does not exist; create it",
    },
  ],
};

const REJECTED_BODY =
  '. The API rejected the request; fix the "rulesets" values in the settings file to satisfy the message above';

describe("failureFor classifies each kind with the message the throw carried", () => {
  test.each<
    [kind: SectionFailure["kind"], error: Parameters<typeof failureFor>[3], message: string]
  >([
    [
      "rate-limit",
      { status: 403, message: "API rate limit exceeded", body: "", rateLimited: true },
      "rulesets: POST /repos/o/r/rulesets: 403 API rate limit exceeded. The API rate limit was hit; re-run the workflow after the limit resets, or use a token with a higher rate limit",
    ],
    [
      "permission-denied",
      { status: 403, message: "Resource not accessible by personal access token", body: "" },
      'rulesets: the token was denied POST /repos/o/r/rulesets: 403 Resource not accessible by personal access token. To fix, grant "Administration" (read and write) under the PAT\'s Repository permissions',
    ],
    [
      "server-error",
      { status: 502, message: "Bad Gateway", body: "" },
      "rulesets: POST /repos/o/r/rulesets: 502 Bad Gateway. GitHub returned a server error; re-run the workflow, and retry later if it persists",
    ],
    [
      "unauthorized",
      { status: 401, message: "Bad credentials", body: "" },
      "rulesets: POST /repos/o/r/rulesets: 401 Bad credentials. The token was rejected as invalid or expired; update the token input (or the secret it reads) with a valid, unexpired PAT",
    ],
    [
      "validation",
      { status: 422, message: "Validation Failed", body: "" },
      `rulesets: POST /repos/o/r/rulesets: 422 Validation Failed${REJECTED_BODY}`,
    ],
    [
      "rejected",
      { status: 404, message: "Branch not found", body: "" },
      "rulesets: POST /repos/o/r/rulesets: 404 Branch not found. The declared branch does not exist; create it",
    ],
  ])("%s", (kind, error, message) => {
    expect(failureFor(section, "POST", "/repos/o/r/rulesets", error, { op: create })).toMatchObject(
      { kind, message },
    );
  });
});

describe("the kinds the helpers add beside failureFor's", () => {
  const ctx: SectionContext = {
    api: new MockApi({}),
    repo: { owner: "o", name: "r", slug: "o/r" },
    check: false,
    resolveSecret: () => "",
  };

  test("transport: a client throwing on a secret-carrying request is a withheld value, not a throw", async () => {
    const throwing: GitHubClient = {
      tryRequest: async () => {
        throw new Error("ECONNRESET while sending hunter2");
      },
      tryGraphql: async () => {
        throw new Error("unused");
      },
    };
    const result = await callDeclared({ ...ctx, api: throwing }, section, create, {
      payload: { token: "hunter2" },
      carriesSecret: true,
    });
    expect(result.isErr() && result.error).toEqual({
      kind: "transport",
      message: `POST /repos/o/r/rulesets failed: ${SECRET_TRANSPORT_WITHHELD}. Check network connectivity from the runner to the GitHub API, then re-run`,
    });
    // The control: an unmarked request lets the client's own throw through untouched.
    await expect(
      callDeclared({ ...ctx, api: throwing }, section, create, {
        payload: { token: "hunter2" },
        carriesSecret: false,
      }),
    ).rejects.toThrow(new Error("ECONNRESET while sending hunter2"));
  });

  test("a withheld response still classifies by status", async () => {
    const api = new MockApi({
      "POST /repos/o/r/rulesets": { error: { status: 422, message: "echo hunter2", body: "" } },
    });
    const result = await callDeclared({ ...ctx, api }, section, create, {
      payload: { token: "hunter2" },
      carriesSecret: true,
    });
    expect(result.isErr() && result.error).toEqual({
      kind: "validation",
      message: `rulesets: POST /repos/o/r/rulesets: 422 ${SECRET_RESPONSE_WITHHELD}${REJECTED_BODY}`,
    });
  });

  test("malformed: a page that is not a list, and a body off the documented shape", async () => {
    const list = {
      route: "GET /repos/{owner}/{repo}/rulesets",
      statuses: { 200: "the rulesets" },
    } as const satisfies EndpointDecl;
    const api = new MockApi({
      "GET /repos/o/r/rulesets?per_page=100&page=1": { data: { not: 1 } },
    });
    const listed = await listAll({ ...ctx, api }, section, list);
    expect(listed.isErr() && listed.error).toEqual({
      kind: "malformed",
      message:
        'rulesets: GET /repos/o/r/rulesets returned a JSON value without a list, so the response cannot be paginated. Check the "api-version" input against the GitHub REST docs for this endpoint',
    });
    const parsed = parseLive(section, list, z.object({ id: z.number() }), { id: "x" });
    expect(parsed.isErr() && parsed.error).toEqual({
      kind: "malformed",
      message:
        'rulesets: GET /repos/{owner}/{repo}/rulesets returned a body outside the documented shape - id: Invalid input: expected number, received string. Check the "api-version" input against the GitHub REST docs for this endpoint',
    });
  });
});
