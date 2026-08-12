import { describe, expect, test } from "bun:test";
import { validateSectionShapes } from "../../../src/engine/validate.js";
import { grantFor, PermissionDenied } from "../../../src/sections/contract.js";
import { MockApi } from "../../../test/mock-api.js";
import { ctx } from "../../../test/sections/context.js";
import { actionsSection } from "./index.js";
// The casts on some run() inputs below simulate FUTURE keys: the runtime
// shape passes unknown keys through verbatim, which the static config type
// cannot spell without giving up typo-checking on the known keys.
import type { ActionsConfig } from "./schema.js";

const ACTIONS_WRITES = [
  "PUT /repos/o/r/actions/permissions",
  "PUT /repos/o/r/actions/permissions/*",
  "PUT /repos/o/r/actions/cache/*",
];

/**
 * The mutations by "METHOD path". Set-shaped on purpose for the ONE test
 * whose keys span both the base/workflow bodies and the routed table (whose
 * relative order the routing table owns, not the contract); the
 * single-family tests below keep their exact ordered assertions, since the
 * order within one table pass is deterministic and load-bearing. Two writes
 * to the same path would collapse into one entry, so every caller also pins
 * the mutation COUNT.
 */
function mutationsByPath(api: MockApi): Map<string, unknown> {
  return new Map(api.mutations().map((m) => [`${m.method} ${m.path}`, m.payload]));
}

describe("actions", () => {
  test("routes every key to its endpoint, access_level included", async () => {
    const api = new MockApi({}).allowMutations(...ACTIONS_WRITES);
    const result = await actionsSection.run(ctx(api), {
      enabled: true,
      allowed_actions: "selected",
      selected_actions: { github_owned_allowed: true },
      default_workflow_permissions: "read",
      access_level: "organization",
    });
    const writes = mutationsByPath(api);
    expect(api.mutations()).toHaveLength(4);
    // The base permissions PUT must still precede the selected-actions PUT:
    // the allowlist endpoint 409s until the policy is "selected".
    const paths = api.mutations().map((m) => `${m.method} ${m.path}`);
    expect(paths.indexOf("PUT /repos/o/r/actions/permissions")).toBeLessThan(
      paths.indexOf("PUT /repos/o/r/actions/permissions/selected-actions"),
    );
    expect(new Set(writes.keys())).toEqual(
      new Set([
        "PUT /repos/o/r/actions/permissions",
        "PUT /repos/o/r/actions/permissions/selected-actions",
        "PUT /repos/o/r/actions/permissions/workflow",
        "PUT /repos/o/r/actions/permissions/access",
      ]),
    );
    const base = writes.get("PUT /repos/o/r/actions/permissions") as Record<string, unknown>;
    expect("access_level" in base).toBe(false);
    expect(writes.get("PUT /repos/o/r/actions/permissions/access")).toEqual({
      access_level: "organization",
    });
    expect(result.notes).toEqual([]);
  });

  test("check compares access_level against its own endpoint", async () => {
    const api = new MockApi({
      "GET /repos/o/r/actions/permissions/access": { data: { access_level: "none" } },
    });
    const result = await actionsSection.run(ctx(api, true), { access_level: "organization" });
    expect(result.drift).toHaveLength(1);
    expect(result.drift?.[0]).toContain("actions.access.access_level");
    expect(api.mutations()).toEqual([]);
  });

  test("any base-permissions key implies enabled: true in the PUT body", async () => {
    const api = new MockApi({}).allowMutations(...ACTIONS_WRITES);
    await actionsSection.run(ctx(api), { allowed_actions: "all" });
    expect(api.mutations()[0]?.payload).toEqual({ allowed_actions: "all", enabled: true });
    const future = new MockApi({}).allowMutations(...ACTIONS_WRITES);
    await actionsSection.run(ctx(future), { some_future_key: "x" } as ActionsConfig);
    const payload = future.mutations()[0]?.payload as Record<string, unknown>;
    expect(payload.enabled).toBe(true);
  });

  test("the unrecognized-key note reports the enabled value and matches the mode", async () => {
    const apply = new MockApi({}).allowMutations(...ACTIONS_WRITES);
    const applied = await actionsSection.run(ctx(apply), { some_future_key: "x" } as ActionsConfig);
    expect(applied.notes).toHaveLength(1);
    expect(applied.notes[0]).toContain("enabled: true");
    expect(applied.notes[0]).toContain("were sent verbatim");
    const explicitOff = new MockApi({}).allowMutations(...ACTIONS_WRITES);
    const off = await actionsSection.run(ctx(explicitOff), {
      enabled: false,
      some_future_key: "x",
    } as ActionsConfig);
    expect(off.notes[0]).toContain("enabled: false");
    const check = new MockApi({
      "GET /repos/o/r/actions/permissions": { data: { enabled: true } },
    });
    const checked = await actionsSection.run(ctx(check, true), {
      some_future_key: "x",
    } as ActionsConfig);
    expect(checked.notes).toHaveLength(1);
    expect(checked.notes[0]).toContain("enabled: true");
    expect(checked.notes[0]).toContain("would send");
    expect(check.mutations()).toEqual([]);
  });

  test("selected-actions check treats a 409 as drift, not failure", async () => {
    const api = new MockApi({
      "GET /repos/o/r/actions/permissions": { data: { enabled: true, allowed_actions: "all" } },
      "GET /repos/o/r/actions/permissions/selected-actions": {
        error: { status: 409, message: "Conflict", body: "" },
      },
    });
    const result = await actionsSection.run(ctx(api, true), {
      allowed_actions: "selected",
      selected_actions: { github_owned_allowed: true },
    });
    expect(result.drift?.some((d) => d.includes('not "selected"'))).toBe(true);
    expect(api.mutations()).toEqual([]);
  });

  test("selected_actions implies allowed_actions: selected; a contradiction fails upfront shape validation", async () => {
    const api = new MockApi({}).allowMutations(...ACTIONS_WRITES);
    await actionsSection.run(ctx(api), { selected_actions: { github_owned_allowed: true } });
    const base = api.mutations()[0]?.payload as Record<string, unknown>;
    expect(base.allowed_actions).toBe("selected");
    // The contradiction is a shape rejection (both modes, before any section
    // writes), not a run()-time throw.
    const error = validateSectionShapes(
      { actions: { allowed_actions: "all", selected_actions: { github_owned_allowed: true } } },
      "f.yml",
    );
    expect(error).toContain("actions.selected_actions");
    expect(error).toContain('an allowlist only applies under allowed_actions: "selected"');
    // The valid pairing and the inferred form both pass validation.
    expect(
      validateSectionShapes(
        {
          actions: {
            allowed_actions: "selected",
            selected_actions: { github_owned_allowed: true },
          },
        },
        "f.yml",
      ),
    ).toBeNull();
    expect(
      validateSectionShapes(
        { actions: { selected_actions: { github_owned_allowed: true } } },
        "f.yml",
      ),
    ).toBeNull();
  });

  test("retention and cache route to their endpoints, never the base PUT", async () => {
    const api = new MockApi({}).allowMutations(...ACTIONS_WRITES);
    const result = await actionsSection.run(ctx(api), {
      artifact_and_log_retention: { days: 30 },
      cache: { max_cache_retention_days: 3, max_cache_size_gb: 25 },
    });
    // Deterministic: one table pass, so retention precedes both cache PUTs
    // and the two cache limits go in CACHE_ENDPOINT_BY_KEY order.
    expect(api.mutations().map((m) => `${m.method} ${m.path}`)).toEqual([
      "PUT /repos/o/r/actions/permissions/artifact-and-log-retention",
      "PUT /repos/o/r/actions/cache/retention-limit",
      "PUT /repos/o/r/actions/cache/storage-limit",
    ]);
    expect(api.mutations()[0]?.payload).toEqual({ days: 30 });
    expect(api.mutations()[1]?.payload).toEqual({ max_cache_retention_days: 3 });
    expect(api.mutations()[2]?.payload).toEqual({ max_cache_size_gb: 25 });
    // No base-permissions PUT: these keys alone must not imply enabled: true.
    expect(result.notes).toEqual([]);
  });

  test("a lone cache key touches only its own endpoint", async () => {
    const api = new MockApi({}).allowMutations(...ACTIONS_WRITES);
    await actionsSection.run(ctx(api), { cache: { max_cache_size_gb: 25 } });
    expect(api.mutations().map((m) => `${m.method} ${m.path}`)).toEqual([
      "PUT /repos/o/r/actions/cache/storage-limit",
    ]);
  });

  test("check compares retention and cache against their own endpoints", async () => {
    const api = new MockApi({
      "GET /repos/o/r/actions/permissions/artifact-and-log-retention": { data: { days: 90 } },
      "GET /repos/o/r/actions/cache/retention-limit": {
        data: { max_cache_retention_days: 7 },
      },
      "GET /repos/o/r/actions/cache/storage-limit": { data: { max_cache_size_gb: 10 } },
    });
    const result = await actionsSection.run(ctx(api, true), {
      artifact_and_log_retention: { days: 30 },
      cache: { max_cache_retention_days: 3, max_cache_size_gb: 25 },
    });
    // Deterministic like the apply path: one table pass, table order.
    expect(result.drift).toHaveLength(3);
    expect(result.drift?.[0]).toContain("actions.artifact_and_log_retention.days");
    expect(result.drift?.[1]).toContain("actions.cache.max_cache_retention_days");
    expect(result.drift?.[2]).toContain("actions.cache.max_cache_size_gb");
    expect(api.mutations()).toEqual([]);
  });

  test("the shape rejects unrecognized, null, and scalar cache declarations upfront", () => {
    // Inherited names like "constructor" must be caught too: an `in`-based
    // check would walk the prototype chain and let them silently no-op.
    for (const cache of [{ max_cache_size: 25 }, { constructor: 5 }, null, 5]) {
      const parsed = actionsSection.shape.safeParse({ cache });
      expect(parsed.success).toBe(false);
    }
    expect(
      actionsSection.shape.safeParse({
        cache: { max_cache_retention_days: 3, max_cache_size_gb: 25 },
        some_future_key: "passes through",
      }).success,
    ).toBe(true);
  });

  test("the handler backstop catches an own __proto__ key the shape ignores", async () => {
    // JSON.parse creates __proto__ as an OWN key; zod's strictObject skips
    // it, so the shape passes and only the run()-level guard can reject it.
    const cache = JSON.parse('{"__proto__": 5}');
    expect(actionsSection.shape.safeParse({ cache }).success).toBe(true);
    await expect(actionsSection.run(ctx(new MockApi({})), { cache })).rejects.toThrow(
      /actions\.cache: unrecognized key\(s\) "__proto__"/,
    );
  });

  test("apply PUTs the OIDC subject claim template verbatim to its own endpoint", async () => {
    const api = new MockApi({}).allowMutations("PUT /repos/o/r/actions/oidc/customization/sub");
    const declared = { use_default: false, include_claim_keys: ["repo", "context"] };
    const result = await actionsSection.run(ctx(api), { oidc_customization_sub: declared });
    expect(api.mutations().map((m) => `${m.method} ${m.path}`)).toEqual([
      "PUT /repos/o/r/actions/oidc/customization/sub",
    ]);
    expect(api.mutations()[0]?.payload).toEqual(declared);
    expect(result.changes).toEqual(["applied the OIDC subject claim template"]);
  });

  test("check drifts on use_default and never writes", async () => {
    const api = new MockApi({
      "GET /repos/o/r/actions/oidc/customization/sub": { data: { use_default: true } },
    });
    const result = await actionsSection.run(ctx(api, true), {
      oidc_customization_sub: { use_default: false, include_claim_keys: ["repo"] },
    });
    expect(
      result.drift?.some((d) => d.includes("actions.oidc_customization_sub.use_default")),
    ).toBe(true);
    expect(api.mutations()).toEqual([]);
  });

  test("check compares include_claim_keys positionally: a reordered live value is drift", async () => {
    const reordered = new MockApi({
      "GET /repos/o/r/actions/oidc/customization/sub": {
        data: { use_default: false, include_claim_keys: ["context", "repo"] },
      },
    });
    const result = await actionsSection.run(ctx(reordered, true), {
      oidc_customization_sub: { use_default: false, include_claim_keys: ["repo", "context"] },
    });
    expect(result.drift).toHaveLength(1);
    expect(result.drift?.[0]).toContain("include_claim_keys");
    expect(result.drift?.[0]).toContain("order");

    const matching = new MockApi({
      "GET /repos/o/r/actions/oidc/customization/sub": {
        data: { use_default: false, include_claim_keys: ["repo", "context"] },
      },
    });
    const clean = await actionsSection.run(ctx(matching, true), {
      oidc_customization_sub: { use_default: false, include_claim_keys: ["repo", "context"] },
    });
    expect(clean.drift).toEqual([]);
  });

  test("a custom template with an omitted claim-key list does not compare keys", async () => {
    // {use_default: false} with no list is the documented opt-in to the
    // ORGANIZATION template, whose keys then appear live; comparing the
    // omitted list against them would be permanent false drift.
    const api = new MockApi({
      "GET /repos/o/r/actions/oidc/customization/sub": {
        data: { use_default: false, include_claim_keys: ["repo", "context"] },
      },
    });
    const result = await actionsSection.run(ctx(api, true), {
      oidc_customization_sub: { use_default: false },
    });
    expect(result.drift).toEqual([]);
  });

  test("a default template never compares claim keys (GitHub ignores them)", async () => {
    const api = new MockApi({
      "GET /repos/o/r/actions/oidc/customization/sub": {
        data: { use_default: true, include_claim_keys: ["job_workflow_ref"] },
      },
    });
    const result = await actionsSection.run(ctx(api, true), {
      oidc_customization_sub: { use_default: true, include_claim_keys: ["repo"] },
    });
    expect(result.drift).toEqual([]);
  });

  test("a declared use_immutable_subject rides the remainder diff", async () => {
    // The flag flips the whole subject format, so a declared false against
    // a live true must drift; undeclared, the inherited org/date default
    // stays uncompared like every other undeclared key.
    const api = new MockApi({
      "GET /repos/o/r/actions/oidc/customization/sub": {
        data: { use_default: false, include_claim_keys: ["repo"], use_immutable_subject: true },
      },
    });
    const result = await actionsSection.run(ctx(api, true), {
      oidc_customization_sub: {
        use_default: false,
        include_claim_keys: ["repo"],
        use_immutable_subject: false,
      },
    });
    expect(result.drift).toHaveLength(1);
    expect(result.drift?.[0]).toContain("use_immutable_subject");
  });

  test("the oidc shape rejects quoted booleans upfront", () => {
    // A YAML '"false"' is truthy on the wire; both boolean fields must
    // fail validation before any section writes.
    for (const bad of [
      { use_default: "false" },
      { use_default: true, use_immutable_subject: "false" },
    ]) {
      expect(actionsSection.shape.safeParse({ oidc_customization_sub: bad }).success).toBe(false);
    }
  });

  test("a denied fork-pr-private read renders the ambiguity denialHint", async () => {
    // If GitHub denies this pair on a public repository, this one sentence
    // is the whole mitigation - and the mechanism (denialHint on the
    // permission branch) has silently broken once before, so pin that a
    // denial actually renders it.
    const api = new MockApi({
      "GET /repos/o/r/actions/permissions/fork-pr-workflows-private-repos": {
        error: { status: 403, message: "Forbidden", body: "" },
      },
    });
    let thrown: unknown;
    try {
      await actionsSection.run(ctx(api, true), {
        fork_pr_workflows_private_repos: {
          run_workflows_from_fork_pull_requests: true,
          send_write_tokens_to_workflows: false,
          send_secrets_and_variables: false,
          require_approval_for_fork_pr_workflows: true,
        },
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(PermissionDenied);
    expect((thrown as PermissionDenied).detail).toContain("can also mean the repository is public");
  });

  test("a denied OIDC read renders the Actions grant, not the section's Administration", async () => {
    const api = new MockApi({
      "GET /repos/o/r/actions/oidc/customization/sub": {
        error: { status: 403, message: "Resource not accessible", body: "" },
      },
    });
    let thrown: unknown;
    try {
      await actionsSection.run(ctx(api, true), {
        oidc_customization_sub: { use_default: true },
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(PermissionDenied);
    const denied = thrown as PermissionDenied;
    // The failing call is a GET, but the advice grades by the SECTION's need
    // on the override permission: the OIDC PUT sibling writes with the same
    // Actions permission, so read-only advice would cost a second round trip
    // (grant read, pass preflight, fail on the write).
    expect(denied.detail).toContain(grantFor({ repo: ["actions"] }));
    expect(denied.detail).not.toContain('"Administration"');
  });

  test("apply PUTs each fork PR policy object verbatim to its own endpoint", async () => {
    const api = new MockApi({}).allowMutations(...ACTIONS_WRITES);
    const approval = { approval_policy: "first_time_contributors" };
    const privateRepos = {
      run_workflows_from_fork_pull_requests: true,
      send_write_tokens_to_workflows: false,
      send_secrets_and_variables: false,
      require_approval_for_fork_pr_workflows: true,
      future_field: "rides along",
    };
    const result = await actionsSection.run(ctx(api), {
      fork_pr_contributor_approval: approval,
      fork_pr_workflows_private_repos: privateRepos,
    });
    // Deterministic: both keys sit in the routed table, visited in its order.
    expect(api.mutations().map((m) => `${m.method} ${m.path}`)).toEqual([
      "PUT /repos/o/r/actions/permissions/fork-pr-contributor-approval",
      "PUT /repos/o/r/actions/permissions/fork-pr-workflows-private-repos",
    ]);
    expect(api.mutations()[0]?.payload).toEqual(approval);
    expect(api.mutations()[1]?.payload).toEqual(privateRepos);
    // No base-permissions PUT: these keys alone must not imply enabled: true.
    expect(result.notes).toEqual([]);
    expect(result.changes).toEqual([
      "applied the fork PR contributor approval policy",
      "applied the private-repo fork PR workflow settings",
    ]);
  });

  test("check compares the contributor approval policy against its own endpoint", async () => {
    const api = new MockApi({
      "GET /repos/o/r/actions/permissions/fork-pr-contributor-approval": {
        data: { approval_policy: "first_time_contributors_new_to_github" },
      },
    });
    const result = await actionsSection.run(ctx(api, true), {
      fork_pr_contributor_approval: { approval_policy: "all_external_contributors" },
    });
    expect(result.drift).toHaveLength(1);
    expect(result.drift?.[0]).toContain("actions.fork_pr_contributor_approval.approval_policy");
    expect(api.mutations()).toEqual([]);
  });

  test("check compares the complete private-repos policy against the live settings", async () => {
    const api = new MockApi({
      "GET /repos/o/r/actions/permissions/fork-pr-workflows-private-repos": {
        data: {
          run_workflows_from_fork_pull_requests: false,
          send_write_tokens_to_workflows: true,
          send_secrets_and_variables: true,
          require_approval_for_fork_pr_workflows: false,
        },
      },
    });
    const result = await actionsSection.run(ctx(api, true), {
      fork_pr_workflows_private_repos: {
        run_workflows_from_fork_pull_requests: true,
        send_write_tokens_to_workflows: false,
        send_secrets_and_variables: false,
        require_approval_for_fork_pr_workflows: true,
      },
    });
    // The shape requires all four toggles and every one is compared: with
    // every live value flipped, all four must drift - an omitted comparison
    // cannot pass here.
    expect(result.drift).toHaveLength(4);
    for (const field of [
      "run_workflows_from_fork_pull_requests",
      "send_write_tokens_to_workflows",
      "send_secrets_and_variables",
      "require_approval_for_fork_pr_workflows",
    ]) {
      expect(
        result.drift?.some((line) =>
          line.includes(`actions.fork_pr_workflows_private_repos.${field}`),
        ),
        `no drift line for ${field}`,
      ).toBe(true);
    }
    expect(api.mutations()).toEqual([]);
  });

  test("the private-repos shape requires the complete policy and stays loose otherwise", () => {
    // GitHub does not document whether an omitted toggle is preserved or
    // reset by the PUT, so the shape demands all four booleans (a YAML-quoted
    // "true" included) before any section writes.
    for (const bad of [
      { send_secrets_and_variables: false },
      {
        run_workflows_from_fork_pull_requests: "true",
        send_write_tokens_to_workflows: false,
        send_secrets_and_variables: false,
        require_approval_for_fork_pr_workflows: true,
      },
      {
        run_workflows_from_fork_pull_requests: true,
        send_write_tokens_to_workflows: false,
        send_secrets_and_variables: false,
      },
    ]) {
      expect(actionsSection.shape.safeParse({ fork_pr_workflows_private_repos: bad }).success).toBe(
        false,
      );
    }
    expect(
      actionsSection.shape.safeParse({
        fork_pr_contributor_approval: { approval_policy: "first_time_contributors" },
        fork_pr_workflows_private_repos: {
          run_workflows_from_fork_pull_requests: true,
          send_write_tokens_to_workflows: false,
          send_secrets_and_variables: false,
          require_approval_for_fork_pr_workflows: true,
          future_field: "passes through",
        },
      }).success,
    ).toBe(true);
    // The approval object requires its policy string the same way.
    expect(actionsSection.shape.safeParse({ fork_pr_contributor_approval: {} }).success).toBe(
      false,
    );
  });
});
