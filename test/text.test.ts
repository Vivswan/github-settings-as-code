import { describe, expect, test } from "bun:test";
import { agree, countNoun } from "../src/text.js";

describe("count agreement", () => {
  test.each<[count: number, word: string]>([
    [0, "sections"],
    [1, "section"],
    [2, "sections"],
  ])("agree(%i) picks %s", (count, word) => {
    expect(agree(count, "section", "sections")).toBe(word);
  });

  test("countNoun leads with the count and agrees the noun to it", () => {
    expect(countNoun(1, "repository", "repositories")).toBe("1 repository");
    expect(countNoun(2, "repository", "repositories")).toBe("2 repositories");
    expect(countNoun(0, "layer", "layers")).toBe("0 layers");
  });
});
