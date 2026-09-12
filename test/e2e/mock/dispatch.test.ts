import { describe, expect, test } from "bun:test";
import { matchEndpoint, paramAccessor } from "./dispatch.js";
import { handlerTestContext } from "./handler-test-ctx.js";
import { buildState } from "./state.js";

/** An undeclared token must throw whatever its name, including names every object inherits. */
const INHERITED_NAMES = ["toString", "constructor", "hasOwnProperty", "__proto__", "valueOf"];

describe("path params are own keys of the matched route", () => {
  const matched = matchEndpoint("GET", "/repos/acme/widgets/labels");
  if (matched === null) {
    throw new Error("GET /repos/{owner}/{repo}/labels matched no declared endpoint");
  }
  const param = paramAccessor(matched.key, matched.endpoint, matched.params);

  test("the declared tokens resolve to the decoded segments", () => {
    expect(matched.params).toEqual({ owner: "acme", repo: "widgets" });
    expect([param("owner"), param("repo")]).toEqual(["acme", "widgets"]);
  });

  test.each(INHERITED_NAMES)("pipeline accessor throws the BUG for %s", (name) => {
    expect(() => param(name)).toThrow(/E2E MOCK BUG: handler ".*" asked for path param/);
  });

  test.each(INHERITED_NAMES)("handler test context throws for %s", (name) => {
    const ctx = handlerTestContext("labels.list", buildState(undefined, "org"), {
      params: { owner: "acme", repo: "widgets" },
    });
    expect(ctx.param("owner")).toBe("acme");
    expect(() => ctx.param(name)).toThrow(/handlerTestContext: no ".*" param supplied/);
  });
});
