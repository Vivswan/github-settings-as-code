import { describe, expect, test } from "bun:test";
import { MockApi } from "../../../test/mock-api.js";
import { ctx } from "../../../test/sections/context.js";
import { normalizeRefName, normalizeRuleset, rulesetsSection } from "./index.js";

describe("normalizeRefName", () => {
  test("branch short name", () => {
    expect(normalizeRefName("staging", "branch")).toBe("refs/heads/staging");
  });
  test("tag pattern", () => {
    expect(normalizeRefName("templates/*", "tag")).toBe("refs/tags/templates/*");
  });
  test("~DEFAULT_BRANCH passthrough", () => {
    expect(normalizeRefName("~DEFAULT_BRANCH", "branch")).toBe("~DEFAULT_BRANCH");
  });
  test("qualified ref passthrough", () => {
    expect(normalizeRefName("refs/heads/main", "branch")).toBe("refs/heads/main");
  });
});

describe("normalizeRuleset", () => {
  test("normalizes includes without mutating input", () => {
    const input = {
      name: "build-tags",
      target: "tag" as const,
      conditions: { ref_name: { include: ["templates/*", "v*"], exclude: [] } },
    };
    const out = normalizeRuleset(input);
    expect(out.conditions?.ref_name?.include).toEqual(["refs/tags/templates/*", "refs/tags/v*"]);
    expect(input.conditions.ref_name.include).toEqual(["templates/*", "v*"]);
  });
});

describe("rulesets", () => {
  test("creates missing with normalized refs, never deletes undeclared", async () => {
    const api = new MockApi({
      "GET /repos/o/r/rulesets?per_page=100&page=1": {
        data: [{ id: 7, name: "legacy", source_type: "Repository" }],
      },
    }).allowMutations("POST /repos/o/r/rulesets");
    const result = await rulesetsSection.run(ctx(api), [
      {
        name: "build-tags",
        target: "tag",
        enforcement: "active",
        conditions: { ref_name: { include: ["templates/*"], exclude: [] } },
        rules: [{ type: "deletion" }],
      },
    ]);
    expect(result.changes).toEqual(['created ruleset "build-tags"']);
    expect(result.notes).toEqual([
      'ruleset "legacy" exists on the repo but is not declared in the settings file; kept under "undeclared: keep" - add it to the settings file to manage it, or set "undeclared: delete" to have apply DELETE it',
    ]);
    const post = api.mutations()[0];
    expect(post?.method).toBe("POST");
    const payload = post?.payload as { conditions: { ref_name: { include: string[] } } };
    expect(payload.conditions.ref_name.include).toEqual(["refs/tags/templates/*"]);
  });

  test("updates by name with full payload", async () => {
    const api = new MockApi({
      "GET /repos/o/r/rulesets?per_page=100&page=1": {
        data: [{ id: 9, name: "main", source_type: "Repository" }],
      },
    }).allowMutations("PUT /repos/o/r/rulesets/*");
    const result = await rulesetsSection.run(ctx(api), [
      { name: "main", target: "branch", rules: [{ type: "deletion" }] },
    ]);
    expect(result.changes).toEqual(['updated ruleset "main" (id 9)']);
    expect(api.mutations()[0]?.path).toBe("/repos/o/r/rulesets/9");
  });

  test("ruleset create defaults enforcement", async () => {
    const api = new MockApi({
      "GET /repos/o/r/rulesets?per_page=100&page=1": { data: [] },
    }).allowMutations("POST /repos/o/r/rulesets");
    await rulesetsSection.run(ctx(api), [{ name: "x", target: "branch" }]);
    const payload = api.mutations()[0]?.payload as { enforcement?: string };
    expect(payload.enforcement).toBe("active");
  });

  test("duplicate ruleset names are rejected before any API call", async () => {
    const api = new MockApi({});
    await expect(
      rulesetsSection.run(ctx(api), [
        { name: "main", target: "branch" },
        { name: "main", target: "tag" },
      ]),
    ).rejects.toThrow(/same rulesets entry/);
    expect(api.calls).toHaveLength(0);
  });

  test("wrapped undeclared:delete DELETES the undeclared ruleset", async () => {
    const api = new MockApi({
      "GET /repos/o/r/rulesets?per_page=100&page=1": {
        data: [
          { id: 7, name: "legacy", source_type: "Repository" },
          { id: 9, name: "main", source_type: "Repository" },
        ],
      },
    }).allowMutations("PUT /repos/o/r/rulesets/*", "DELETE /repos/o/r/rulesets/*");
    const result = await rulesetsSection.run(ctx(api), {
      undeclared: "delete",
      entries: [{ name: "main", target: "branch", rules: [{ type: "deletion" }] }],
    });
    expect(result.changes).toEqual([
      'updated ruleset "main" (id 9)',
      'DELETED undeclared ruleset "legacy"',
    ]);
    expect(result.notes).toEqual([]);
    expect(api.mutations().at(-1)?.path).toBe("/repos/o/r/rulesets/7");
  });

  test("undeclared:delete never deletes a ruleset without an explicit Repository source", async () => {
    // source_type is optional in the API type; a missing field is not proof
    // of repository ownership, and deletion cannot be undone. Organization
    // and enterprise rulesets never enter the managed list at all.
    const api = new MockApi({
      "GET /repos/o/r/rulesets?per_page=100&page=1": {
        data: [
          { id: 7, name: "ambiguous" },
          { id: 8, name: "org-owned", source_type: "Organization" },
          { id: 9, name: "enterprise-owned", source_type: "Enterprise" },
          { id: 10, name: "repo-owned", source_type: "Repository" },
        ],
      },
    }).allowMutations("DELETE /repos/o/r/rulesets/*");
    const result = await rulesetsSection.run(ctx(api), {
      undeclared: "delete",
      entries: [],
    });
    // Only the explicitly repository-owned ruleset is deleted; the
    // source_type-less one is kept with a note naming the rule.
    expect(result.changes).toEqual(['DELETED undeclared ruleset "repo-owned"']);
    expect(result.notes).toEqual([
      'ruleset "ambiguous" is undeclared, but the list response does not mark it source_type "Repository"; NOT deleting - only rulesets the API explicitly marks repository-owned are deleted; add it to the settings file to manage it, or delete it in GitHub if it should not exist',
    ]);
    expect(api.mutations().map((m) => m.path)).toEqual(["/repos/o/r/rulesets/10"]);
  });

  test("wrapped undeclared:delete in check mode reports drift, writes nothing", async () => {
    const api = new MockApi({
      "GET /repos/o/r/rulesets?per_page=100&page=1": {
        data: [{ id: 7, name: "legacy", source_type: "Repository" }],
      },
    });
    const result = await rulesetsSection.run(ctx(api, true), {
      undeclared: "delete",
      entries: [],
    });
    expect(result.drift).toEqual([
      'rulesets[legacy]: undeclared - not in the settings file and "undeclared: delete" is set, so apply will DELETE it; add it to the settings file to keep it',
    ]);
    expect(api.mutations()).toEqual([]);
  });

  test("the wrapper without a policy keeps the keep default (notes only)", async () => {
    const api = new MockApi({
      "GET /repos/o/r/rulesets?per_page=100&page=1": {
        data: [{ id: 7, name: "legacy", source_type: "Repository" }],
      },
    });
    const result = await rulesetsSection.run(ctx(api), { entries: [] });
    expect(result.changes).toEqual([]);
    expect(result.notes).toHaveLength(1);
    expect(api.mutations()).toEqual([]);
  });
});
