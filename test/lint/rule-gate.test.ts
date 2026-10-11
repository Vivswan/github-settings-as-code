/**
 * The rule-gate plugin's verdict on each refinement form, and its biome.json wiring, pinned by linting a fixture tree
 * with the repository's own configuration; a snippet that silently stopped matching would let a bare refinement
 * ship, and zod would skip it once a nested value failed.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../root.js";
import { withTempDir } from "../temp-dir.js";
import { lint } from "./fixture-lint.js";

const MESSAGE =
  "bare refinement: zod skips it once a nested value failed; wrap it in rule() so it runs beside nested failures";
const EXEMPT_FILE = "src/sections/shared/schema-helpers.ts";

/** A line ending in `// bare` is one the plugin must flag; every other refinement here is authored through rule(). */
const BARE = /\/\/ bare$/;

const REFINEMENTS = `
import { z } from "zod";
import { maxLength, rule } from "./sections/shared/schema-helpers.js";
const fn = () => true;
export const one = z.string().refine(fn); // bare
export const two = z.string().refine(fn, { error: "x" }); // bare
export const typed = z.string().refine<string>(fn); // bare
export const sup = z.object({ n: z.string() }).superRefine(fn); // bare
export const supParams = z.object({ n: z.string() }).superRefine(fn, { when: () => true }); // bare
export const supTyped = z.object({ n: z.string() }).superRefine<{ n: string }>(fn); // bare
export const composed = z.object({ n: z.string() }).check(z.superRefine(fn)); // bare
export const gated = z.object({ n: z.string() }).check(rule(fn));
export const bounded = z.array(z.string()).check(maxLength(1, "x"));
`.trimStart();

describe("the rule-gate plugin", () => {
  test("flags exactly the bare refinements, and nothing in the exempt file or outside src/", () =>
    withTempDir("rule-gate-", (dir) => {
      const expected = Object.fromEntries(
        REFINEMENTS.split("\n").flatMap((line, index) =>
          BARE.test(line) ? [[`src/refinements.ts:${index + 1}`, `plugin: ${MESSAGE}`]] : [],
        ),
      );
      expect(
        lint(dir, {
          "src/refinements.ts": REFINEMENTS,
          [EXEMPT_FILE]: REFINEMENTS,
          "test/src/fixture.ts": REFINEMENTS,
        }),
      ).toEqual(expected);
    }));

  test("the exempt file still holds a bare refinement (rule() itself), so its exemption is not stale", () =>
    withTempDir("rule-gate-", (dir) => {
      const flagged = lint(dir, {
        "src/not-exempt.ts": readFileSync(join(ROOT, EXEMPT_FILE), "utf8"),
      });
      expect(Object.values(flagged)).toContain(`plugin: ${MESSAGE}`);
    }));
});
