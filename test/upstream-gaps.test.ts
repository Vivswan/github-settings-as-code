import { describe, expect, test } from "bun:test";
import {
  defineGap,
  defineSpecOnlyGap,
  defineVocabularyGap,
  undocumentedRoutes,
} from "../src/upstream-gaps/gap.js";

describe("undocumentedRoutes", () => {
  test("a vocabulary gap contributes nothing: it has no routes, and a routes-only fold would emit `undefined` into the exemption list", () => {
    const routes = undocumentedRoutes([
      defineVocabularyGap({ reference: "https://example.com/vocabulary", values: ["a", "b"] }),
      defineGap({ routes: ["GET /repos/{owner}/{repo}/pinned"], documentedInSpec: false }),
      defineGap({ routes: ["GET /repos/{owner}/{repo}/documented"], documentedInSpec: true }),
      defineSpecOnlyGap({ routes: ["GET /repos/{owner}/{repo}/hooks"] }),
    ]);
    expect(routes).toEqual(["GET /repos/{owner}/{repo}/pinned", "GET /repos/{owner}/{repo}/hooks"]);
  });
});
