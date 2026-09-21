import { describe, expect, test } from "bun:test";
import { err, ok } from "neverthrow";
import { parseReposInput } from "../../src/discovery/repos-input.js";

describe("parseReposInput", () => {
  test.each<[string, string, ReturnType<typeof parseReposInput>]>([
    [
      "splits on commas and newlines",
      "o/a, o/b\no/c",
      ok({ slugs: ["o/a", "o/b", "o/c"], discover: false }),
    ],
    ["* alone switches to discovery", "*", ok({ slugs: [], discover: true })],
    ["* mixed with slugs is refused", "*, o/a", err({ code: "repos-input-wildcard-mixed" })],
    [
      "a bad slug is reported",
      "not-a-slug",
      err({ code: "repos-input-invalid-entries", invalid: ["not-a-slug"], duplicated: [] }),
    ],
    [
      "bad slugs and duplicates are reported once, together, each pasted twice counting once",
      "o/a, O/A, bad, bad, worse",
      err({ code: "repos-input-invalid-entries", invalid: ["bad", "worse"], duplicated: ["O/A"] }),
    ],
  ])("%s: %p", (_case, input, result) => {
    expect(parseReposInput(input)).toEqual(result);
  });
});
