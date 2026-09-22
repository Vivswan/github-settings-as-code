import { describe, expect, test } from "bun:test";
import { endpointMethod, endpointPath } from "../../../src/sections/contract/endpoints.js";
import { allEndpoints } from "../../../src/sections/registry.js";
import type { LoggedRequest } from "../mock/contract.js";
import { excludeUndocumented } from "./paths.js";
import {
  loadSpec,
  OpenApiValidator,
  type OpenApiViolation,
  pathMatches,
  sharedValidator,
  toJsonSchema,
  trimDescriptor,
  validateExchange,
} from "./validate.js";

function req(overrides: Partial<LoggedRequest>): LoggedRequest {
  return { method: "GET", pathname: "/", query: "", status: 200, ...overrides };
}

/** The descriptor node at `keys`, for the lockstep tests, which walk into schemas the validator does not type. */
function at(root: unknown, ...keys: string[]): Record<string, unknown> {
  let node: unknown = root;
  for (const key of keys) {
    node = (node as Record<string, unknown>)[key];
  }
  return node as Record<string, unknown>;
}

const line = (violation: OpenApiViolation): string => `${violation.kind}: ${violation.detail}`;

/** An empty `expected` pins a clean exchange; otherwise every pattern must match one finding line. */
function expectFindings(lines: readonly string[], expected: readonly RegExp[]): void {
  if (expected.length === 0) {
    expect(lines).toEqual([]);
    return;
  }
  for (const pattern of expected) {
    expect(
      lines.some((found) => pattern.test(found)),
      `no finding matches ${pattern}`,
    ).toBe(true);
  }
}

describe("toJsonSchema", () => {
  // GitHub's custom-property `value` schema is `oneOf [string, string[]]` with nullable: true and
  // NO sibling type; a null value must validate.
  const nullableOneOf = {
    nullable: true,
    oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
  };
  const overlappingOneOf = {
    oneOf: [
      { type: "object", required: ["a"], properties: { a: { type: "string" } } },
      { type: "object", required: ["b"], properties: { b: { type: "string" } } },
    ],
  };

  test.each<[label: string, args: Parameters<typeof toJsonSchema>, expected: unknown]>([
    [
      "folds nullable:true into a type array",
      [{ type: "string", nullable: true }],
      { type: ["string", "null"] },
    ],
    [
      "appends null to an existing type array",
      [{ type: ["string", "number"], nullable: true }],
      { type: ["string", "number", "null"] },
    ],
    [
      "does not duplicate a null already in the type array",
      [{ type: ["string", "null"], nullable: true }],
      { type: ["string", "null"] },
    ],
    [
      "a nullable enum gains null (the code-quality runner_type shape)",
      [{ type: "string", nullable: true, enum: ["standard", "labeled"] }],
      { type: ["string", "null"], enum: ["standard", "labeled", null] },
    ],
    [
      "a nullable enum already carrying null is not doubled",
      [{ type: "string", nullable: true, enum: ["weekly", null] }],
      { type: ["string", "null"], enum: ["weekly", null] },
    ],
    [
      "a non-nullable enum is untouched",
      [{ type: "string", enum: ["standard"] }],
      { type: "string", enum: ["standard"] },
    ],
    [
      // ajv treats a type-less schema as accept-anything, the safe reading.
      "nullable without a type is dropped, not turned into a bare null type",
      [{ nullable: true, description: "x" }],
      { description: "x" },
    ],
    [
      "nullable beside a bare oneOf gains a null branch (request variant keeps oneOf)",
      [nullableOneOf, true],
      {
        oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }, { type: "null" }],
      },
    ],
    [
      "nullable beside a bare oneOf gains a null branch (response variant widens to anyOf)",
      [nullableOneOf],
      {
        anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }, { type: "null" }],
      },
    ],
    [
      "strips required from a response schema (presence relaxed) by default",
      [{ type: "object", required: ["id"], properties: { id: { type: "integer" } } }],
      { type: "object", properties: { id: { type: "integer" } } },
    ],
    [
      "keeps required when keepRequired is set (request-body variant)",
      [{ type: "object", required: ["id"], properties: { id: { type: "integer" } } }, true],
      { type: "object", required: ["id"], properties: { id: { type: "integer" } } },
    ],
    [
      "strips annotation-only keywords ajv would choke on",
      [
        {
          type: "object",
          example: { a: 1 },
          examples: [1, 2],
          xml: { name: "thing" },
          discriminator: { propertyName: "kind" },
          properties: { a: { type: "integer", example: 5 } },
        },
      ],
      { type: "object", properties: { a: { type: "integer" } } },
    ],
    [
      "recurses through arrays and nested objects",
      [
        {
          allOf: [
            { type: "string", nullable: true },
            { type: "object", example: {} },
          ],
        },
      ],
      { allOf: [{ type: ["string", "null"] }, { type: "object" }] },
    ],
    ["leaves a string primitive untouched", ["s"], "s"],
    ["leaves a number primitive untouched", [3], 3],
    ["leaves null untouched", [null], null],
    [
      "relaxed variant rewrites oneOf to anyOf (widened branches may overlap)",
      [overlappingOneOf],
      {
        anyOf: [
          { type: "object", properties: { a: { type: "string" } } },
          { type: "object", properties: { b: { type: "string" } } },
        ],
      },
    ],
    [
      "the request variant keeps an overlapping oneOf as is",
      [overlappingOneOf, true],
      overlappingOneOf,
    ],
  ])("%s", (_label, args, expected) => {
    expect(toJsonSchema(...args)).toEqual(expected);
  });

  test("a widened oneOf that would fail exactly-one passes as anyOf end to end", () => {
    const spec = {
      paths: {
        "/repos/{owner}/{repo}/thing": {
          get: {
            responses: {
              "200": {
                content: {
                  "application/json": {
                    schema: {
                      oneOf: [
                        { type: "object", required: ["a"], properties: { a: { type: "string" } } },
                        { type: "object", required: ["b"], properties: { b: { type: "string" } } },
                      ],
                    },
                  },
                },
              },
            },
          },
        },
      },
    };
    const v = new OpenApiValidator(spec as never);
    const violations = v.validateRequest({
      method: "GET",
      pathname: "/repos/o/r/thing",
      query: "",
      status: 200,
      responseBody: { a: "x", b: "y" }, // matches both branches
    });
    expect(violations).toEqual([]);
  });

  test("the relaxed oneOf still accepts data matching exactly ONE original branch", () => {
    // GitHub's oneOf [Simple User (required fields), Empty Object]: {} matches only Empty Object
    // under raw oneOf; with required stripped it matches BOTH and oneOf rejects valid data.
    const spec = {
      paths: {
        "/repos/{owner}/{repo}/thing": {
          get: {
            responses: {
              "200": {
                content: {
                  "application/json": {
                    schema: {
                      oneOf: [
                        {
                          type: "object",
                          required: ["login", "id"],
                          properties: { login: { type: "string" }, id: { type: "integer" } },
                        },
                        { type: "object", properties: {}, additionalProperties: false },
                      ],
                    },
                  },
                },
              },
            },
          },
        },
      },
    };
    const v = new OpenApiValidator(spec as never);
    expect(
      v.validateRequest({
        method: "GET",
        pathname: "/repos/o/r/thing",
        query: "",
        status: 200,
        responseBody: {},
      }),
    ).toEqual([]);
    expect(
      v.validateRequest({
        method: "GET",
        pathname: "/repos/o/r/thing",
        query: "",
        status: 200,
        responseBody: { login: "octocat", id: 1 },
      }),
    ).toEqual([]);
  });
});

describe("undocumented-route exemption", () => {
  test.each<[label: string, request: LoggedRequest, kinds: string[]]>([
    [
      "the declared LFS PUT is exempt",
      req({ method: "PUT", pathname: "/repos/o/r/lfs", status: 202 }),
      [],
    ],
    [
      "the declared LFS DELETE is exempt",
      req({ method: "DELETE", pathname: "/repos/o/r/lfs", status: 204 }),
      [],
    ],
    [
      "an unlisted method on the same path is still an unknown route",
      req({ method: "GET", pathname: "/repos/o/r/lfs", status: 200, responseBody: {} }),
      ["unknown-route"],
    ],
    [
      "a near-miss path is still an unknown route",
      req({ method: "PUT", pathname: "/repos/o/r/lsf" }),
      ["unknown-route"],
    ],
  ])("%s", (_label, request, kinds) => {
    const violations = validateExchange(request);
    expect(violations.map((v) => v.match(/\[([a-z-]+)\]/)?.[1])).toEqual(kinds);
  });

  test("excludeUndocumented removes declared paths and throws on a stale entry", () => {
    expect(excludeUndocumented(new Set(["/a", "/b"]), ["/b"])).toEqual(["/a"]);
    expect(() => excludeUndocumented(new Set(["/a"]), ["/gone"])).toThrow(
      /fix or delete that gap file/,
    );
  });
});

describe("pathMatches greedy trailing params", () => {
  const contents = "/repos/{owner}/{repo}/contents/{path}";
  const gitRef = "/repos/{owner}/{repo}/git/ref/{ref}";
  const labelName = "/repos/{owner}/{repo}/labels/{name}";

  test.each<[template: string, pathname: string, matches: boolean]>([
    [contents, "/repos/o/r/contents/.github/settings.yml", true],
    [contents, "/repos/o/r/contents/README.md", true],
    [contents, "/repos/o/r/contents", false],
    [gitRef, "/repos/o/r/git/ref/heads/main", true],
    [gitRef, "/repos/o/r/git/ref/heads/release/1.x", true],
    [gitRef, "/repos/o/r/git/ref", false],
    [labelName, "/repos/o/r/labels/bug", true],
    [labelName, "/repos/o/r/labels/bug/extra", false],
  ])("%s against %s -> %p", (template, pathname, matches) => {
    expect(pathMatches(template, pathname)).toBe(matches);
  });
});

describe("OpenApiValidator against the fetched spec", () => {
  const v = sharedValidator();

  test("the fetched spec loads and shares one instance", () => {
    expect(sharedValidator()).toBe(v);
  });

  test("a real repository GET with a plausible body passes", () => {
    const violations = v.validateRequest(
      req({
        method: "GET",
        pathname: "/repos/e2e-owner/e2e-repo",
        status: 200,
        responseBody: {
          id: 1,
          node_id: "abc",
          name: "e2e-repo",
          full_name: "e2e-owner/e2e-repo",
          private: false,
          owner: { login: "e2e-owner", id: 2 },
        },
      }),
    );
    expect(violations).toEqual([]);
  });

  test("every declared endpoint's pageSize matches the spec's documented per_page cap", () => {
    // The per_page cap is not machine-readable: it lives in the description prose. GitHub CLAMPS an
    // oversized per_page and the page loop stops on a short page, so an undeclared sub-100 cap
    // silently truncates after page one (the variables family is capped at 30).
    const spec = loadSpec() as {
      paths?: Record<
        string,
        Record<string, { parameters?: unknown[] }> & { parameters?: unknown[] }
      >;
    };
    // loadSpec() rejects any surviving $ref, so parameters are inline objects.
    const asParam = (param: unknown): { name?: string; description?: string } =>
      param as { name?: string; description?: string };
    let cappedEndpoints = 0;
    for (const [key, endpoint] of Object.entries(allEndpoints())) {
      const path = endpointPath(endpoint.route);
      const method = endpointMethod(endpoint.route).toLowerCase();
      const pathItem = spec.paths?.[path];
      const operation = pathItem?.[method];
      if (!operation) {
        // Only the routes the descriptor omits (LFS) miss here.
        continue;
      }
      const parameters = [...(operation.parameters ?? []), ...(pathItem?.parameters ?? [])];
      const perPage = parameters.map(asParam).find((p) => p.name === "per_page");
      if (perPage === undefined) {
        continue; // not a paginated endpoint
      }
      const capMatch = (perPage.description ?? "").match(/max(?:imum)?(?: of)? (\d+)/i);
      const cap = capMatch ? Number(capMatch[1]) : 100;
      const expected = Math.min(cap, 100);
      if (expected < 100) {
        cappedEndpoints++;
      }
      expect(
        endpoint.pageSize ?? 100,
        `${key} (${endpoint.route}): the spec documents a per_page cap of ${cap}, so the declaration must carry pageSize ${expected < 100 ? expected : "unset (standard 100)"}`,
      ).toBe(expected);
    }
    // The variables list is capped at 30; zero capped endpoints means the
    // description regex rotted, not that every endpoint takes 100.
    expect(cappedEndpoints).toBeGreaterThan(0);
  });

  test.each<[label: string, request: LoggedRequest]>([
    [
      "a path the spec does not document",
      req({
        method: "GET",
        pathname: "/repos/e2e-owner/e2e-repo/not-a-real-endpoint",
        status: 200,
      }),
    ],
    [
      // DELETE /repos/{owner}/{repo}/labels is not a documented operation.
      "a method the spec does not document on a known path",
      req({ method: "DELETE", pathname: "/repos/e2e-owner/e2e-repo/labels", status: 204 }),
    ],
  ])("%s is one unknown-route violation", (_label, request) => {
    expect(v.validateRequest(request).map((x) => x.kind)).toEqual(["unknown-route"]);
  });

  test("a valid label create body passes request-body validation", () => {
    const violations = v.validateRequest(
      req({
        method: "POST",
        pathname: "/repos/e2e-owner/e2e-repo/labels",
        status: 201,
        body: { name: "bug", color: "d73a4a", description: "Something isn't working" },
        responseBody: {
          id: 1,
          node_id: "n",
          url: "https://api.github.com/repos/e2e-owner/e2e-repo/labels/bug",
          name: "bug",
          color: "d73a4a",
          default: false,
          description: "Something isn't working",
        },
      }),
    );
    expect(violations).toEqual([]);
  });

  const labelCreate = { method: "POST", pathname: "/repos/e2e-owner/e2e-repo/labels" } as const;
  const labelDelete = {
    method: "DELETE",
    pathname: "/repos/e2e-owner/e2e-repo/labels/bug",
  } as const;
  const environment = { pathname: "/repos/e2e-owner/e2e-repo/environments/production" } as const;

  // Request bodies keep `required` (presence enforced) and are checked on every status the tag does
  // not exempt.
  test.each<[label: string, request: LoggedRequest, expected: RegExp[]]>([
    [
      "a body with a wrong-typed field is a request-body violation",
      req({ ...labelCreate, status: 201, body: { name: "bug", color: 123 } }),
      [/^request-body:/],
    ],
    [
      // Settings pass through verbatim, so a user typo the request schema forbids reaching the API
      // and being 422'd is modeled behavior (the rulesets-invalid-rule-type scenario).
      "an off-schema body the mock REJECTED as requestOffSpec skips only the body check",
      req({
        ...labelCreate,
        status: 422,
        body: { name: "bug", color: 123 },
        responseBody: { message: "Validation Failed" },
        requestOffSpec: true,
      }),
      [],
    ],
    [
      "an off-schema body on an UNTAGGED 4xx is still a request-body violation",
      req({
        ...labelCreate,
        status: 422,
        body: { name: "bug", color: 123 },
        responseBody: { message: "Validation Failed" },
      }),
      [/^request-body:/],
    ],
    [
      // requestOffSpec asserts the BODY is deliberately off-schema, which presumes a body exists.
      "the tag exempts only the schema check; a missing required body still violates",
      req({
        ...labelCreate,
        status: 422,
        responseBody: { message: "Validation Failed" },
        requestOffSpec: true,
      }),
      [/^request-body: .*required/],
    ],
    [
      "a request body missing a required field IS a violation (presence enforced)",
      req({ ...labelCreate, status: 201, body: { color: "d73a4a" } }), // no name
      [/^request-body:/],
    ],
    [
      "a PRIMITIVE request body where an object is documented IS a violation",
      req({ ...labelCreate, status: 201, body: "just a string" }),
      [/^request-body:/],
    ],
    [
      "a required request body sent as none IS a violation",
      req({ ...labelCreate, status: 201 }),
      [/^request-body: .*required/],
    ],
    [
      "a JSON body sent to an op that documents NO request body IS a violation",
      req({ ...labelDelete, status: 204, body: { unexpected: true } }),
      [/^request-body: .*no request body/],
    ],
  ])("%s", (_label, request, expected) => {
    expectFindings(v.validateRequest(request).map(line), expected);
  });

  // Response bodies drop `required` (presence relaxed); the spec documents its success statuses
  // and omits most error statuses, so only an undocumented 2xx/3xx is drift.
  test.each<[label: string, request: LoggedRequest, expected: RegExp[]]>([
    [
      "a body on a documented no-content (204) success response IS a violation",
      req({ ...labelDelete, status: 204, responseBody: { message: "deleted" } }),
      [/^response-body: .*no response content/],
    ],
    [
      "a null body on a 204 is fine (the correct empty response)",
      req({ ...labelDelete, status: 204, responseBody: null }),
      [],
    ],
    [
      "a RESPONSE body merely missing a documented field is NOT a violation (presence relaxed)",
      req({
        ...labelCreate,
        status: 201,
        body: { name: "bug" },
        responseBody: { name: "bug", color: "d73a4a" },
      }),
      [],
    ],
    [
      // PUT environments answers 200 even on create (the spec lists 200/422), so a 201 is real drift.
      "an undocumented 2xx status IS a response-body violation",
      req({
        ...environment,
        method: "PUT",
        status: 201,
        body: { wait_timer: 5 },
        responseBody: { id: 1, name: "production" },
      }),
      [/^response-body: .*201/],
    ],
    [
      "an undocumented 2xx status with NO body is still a violation",
      req({ ...environment, method: "PUT", status: 201 }),
      [/^response-body: .*201/],
    ],
    [
      // GET environments documents only 200; the mock's absent-probe 404 is realistic GitHub behavior.
      "an undocumented status >= 400 is accepted silently (spec omits most errors)",
      req({ ...environment, status: 404, responseBody: { message: "Not Found" } }),
      [],
    ],
    [
      "a documented status is still validated: GET environments 200 passes",
      req({ ...environment, status: 200, responseBody: { id: 1, name: "production" } }),
      [],
    ],
    [
      "a primitive response body where an object is documented IS a violation",
      req({ method: "GET", pathname: "/repos/e2e-owner/e2e-repo", status: 200, responseBody: 42 }),
      [/^response-body:/],
    ],
  ])("%s", (_label, request, expected) => {
    expectFindings(v.validateRequest(request).map(line), expected);
  });

  // The harness's own shapes are excluded entirely: the spec never documents them.
  test.each<[label: string, request: LoggedRequest]>([
    [
      // A raw-media fetch: the text body is not the documented JSON array, and the tag skips it.
      "an offSpec response (raw media / synthetic fault)",
      req({
        method: "GET",
        pathname: "/repos/e2e-owner/e2e-repo/labels",
        status: 200,
        responseBody: "raw text",
        offSpec: true,
      }),
    ],
    [
      "a non-HTTP status sentinel (0, connection drop)",
      req({ method: "GET", pathname: "/repos/e2e-owner/e2e-repo/labels", status: 0 }),
    ],
    [
      "a denied request (deniedBy set)",
      req({
        ...labelCreate,
        status: 403,
        deniedBy: "issues",
        responseBody: { message: "Resource not accessible by personal access token" },
      }),
    ],
  ])("%s is excluded from validation", (_label, request) => {
    expect(v.validateRequest(request)).toEqual([]);
  });

  test("validateLog flattens violations across many requests", () => {
    const log: LoggedRequest[] = [
      req({ method: "GET", pathname: "/repos/e2e-owner/e2e-repo", status: 200 }),
      req({ method: "GET", pathname: "/totally/unknown", status: 200 }),
    ];
    const violations = v.validateLog(log);
    expect(violations.some((x) => x.kind === "unknown-route")).toBe(true);
  });
});

describe("the descriptor slice", () => {
  const doc = {
    paths: {
      "/repos/{owner}/{repo}": { get: {} },
      "/repos/{owner}/{repo}/labels": { get: {}, post: {} },
      "/repos/{owner}/{repo}/lfs": { put: {} },
    },
  };

  test.each<[string, string[], string[], RegExp]>([
    [
      "a used path the descriptor lacks",
      ["/repos/{owner}/{repo}", "/repos/{owner}/{repo}/topics"],
      [],
      /not in the @octokit\/openapi descriptor:\n {2}\/repos\/\{owner\}\/\{repo\}\/topics\n/,
    ],
    [
      "an undocumented path the descriptor now documents",
      ["/repos/{owner}/{repo}"],
      ["/repos/{owner}/{repo}/lfs"],
      /now documents: \/repos\/\{owner\}\/\{repo\}\/lfs\. Retire the owning gap/,
    ],
  ])("%s fails the load by name", (_, used, undocumented, message) => {
    expect(() => trimDescriptor(doc, used, undocumented)).toThrow(message);
  });

  test("a $ref left in the kept slice fails the load; one on a path outside the slice is cut away with it", () => {
    const withRef = {
      paths: {
        ...doc.paths,
        "/user/repos": { get: { parameters: [{ $ref: "#/components/parameters/per-page" }] } },
      },
    };
    expect(() => trimDescriptor(withRef, ["/user/repos"], [])).toThrow(
      /still contains \$ref pointers \(e\.g\. #\/components\/parameters\/per-page\)/,
    );
    expect(Object.keys(trimDescriptor(withRef, ["/repos/{owner}/{repo}"], []).paths)).toEqual([
      "/repos/{owner}/{repo}",
    ]);
  });
});

describe("validateExchange adapter", () => {
  const repoGet = req({ method: "GET", pathname: "/repos/e2e-owner/e2e-repo", status: 200 });
  const labelCreate = req({
    method: "POST",
    pathname: "/repos/e2e-owner/e2e-repo/labels",
    status: 201,
  });

  test.each<[label: string, args: Parameters<typeof validateExchange>, errors: string[]]>([
    [
      "returns string errors for a wrong-shaped response",
      [repoGet, 42], // scalar where the repo object is documented
      ["GET /repos/e2e-owner/e2e-repo [response-body]: (root) must be object"],
    ],
    [
      // The schema requires `name`, so sending only the misspelled `colour` trips required.
      "returns errors for a misspelled request field",
      [{ ...labelCreate, body: { colour: "d73a4a" } }, { id: 1 }],
      [
        "POST /repos/e2e-owner/e2e-repo/labels [request-body]: (root) must have required property 'name'",
      ],
    ],
    [
      "returns no errors for a valid exchange",
      [
        { ...labelCreate, body: { name: "bug", color: "d73a4a" } },
        { name: "bug", color: "d73a4a" },
      ],
      [],
    ],
    [
      "omitting responseBody falls back to the request's own field",
      [{ ...repoGet, responseBody: 42 }],
      ["GET /repos/e2e-owner/e2e-repo [response-body]: (root) must be object"],
    ],
  ])("%s", (_label, args, errors) => {
    expect(validateExchange(...args)).toEqual(errors);
  });

  test("an explicit null responseBody OVERRIDES the request's own field, not falls through", () => {
    // The log carries a stale non-null responseBody; with `??` the explicit null would fall through
    // to it and wrongly flag a no-content violation.
    const errors = validateExchange(
      {
        method: "DELETE",
        pathname: "/repos/e2e-owner/e2e-repo/labels/bug",
        query: "",
        status: 204,
        responseBody: { message: "stale" },
      },
      null,
    );
    expect(errors).toEqual([]);
  });
});

describe("mock rule-type catalog lockstep", () => {
  test("RULESET_RULE_TYPES matches the spec's rules[].type values exactly", async () => {
    // The mock catalog answers GitHub's real 422 for a typo'd rules[].type while the validator checks
    // accepted bodies against the SPEC's enums. Drift either falsely 422s a real new type or lets
    // the mock accept a type the validator flags; pinned equal, a spec refresh is the one update point.
    const { RULESET_RULE_TYPES } = await import("../mock/support.js");
    const { paths } = loadSpec();
    const operations = [
      at(paths, "/repos/{owner}/{repo}/rulesets", "post"),
      at(paths, "/repos/{owner}/{repo}/rulesets/{ruleset_id}", "put"),
    ];
    for (const operation of operations) {
      const body = at(operation, "requestBody", "content", "application/json", "schema");
      const items = at(body, "properties", "rules", "items");
      // Only TOP-LEVEL variants count: rule parameters nest their own `type` enums (actor kinds and
      // the like) that a deep walk would wrongly collect.
      const variants = (items.oneOf ?? items.anyOf ?? []) as Array<Record<string, unknown>>;
      const specTypes = new Set<string>();
      for (const variant of variants) {
        const type = (variant.properties as Record<string, unknown> | undefined)?.type as
          | { enum?: unknown[]; const?: unknown }
          | undefined;
        for (const value of type?.enum ?? (type?.const !== undefined ? [type.const] : [])) {
          if (typeof value === "string") {
            specTypes.add(value);
          }
        }
      }
      expect(specTypes.size).toBeGreaterThan(0);
      expect([...RULESET_RULE_TYPES].sort()).toEqual([...specTypes].sort());
    }
  });
});

describe("invitation role vocabulary lockstep", () => {
  test("INVITATION_ROLES matches the spec's repository-invitation permissions enum exactly", async () => {
    // The collaborators handler gates PATCH-vs-note on this set and the mock clamps stored invitation
    // permissions into it, so a spec refresh that moves the enum must land here too.
    const { INVITATION_ROLES } = await import("../../../src/sections/shared/roles.js");
    const { paths } = loadSpec();
    const listed = at(paths, "/repos/{owner}/{repo}/invitations", "get", "responses", "200");
    const getEnum = at(listed, "content", "application/json", "schema", "items", "properties")
      .permissions as { enum: string[] };
    const patch = at(paths, "/repos/{owner}/{repo}/invitations/{invitation_id}", "patch");
    const patchEnum = at(
      patch,
      "requestBody",
      "content",
      "application/json",
      "schema",
      "properties",
    ).permissions as { enum: string[] };
    for (const specEnum of [getEnum.enum, patchEnum.enum]) {
      expect(specEnum.length).toBeGreaterThan(0);
      expect([...INVITATION_ROLES].sort()).toEqual([...specEnum].sort());
    }
  });
});

describe("the hand-written /graphql branch", () => {
  // An empty spec plus an injected known-name set: the branch never consults OpenAPI paths.
  const validator = new OpenApiValidator({ paths: {} } as never, new Set(["RepoToggles"]));

  const goodBody = {
    query: "query RepoToggles($owner: String!, $repo: String!) { repository { id } }",
    operationName: "RepoToggles",
    variables: { owner: "o", repo: "r" },
  };

  const exchange = (overrides: Partial<LoggedRequest>): LoggedRequest =>
    req({
      method: "POST",
      pathname: "/graphql",
      body: goodBody,
      status: 200,
      responseBody: { data: { repository: { id: "R_1" } } },
      ...overrides,
    });

  test.each<[label: string, overrides: Partial<LoggedRequest>, expected: RegExp[]]>([
    ["a well-formed exchange passes", {}, []],
    [
      "a data:null + typed errors response passes",
      { responseBody: { data: null, errors: [{ type: "NOT_FOUND", message: "gone" }] } },
      [],
    ],
    ["a non-POST method is an unknown-route finding", { method: "GET" }, [/^unknown-route:/]],
    [
      "missing query/operationName/variables are request-body findings",
      { body: { operationName: 7 } },
      [
        /^request-body: the request body must carry a string `query`/,
        /^request-body: the request body must carry a string `operationName`/,
        /^request-body: the request body must carry a `variables` object/,
      ],
    ],
    [
      "an undeclared operationName is a request-body finding",
      { body: { ...goodBody, operationName: "Rogue" } },
      [/operationName "Rogue" names no declared GraphQL operation/],
    ],
    [
      "a non-200 status is a response-body finding",
      { status: 502, responseBody: null },
      [/GraphQL responses are HTTP 200/],
    ],
    [
      "a data value that is neither object nor null is a finding",
      { responseBody: { data: 42 } },
      [/the response `data` must be an object or null/],
    ],
    [
      "an unknown errors[].type and a missing message are findings",
      { responseBody: { data: null, errors: [{ type: "SERVICE_UNAVAILABLE" }] } },
      [
        /errors\[\]\.type "SERVICE_UNAVAILABLE" is not a known GraphQL error type/,
        /every errors\[\] entry must carry a string message/,
      ],
    ],
    [
      "an empty errors array is a finding (present means non-empty)",
      { responseBody: { data: null, errors: [] } },
      [/must be a non-empty array/],
    ],
    [
      "a denied exchange is excluded like every other route",
      { deniedBy: "administration", responseBody: undefined },
      [],
    ],
    [
      "an off-spec exchange is excluded like every other route",
      { offSpec: true, responseBody: { data: 42 } },
      [],
    ],
  ])("%s", (_label, overrides, expected) => {
    expectFindings(validator.validateRequest(exchange(overrides)).map(line), expected);
  });
});
