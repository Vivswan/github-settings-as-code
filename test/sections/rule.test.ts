/**
 * zod skips a node's own checks once a nested value failed; rule() (src/sections/shared/schema-helpers.ts) runs them
 * through zod's public `when` and filters their findings. These pin that contract, which every section rule relies on
 * and which a per-section test reaches through one document only; each control shows what zod does bare.
 */

import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { loosen } from "../../src/sections/contract/module.js";
import { maxLength, minLength, rule } from "../../src/sections/shared/schema-helpers.js";

const needsModeA = (
  value: { mode?: "a" | "b"; list?: string[] },
  ctx: z.core.$RefinementCtx<unknown>,
): void => {
  if (value.list !== undefined && value.mode !== "a") {
    ctx.addIssue({ code: "custom", path: ["list"], message: "list needs mode a" });
  }
};

const fields = { mode: z.enum(["a", "b"]).optional(), list: z.array(z.string()).optional() };
const pair = z.object(fields).check(rule(needsModeA));

const report = (result: z.ZodSafeParseResult<unknown>) =>
  result.error?.issues.map((issue) => [issue.path, issue.message]);

describe("rule() reports beside a failed nested value", () => {
  test("an object's own rule runs when a sibling property failed, and its finding keeps its path", () => {
    expect(report(pair.safeParse({ mode: "c", list: ["x"] }))).toEqual([
      [["mode"], expect.stringMatching(/^Invalid option/)],
      [["list"], "list needs mode a"],
    ]);
    // Control: the same rule bare is skipped, so a document with a second mistake would hide the first.
    const bare = z.object(fields).superRefine(needsModeA);
    expect(report(bare.safeParse({ mode: "c", list: ["x"] }))).toEqual([
      [["mode"], expect.stringMatching(/^Invalid option/)],
    ]);
  });

  test("a rule's finding under the failed path is dropped: the shape's issue there is the report", () => {
    const sweep = z.object({ list: z.array(z.string()) }).check(
      rule((value, ctx) => {
        for (const key of Object.keys(value.list)) {
          ctx.addIssue({ code: "custom", path: ["list", key], message: "swept" });
        }
      }),
    );
    expect(report(sweep.safeParse({ list: "yes" }))).toEqual([
      [["list"], expect.stringMatching(/expected array/)],
    ]);
  });

  test("a node refused as a whole does not run its own rule on the foreign value", () => {
    let ran = false;
    const watched = z.object({ name: z.string() }).check(
      rule(() => {
        ran = true;
      }),
    );
    expect(watched.safeParse("not a mapping").error?.issues.map((issue) => issue.path)).toEqual([
      [],
    ]);
    expect(ran).toBe(false);
  });

  test("a rule's own when is ANDed with the gate: false keeps the body uncalled, true does not lift the gate", () => {
    const calls: string[] = [];
    const shape = z
      .object({ name: z.string() })
      .check(rule(() => calls.push("never"), { when: () => false }))
      .check(rule(() => calls.push("gated"), { when: () => true }));
    expect(shape.safeParse({ name: "a" }).success).toBe(true);
    expect(shape.safeParse({ name: 1 }).success).toBe(false);
    expect(shape.safeParse("not a mapping").success).toBe(false);
    expect(calls).toEqual(["gated", "gated"]);
  });

  test("a rule composed onto the loosened routed list shape reports beside a failed entry, in both container forms", () => {
    const entry = z.object({ name: z.string() });
    const knob = z.union([
      z.array(entry),
      z.strictObject({
        _undeclared: z.enum(["keep", "delete"]).optional(),
        entries: z.array(entry),
      }),
    ]);
    const composed = loosen(knob).check(
      rule((value, ctx) => {
        const wrapped = !Array.isArray(value);
        const entries = wrapped ? (value as { entries: unknown[] }).entries : value;
        if (entries.length > 1) {
          ctx.addIssue({
            code: "custom",
            path: [...(wrapped ? ["entries"] : []), 1],
            message: "second entry",
          });
        }
      }),
    );
    const paths = (document: unknown) =>
      composed.safeParse(document).error?.issues.map((issue) => issue.path);
    expect(paths([{ name: 1 }, { name: "b" }])).toEqual([[0, "name"], [1]]);
    expect(paths({ entries: [{ name: 1 }, { name: "b" }] })).toEqual([
      ["entries", 0, "name"],
      ["entries", 1],
    ]);
  });

  test("a rule's own finding is not a failure: the list-level rule still runs over an entry with one", () => {
    const list = z.array(pair).check(
      rule((entries, ctx) => {
        if (entries.length > 1) {
          ctx.addIssue({ code: "custom", message: "at most one entry" });
        }
      }),
    );
    expect(
      list.safeParse([{ list: ["x"] }, { mode: "a" }]).error?.issues.map((issue) => issue.message),
    ).toEqual(["list needs mode a", "at most one entry"]);
  });
});

describe("a gated length bound is skipped when the leaf's type failed", () => {
  test("a raw list at a string leaf, and a raw string at a list leaf, each report one issue", () => {
    const shape = z.object({
      delimiter: z.string().check(minLength(1, "empty delimiter")).optional(),
      reviewers: z.array(z.string()).check(maxLength(1, "too many")).optional(),
    });
    expect(report(shape.safeParse({ delimiter: [] }))).toEqual([
      [["delimiter"], expect.stringMatching(/expected string/)],
    ]);
    expect(report(shape.safeParse({ reviewers: "ab" }))).toEqual([
      [["reviewers"], expect.stringMatching(/expected array/)],
    ]);
    expect(report(shape.safeParse({ delimiter: "", reviewers: ["a", "b"] }))).toEqual([
      [["delimiter"], "empty delimiter"],
      [["reviewers"], "too many"],
    ]);
    // Control: zod's own .min() runs on any value with a length, so bare it judges the raw list too.
    const bare = z.object({ delimiter: z.string().min(1, "empty delimiter") });
    expect(report(bare.safeParse({ delimiter: [] }))).toEqual([
      [["delimiter"], expect.stringMatching(/expected string/)],
      [["delimiter"], "empty delimiter"],
    ]);
  });
});
