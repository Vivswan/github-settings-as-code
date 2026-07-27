import { describe, expect, test } from "bun:test";
import { actionsSection } from "../../src/sections/actions.js";
import {
  type EndpointDecl,
  grantFor,
  PermissionDenied,
  type SectionMeta,
  throwFor,
} from "../../src/sections/contract.js";
import { rulesetsSection } from "../../src/sections/rulesets.js";

const section: SectionMeta = rulesetsSection;

/** A synthetic declaration carrying just the context fields under test. */
function endpoint(extra: Partial<EndpointDecl>): EndpointDecl {
  return { route: "POST /repos/{owner}/{repo}/rulesets", statuses: { 201: "created" }, ...extra };
}

describe("throwFor context enrichment", () => {
  const rejection = {
    status: 422,
    message: 'Validation Failed ([{"field":"rules","message":"Invalid rule"}])',
    body: "",
  };

  test("generic rejection without context keeps the classic shape", () => {
    expect(() => throwFor(section, "POST", "/repos/o/r/rulesets", rejection)).toThrow(
      /rulesets: POST \/repos\/o\/r\/rulesets: 422 .*fix the "rulesets" values/,
    );
  });

  test("operation label prefixes the cause", () => {
    expect(() =>
      throwFor(section, "POST", "/repos/o/r/rulesets", rejection, {
        operation: 'creating ruleset "quality"',
      }),
    ).toThrow(/creating ruleset "quality" failed - POST \/repos\/o\/r\/rulesets: 422/);
  });

  test("the status-matched hint and documentation_url are appended to the generic branch", () => {
    expect(() =>
      throwFor(
        section,
        "POST",
        "/repos/o/r/rulesets",
        { ...rejection, documentationUrl: "https://docs.github.com/rest/repos/rules" },
        { endpoint: endpoint({ hints: { 422: "Usually this means a typo" } }) },
      ),
    ).toThrow(
      /message above\. Usually this means a typo\. The fields and values this endpoint accepts are documented at https:\/\/docs\.github\.com\/rest\/repos\/rules$/,
    );
  });

  test("a hint keyed to a different status is not rendered", () => {
    try {
      throwFor(
        section,
        "POST",
        "/repos/o/r/rulesets",
        { status: 409, message: "Conflict", body: "" },
        { endpoint: endpoint({ hints: { 422: "never rendered on a 409" } }) },
      );
    } catch (error) {
      expect(String(error)).toContain("409");
      expect(String(error)).not.toContain("never rendered on a 409");
    }
  });

  test("permission errors keep the grant advice and gain the operation label", () => {
    let thrown: unknown;
    try {
      throwFor(
        section,
        "POST",
        "/repos/o/r/rulesets",
        { status: 403, message: "Resource not accessible", body: "" },
        {
          operation: 'creating ruleset "quality"',
          endpoint: endpoint({ hints: { 422: "never rendered here" } }),
        },
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(PermissionDenied);
    const denied = thrown as PermissionDenied;
    expect(denied.detail).toContain('creating ruleset "quality" failed - POST');
    expect(denied.detail).toContain(section.grant);
    expect(denied.detail).not.toContain("never rendered here");
  });

  test("denialHint is appended to the permission branch, and only there", () => {
    let thrown: unknown;
    try {
      throwFor(
        section,
        "PUT",
        "/repos/o/r/lfs",
        { status: 403, message: "Git LFS is globally disabled", body: "" },
        {
          endpoint: endpoint({
            denialHint: "a 403 here can also mean LFS is disabled account-wide",
          }),
        },
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(PermissionDenied);
    const denied = thrown as PermissionDenied;
    expect(denied.detail).toContain(section.grant);
    expect(denied.detail).toContain(
      ". Note: a 403 here can also mean LFS is disabled account-wide",
    );
    // The generic branch never renders it.
    expect(() =>
      throwFor(
        section,
        "PUT",
        "/repos/o/r/lfs",
        { status: 422, message: "nope", body: "" },
        { endpoint: endpoint({ denialHint: "not for 422s" }) },
      ),
    ).toThrow(/^(?!.*not for 422s).*fix the "rulesets" values/);
  });

  test("rate-limit and 5xx branches do not render the hint", () => {
    expect(() =>
      throwFor(
        section,
        "GET",
        "/repos/o/r/rulesets",
        { status: 500, message: "Server Error", body: "" },
        { endpoint: endpoint({ hints: { 500: "never rendered here" } }) },
      ),
    ).toThrow(/server error/);
    try {
      throwFor(
        section,
        "GET",
        "/repos/o/r/rulesets",
        { status: 500, message: "Server Error", body: "" },
        { endpoint: endpoint({ hints: { 500: "never rendered here" } }) },
      );
    } catch (error) {
      expect(String(error)).not.toContain("never rendered here");
    }
  });

  test("a permission override renders the endpoint's own grant, not the section's", () => {
    let thrown: unknown;
    try {
      throwFor(
        section,
        "GET",
        "/repos/o/r/actions/oidc/customization/sub",
        { status: 403, message: "Resource not accessible", body: "" },
        { endpoint: endpoint({ permission: { repo: ["actions"] } }) },
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(PermissionDenied);
    const denied = thrown as PermissionDenied;
    expect(denied.detail).toContain(grantFor({ repo: ["actions"] }));
    expect(denied.detail).not.toContain(section.grant);
  });

  test('a public endpoint ("none") cannot be a missing-grant failure', () => {
    // A denied PUBLIC endpoint is by definition not about the token's
    // grants, so the 403 takes the generic branch instead of rendering
    // grant advice that cannot help.
    let thrown: unknown;
    try {
      throwFor(
        section,
        "GET",
        "/repos/o/r/rulesets",
        { status: 403, message: "Forbidden", body: "" },
        { endpoint: endpoint({ permission: "none" }) },
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).not.toBeInstanceOf(PermissionDenied);
    expect(String(thrown)).toContain('fix the "rulesets" values');
  });

  test("a no-override denial keeps the section grant's caveat", () => {
    // section.grant and grantFor(effective) coincide for a caveat-free
    // section, so only a caveat-bearing one can pin the difference: the
    // no-override path must render section.grant (caveat included), and a
    // refactor that re-derives the grant from the resolved permission
    // would silently drop every caveat while caveat-free fixtures stay
    // green.
    let thrown: unknown;
    try {
      throwFor(
        actionsSection,
        "GET",
        "/repos/o/r/actions/permissions",
        { status: 403, message: "Resource not accessible", body: "" },
        {
          endpoint: {
            route: "GET /repos/{owner}/{repo}/actions/permissions",
            statuses: { 200: "x" },
          },
        },
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(PermissionDenied);
    const denied = thrown as PermissionDenied;
    expect(denied.detail).toContain(
      'the "oidc_customization_sub" key alone instead needs "Actions"',
    );
  });
});
