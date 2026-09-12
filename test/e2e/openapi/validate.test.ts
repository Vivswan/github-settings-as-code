import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { endpointMethod, endpointPath } from "../../../src/sections/contract/endpoints.js";
import { allEndpoints } from "../../../src/sections/registry.js";
import type { LoggedRequest } from "../mock/contract.js";
import { excludeUndocumented, USED_PATHS } from "./paths.js";
import {
  OpenApiValidator,
  pathMatches,
  sharedValidator,
  toJsonSchema,
  validateExchange,
} from "./validate.js";

function req(overrides: Partial<LoggedRequest>): LoggedRequest {
  return { method: "GET", pathname: "/", query: "", status: 200, ...overrides };
}

describe("toJsonSchema", () => {
  test("folds nullable:true into a type array", () => {
    expect(toJsonSchema({ type: "string", nullable: true })).toEqual({ type: ["string", "null"] });
  });

  test("appends null to an existing type array without duplicating", () => {
    expect(toJsonSchema({ type: ["string", "number"], nullable: true })).toEqual({
      type: ["string", "number", "null"],
    });
    expect(toJsonSchema({ type: ["string", "null"], nullable: true })).toEqual({
      type: ["string", "null"],
    });
  });

  test("a nullable enum gains null (the code-quality runner_type shape)", () => {
    expect(toJsonSchema({ type: "string", nullable: true, enum: ["standard", "labeled"] })).toEqual(
      { type: ["string", "null"], enum: ["standard", "labeled", null] },
    );
    expect(toJsonSchema({ type: "string", nullable: true, enum: ["weekly", null] })).toEqual({
      type: ["string", "null"],
      enum: ["weekly", null],
    });
    expect(toJsonSchema({ type: "string", enum: ["standard"] })).toEqual({
      type: "string",
      enum: ["standard"],
    });
  });

  test("nullable without a type is dropped, not turned into a bare null type", () => {
    // ajv treats a type-less schema as accept-anything, the safe reading.
    expect(toJsonSchema({ nullable: true, description: "x" })).toEqual({ description: "x" });
  });

  test("nullable beside a bare oneOf gains a null branch (the custom property value shape)", () => {
    // GitHub's custom-property `value` schema is `oneOf [string, string[]]` with nullable: true and
    // NO sibling type; a null value must validate.
    const input = {
      nullable: true,
      oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
    };
    expect(toJsonSchema(input, true)).toEqual({
      oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }, { type: "null" }],
    });
    expect(toJsonSchema(input)).toEqual({
      anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }, { type: "null" }],
    });
  });

  test("strips required from a response schema (presence relaxed) by default", () => {
    expect(
      toJsonSchema({ type: "object", required: ["id"], properties: { id: { type: "integer" } } }),
    ).toEqual({
      type: "object",
      properties: { id: { type: "integer" } },
    });
  });

  test("keeps required when keepRequired is set (request-body variant)", () => {
    expect(
      toJsonSchema(
        { type: "object", required: ["id"], properties: { id: { type: "integer" } } },
        true,
      ),
    ).toEqual({
      type: "object",
      required: ["id"],
      properties: { id: { type: "integer" } },
    });
  });

  test("strips annotation-only keywords ajv would choke on", () => {
    const input = {
      type: "object",
      example: { a: 1 },
      examples: [1, 2],
      xml: { name: "thing" },
      discriminator: { propertyName: "kind" },
      properties: { a: { type: "integer", example: 5 } },
    };
    expect(toJsonSchema(input)).toEqual({
      type: "object",
      properties: { a: { type: "integer" } },
    });
  });

  test("recurses through arrays and nested objects", () => {
    const input = {
      allOf: [
        { type: "string", nullable: true },
        { type: "object", example: {} },
      ],
    };
    expect(toJsonSchema(input)).toEqual({
      allOf: [{ type: ["string", "null"] }, { type: "object" }],
    });
  });

  test("leaves primitives untouched", () => {
    expect(toJsonSchema("s")).toBe("s");
    expect(toJsonSchema(3)).toBe(3);
    expect(toJsonSchema(null)).toBe(null);
  });

  test("relaxed variant rewrites oneOf to anyOf (widened branches may overlap)", () => {
    const input = {
      oneOf: [
        { type: "object", required: ["a"], properties: { a: { type: "string" } } },
        { type: "object", required: ["b"], properties: { b: { type: "string" } } },
      ],
    };
    expect(toJsonSchema(input)).toEqual({
      anyOf: [
        { type: "object", properties: { a: { type: "string" } } },
        { type: "object", properties: { b: { type: "string" } } },
      ],
    });
    expect(toJsonSchema(input, true)).toEqual(input);
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
  test("the declared LFS methods are exempt from unknown-route", () => {
    expect(
      validateExchange(req({ method: "PUT", pathname: "/repos/o/r/lfs", status: 202 })),
    ).toEqual([]);
    expect(
      validateExchange(req({ method: "DELETE", pathname: "/repos/o/r/lfs", status: 204 })),
    ).toEqual([]);
  });

  test("an unlisted method on the same path is still an unknown route", () => {
    const violations = validateExchange(
      req({ method: "GET", pathname: "/repos/o/r/lfs", status: 200, responseBody: {} }),
    );
    expect(violations.some((v) => v.includes("unknown-route"))).toBe(true);
  });

  test("a near-miss path is still an unknown route", () => {
    const violations = validateExchange(req({ method: "PUT", pathname: "/repos/o/r/lsf" }));
    expect(violations.some((v) => v.includes("unknown-route"))).toBe(true);
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

  test("{path} absorbs a multi-segment file path", () => {
    expect(pathMatches(contents, "/repos/o/r/contents/.github/settings.yml")).toBe(true);
    expect(pathMatches(contents, "/repos/o/r/contents/README.md")).toBe(true);
  });

  test("{ref} absorbs a fully qualified ref", () => {
    expect(pathMatches(gitRef, "/repos/o/r/git/ref/heads/main")).toBe(true);
    expect(pathMatches(gitRef, "/repos/o/r/git/ref/heads/release/1.x")).toBe(true);
    expect(pathMatches(gitRef, "/repos/o/r/git/ref")).toBe(false);
  });

  test("{path} requires at least one trailing segment", () => {
    expect(pathMatches(contents, "/repos/o/r/contents")).toBe(false);
  });

  test("a non-contents template still matches one segment per param", () => {
    expect(pathMatches("/repos/{owner}/{repo}/labels/{name}", "/repos/o/r/labels/bug")).toBe(true);
    expect(pathMatches("/repos/{owner}/{repo}/labels/{name}", "/repos/o/r/labels/bug/extra")).toBe(
      false,
    );
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
    const spec = JSON.parse(
      readFileSync(new URL("./github-openapi.trimmed.json", import.meta.url), "utf8"),
    ) as {
      paths?: Record<
        string,
        Record<string, { parameters?: unknown[] }> & { parameters?: unknown[] }
      >;
    };
    // trim-openapi.ts rejects any surviving $ref, so parameters are inline objects.
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

  test("a path the spec does not document is an unknown-route violation", () => {
    const violations = v.validateRequest(
      req({
        method: "GET",
        pathname: "/repos/e2e-owner/e2e-repo/not-a-real-endpoint",
        status: 200,
      }),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.kind).toBe("unknown-route");
  });

  test("a method the spec does not document on a known path is a violation", () => {
    // DELETE /repos/{owner}/{repo}/labels is not a documented operation.
    const violations = v.validateRequest(
      req({ method: "DELETE", pathname: "/repos/e2e-owner/e2e-repo/labels", status: 204 }),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.kind).toBe("unknown-route");
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

  test("a body with a wrong-typed field is a request-body violation", () => {
    const violations = v.validateRequest(
      req({
        method: "POST",
        pathname: "/repos/e2e-owner/e2e-repo/labels",
        status: 201,
        body: { name: "bug", color: 123 },
      }),
    );
    expect(violations.some((x) => x.kind === "request-body")).toBe(true);
  });

  test("an off-schema body the mock REJECTED as requestOffSpec skips only the body check", () => {
    // Settings pass through verbatim, so a user typo the request schema forbids reaching the API
    // and being 422'd is modeled behavior (the rulesets-invalid-rule-type scenario).
    const violations = v.validateRequest(
      req({
        method: "POST",
        pathname: "/repos/e2e-owner/e2e-repo/labels",
        status: 422,
        body: { name: "bug", color: 123 },
        responseBody: { message: "Validation Failed" },
        requestOffSpec: true,
      }),
    );
    expect(violations.some((x) => x.kind === "request-body")).toBe(false);
  });

  test("an off-schema body on an UNTAGGED 4xx is still a request-body violation", () => {
    const violations = v.validateRequest(
      req({
        method: "POST",
        pathname: "/repos/e2e-owner/e2e-repo/labels",
        status: 422,
        body: { name: "bug", color: 123 },
        responseBody: { message: "Validation Failed" },
      }),
    );
    expect(violations.some((x) => x.kind === "request-body")).toBe(true);
  });

  test("the tag exempts only the schema check; a missing required body still violates", () => {
    // requestOffSpec asserts the BODY is deliberately off-schema, which presumes a body exists.
    const violations = v.validateRequest(
      req({
        method: "POST",
        pathname: "/repos/e2e-owner/e2e-repo/labels",
        status: 422,
        responseBody: { message: "Validation Failed" },
        requestOffSpec: true,
      }),
    );
    expect(violations.some((x) => x.kind === "request-body" && x.detail.includes("required"))).toBe(
      true,
    );
  });

  test("a request body missing a required field IS a violation (presence enforced)", () => {
    const violations = v.validateRequest(
      req({
        method: "POST",
        pathname: "/repos/e2e-owner/e2e-repo/labels",
        status: 201,
        body: { color: "d73a4a" }, // no name
      }),
    );
    expect(violations.some((x) => x.kind === "request-body")).toBe(true);
  });

  test("a PRIMITIVE request body where an object is documented IS a violation", () => {
    const violations = v.validateRequest(
      req({
        method: "POST",
        pathname: "/repos/e2e-owner/e2e-repo/labels",
        status: 201,
        body: "just a string",
      }),
    );
    expect(violations.some((x) => x.kind === "request-body")).toBe(true);
  });

  test("a required request body sent as none IS a violation", () => {
    const violations = v.validateRequest(
      req({ method: "POST", pathname: "/repos/e2e-owner/e2e-repo/labels", status: 201 }),
    );
    expect(violations.some((x) => x.kind === "request-body" && x.detail.includes("required"))).toBe(
      true,
    );
  });

  test("a JSON body sent to an op that documents NO request body IS a violation", () => {
    const violations = v.validateRequest(
      req({
        method: "DELETE",
        pathname: "/repos/e2e-owner/e2e-repo/labels/bug",
        status: 204,
        body: { unexpected: true },
      }),
    );
    expect(
      violations.some((x) => x.kind === "request-body" && x.detail.includes("no request body")),
    ).toBe(true);
  });

  test("a body on a documented no-content (204) success response IS a violation", () => {
    const violations = v.validateRequest(
      req({
        method: "DELETE",
        pathname: "/repos/e2e-owner/e2e-repo/labels/bug",
        status: 204,
        responseBody: { message: "deleted" },
      }),
    );
    expect(
      violations.some(
        (x) => x.kind === "response-body" && x.detail.includes("no response content"),
      ),
    ).toBe(true);
  });

  test("a null body on a 204 is fine (the correct empty response)", () => {
    const violations = v.validateRequest(
      req({
        method: "DELETE",
        pathname: "/repos/e2e-owner/e2e-repo/labels/bug",
        status: 204,
        responseBody: null,
      }),
    );
    expect(violations).toEqual([]);
  });

  test("a RESPONSE body merely missing a documented field is NOT a violation (presence relaxed)", () => {
    const violations = v.validateRequest(
      req({
        method: "POST",
        pathname: "/repos/e2e-owner/e2e-repo/labels",
        status: 201,
        body: { name: "bug" },
        responseBody: { name: "bug", color: "d73a4a" },
      }),
    );
    expect(violations).toEqual([]);
  });

  test("an undocumented 2xx status IS a response-body violation", () => {
    // PUT environments answers 200 even on create (the spec lists 200/422), so a 201 is real drift.
    const violations = v.validateRequest(
      req({
        method: "PUT",
        pathname: "/repos/e2e-owner/e2e-repo/environments/production",
        status: 201,
        body: { wait_timer: 5 },
        responseBody: { id: 1, name: "production" },
      }),
    );
    expect(violations.some((x) => x.kind === "response-body" && x.detail.includes("201"))).toBe(
      true,
    );
  });

  test("an undocumented 2xx status with NO body is still a violation", () => {
    const violations = v.validateRequest(
      req({
        method: "PUT",
        pathname: "/repos/e2e-owner/e2e-repo/environments/production",
        status: 201,
      }),
    );
    expect(violations.some((x) => x.kind === "response-body" && x.detail.includes("201"))).toBe(
      true,
    );
  });

  test("an undocumented status >= 400 is accepted silently (spec omits most errors)", () => {
    // GET environments documents only 200; the mock's absent-probe 404 is realistic GitHub behavior.
    const violations = v.validateRequest(
      req({
        method: "GET",
        pathname: "/repos/e2e-owner/e2e-repo/environments/production",
        status: 404,
        responseBody: { message: "Not Found" },
      }),
    );
    expect(violations).toEqual([]);
  });

  test("a documented status is still validated: GET environments 200 passes", () => {
    const violations = v.validateRequest(
      req({
        method: "GET",
        pathname: "/repos/e2e-owner/e2e-repo/environments/production",
        status: 200,
        responseBody: { id: 1, name: "production" },
      }),
    );
    expect(violations).toEqual([]);
  });

  test("a primitive response body where an object is documented IS a violation", () => {
    const violations = v.validateRequest(
      req({ method: "GET", pathname: "/repos/e2e-owner/e2e-repo", status: 200, responseBody: 42 }),
    );
    expect(violations.some((x) => x.kind === "response-body")).toBe(true);
  });

  test("an offSpec response (raw media / synthetic fault) is excluded entirely", () => {
    // A rate-limit 403 fault: the status is undocumented AND the body is off-spec; both are skipped.
    const violations = v.validateRequest(
      req({
        method: "GET",
        pathname: "/repos/e2e-owner/e2e-repo/labels",
        status: 403,
        offSpec: true,
      }),
    );
    expect(violations).toEqual([]);
  });

  test("a non-HTTP status sentinel (0, connection drop) is excluded", () => {
    const violations = v.validateRequest(
      req({ method: "GET", pathname: "/repos/e2e-owner/e2e-repo/labels", status: 0 }),
    );
    expect(violations).toEqual([]);
  });

  test("a denied request (deniedBy set) is excluded from validation", () => {
    const violations = v.validateRequest(
      req({
        method: "POST",
        pathname: "/repos/e2e-owner/e2e-repo/labels",
        status: 403,
        deniedBy: "issues",
        responseBody: { message: "Resource not accessible by personal access token" },
      }),
    );
    expect(violations).toEqual([]);
  });

  test("a mock VIOLATION 400 is excluded from validation", () => {
    const violations = v.validateRequest(
      req({
        method: "GET",
        pathname: "/user/repos",
        status: 400,
        responseBody: { message: "E2E MOCK VIOLATION: something broke" },
      }),
    );
    expect(violations).toEqual([]);
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

describe("the fetched trimmed spec", () => {
  test("contains exactly the USED_PATHS paths (no more, no fewer)", () => {
    // Read through the loaded validator, not a static JSON import, so a missing spec surfaces the
    // actionable fetch error from load() rather than a module-resolution failure.
    const specPaths = [...sharedValidator().paths()].sort();
    expect(specPaths).toEqual([...USED_PATHS].sort());
  });

  test("a missing spec throws a loud, actionable fetch error naming the script", () => {
    expect(() => OpenApiValidator.loadFrom("/nonexistent/github-openapi.trimmed.json")).toThrow(
      /bun \.github\/scripts\/trim-openapi\.ts/,
    );
  });
});

describe("validateExchange adapter", () => {
  test("returns string errors for a wrong-shaped response", () => {
    const errors = validateExchange(
      { method: "GET", pathname: "/repos/e2e-owner/e2e-repo", query: "", status: 200 },
      42, // scalar where the repo object is documented
    );
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain("[response-body]");
  });

  test("returns errors for a misspelled request field", () => {
    // The schema requires `name`, so sending only the misspelled `colour` trips required.
    const errors = validateExchange(
      {
        method: "POST",
        pathname: "/repos/e2e-owner/e2e-repo/labels",
        query: "",
        status: 201,
        body: { colour: "d73a4a" },
      },
      { id: 1 },
    );
    expect(errors.some((e) => e.includes("[request-body]"))).toBe(true);
  });

  test("returns no errors for a valid exchange", () => {
    const errors = validateExchange(
      {
        method: "POST",
        pathname: "/repos/e2e-owner/e2e-repo/labels",
        query: "",
        status: 201,
        body: { name: "bug", color: "d73a4a" },
      },
      { name: "bug", color: "d73a4a" },
    );
    expect(errors).toEqual([]);
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

  test("omitting responseBody falls back to the request's own field", () => {
    const errors = validateExchange({
      method: "GET",
      pathname: "/repos/e2e-owner/e2e-repo",
      query: "",
      status: 200,
      responseBody: 42,
    });
    expect(errors.some((e) => e.includes("[response-body]"))).toBe(true);
  });

  test("passing explicit undefined behaves like omitting (falls back)", () => {
    const errors = validateExchange(
      {
        method: "GET",
        pathname: "/repos/e2e-owner/e2e-repo",
        query: "",
        status: 200,
        responseBody: 42,
      },
      undefined,
    );
    expect(errors.some((e) => e.includes("[response-body]"))).toBe(true);
  });
});

describe("mock rule-type catalog lockstep", () => {
  test("RULESET_RULE_TYPES matches the spec's rules[].type values exactly", async () => {
    // The mock catalog answers GitHub's real 422 for a typo'd rules[].type while the validator checks
    // accepted bodies against the SPEC's enums. Drift either falsely 422s a real new type or lets
    // the mock accept a type the validator flags; pinned equal, a spec refresh is the one update point.
    const { RULESET_RULE_TYPES } = await import("../mock/support.js");
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const spec = JSON.parse(
      readFileSync(join(import.meta.dir, "github-openapi.trimmed.json"), "utf8"),
    );
    const operations = [
      spec.paths["/repos/{owner}/{repo}/rulesets"].post,
      spec.paths["/repos/{owner}/{repo}/rulesets/{ruleset_id}"].put,
    ];
    for (const operation of operations) {
      const rules = operation.requestBody.content["application/json"].schema.properties.rules;
      // Only TOP-LEVEL variants count: rule parameters nest their own `type` enums (actor kinds and
      // the like) that a deep walk would wrongly collect.
      const variants = (rules.items.oneOf ?? rules.items.anyOf ?? []) as Array<
        Record<string, unknown>
      >;
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
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const spec = JSON.parse(
      readFileSync(join(import.meta.dir, "github-openapi.trimmed.json"), "utf8"),
    );
    const getEnum = spec.paths["/repos/{owner}/{repo}/invitations"].get.responses["200"].content[
      "application/json"
    ].schema.items.properties.permissions.enum as string[];
    const patchEnum = spec.paths["/repos/{owner}/{repo}/invitations/{invitation_id}"].patch
      .requestBody.content["application/json"].schema.properties.permissions.enum as string[];
    for (const specEnum of [getEnum, patchEnum]) {
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

  test("a well-formed exchange passes", () => {
    expect(validator.validateRequest(exchange({}))).toEqual([]);
  });

  test("a data:null + typed errors response passes", () => {
    expect(
      validator.validateRequest(
        exchange({
          responseBody: { data: null, errors: [{ type: "NOT_FOUND", message: "gone" }] },
        }),
      ),
    ).toEqual([]);
  });

  test("a non-POST method is an unknown-route finding", () => {
    const found = validator.validateRequest(exchange({ method: "GET" }));
    expect(found.map((f) => f.kind)).toContain("unknown-route");
  });

  test("missing query/operationName/variables are request-body findings", () => {
    const found = validator.validateRequest(exchange({ body: { operationName: 7 } }));
    const details = found.map((f) => `${f.kind}: ${f.detail}`).join("\n");
    expect(details).toContain("request-body: the request body must carry a string `query`");
    expect(details).toContain("request-body: the request body must carry a string `operationName`");
    expect(details).toContain("request-body: the request body must carry a `variables` object");
  });

  test("an undeclared operationName is a request-body finding", () => {
    const found = validator.validateRequest(
      exchange({ body: { ...goodBody, operationName: "Rogue" } }),
    );
    expect(found.map((f) => f.detail).join("\n")).toContain(
      'operationName "Rogue" names no declared GraphQL operation',
    );
  });

  test("a non-200 status is a response-body finding", () => {
    const found = validator.validateRequest(exchange({ status: 502, responseBody: null }));
    expect(found.map((f) => f.detail).join("\n")).toContain("GraphQL responses are HTTP 200");
  });

  test("a data value that is neither object nor null is a finding", () => {
    const found = validator.validateRequest(exchange({ responseBody: { data: 42 } }));
    expect(found.map((f) => f.detail).join("\n")).toContain(
      "the response `data` must be an object or null",
    );
  });

  test("an unknown errors[].type and a missing message are findings", () => {
    const found = validator.validateRequest(
      exchange({
        responseBody: { data: null, errors: [{ type: "SERVICE_UNAVAILABLE" }] },
      }),
    );
    const details = found.map((f) => f.detail).join("\n");
    expect(details).toContain(
      'errors[].type "SERVICE_UNAVAILABLE" is not a known GraphQL error type',
    );
    expect(details).toContain("every errors[] entry must carry a string message");
  });

  test("an empty errors array is a finding (present means non-empty)", () => {
    const found = validator.validateRequest(exchange({ responseBody: { data: null, errors: [] } }));
    expect(found.map((f) => f.detail).join("\n")).toContain("must be a non-empty array");
  });

  test("denied and off-spec exchanges are excluded like every other route", () => {
    expect(
      validator.validateRequest(exchange({ deniedBy: "administration", responseBody: undefined })),
    ).toEqual([]);
    expect(validator.validateRequest(exchange({ offSpec: true }))).toEqual([]);
  });
});
