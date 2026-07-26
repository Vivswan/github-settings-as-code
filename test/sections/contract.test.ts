import { describe, expect, test } from "bun:test";
import { PermissionDenied, type SectionMeta, throwFor } from "../../src/sections/contract.js";
import { rulesetsSection } from "../../src/sections/rulesets.js";

const section: SectionMeta = rulesetsSection;

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
        { hints: { 422: "Usually this means a typo" } },
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
        { hints: { 422: "never rendered on a 409" } },
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
        { operation: 'creating ruleset "quality"', hints: { 422: "never rendered here" } },
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

  test("rate-limit and 5xx branches do not render the hint", () => {
    expect(() =>
      throwFor(
        section,
        "GET",
        "/repos/o/r/rulesets",
        { status: 500, message: "Server Error", body: "" },
        { hints: { 500: "never rendered here" } },
      ),
    ).toThrow(/server error/);
    try {
      throwFor(
        section,
        "GET",
        "/repos/o/r/rulesets",
        { status: 500, message: "Server Error", body: "" },
        { hints: { 500: "never rendered here" } },
      );
    } catch (error) {
      expect(String(error)).not.toContain("never rendered here");
    }
  });
});
