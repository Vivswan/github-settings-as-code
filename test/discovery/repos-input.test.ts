import { describe, expect, test } from "bun:test";
import { err, ok } from "neverthrow";
import { parseReposInput } from "../../src/discovery/repos-input.js";

describe("parseReposInput", () => {
  test("splits on commas and newlines", () => {
    expect(parseReposInput("o/a, o/b\no/c")).toEqual(
      ok({ slugs: ["o/a", "o/b", "o/c"], discover: false }),
    );
  });

  test("* alone switches to discovery", () => {
    expect(parseReposInput("*")).toEqual(ok({ slugs: [], discover: true }));
  });

  test("* mixed with slugs is refused", () => {
    expect(parseReposInput("*, o/a")).toEqual(err({ code: "repos-input-wildcard-mixed" }));
  });

  test("bad slugs and duplicates are reported once, together, each pasted twice counting once", () => {
    expect(parseReposInput("not-a-slug")).toEqual(
      err({ code: "repos-input-invalid-entries", invalid: ["not-a-slug"], duplicated: [] }),
    );
    expect(parseReposInput("o/a, O/A, bad, bad, worse")).toEqual(
      err({ code: "repos-input-invalid-entries", invalid: ["bad", "worse"], duplicated: ["O/A"] }),
    );
  });
});
