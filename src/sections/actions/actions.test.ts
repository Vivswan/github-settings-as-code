import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { validateSectionShapes } from "../../../src/engine/validate.js";
import type { GitHubClient } from "../../../src/github/api.js";
import {
  driftOf,
  type OnMissingPermission,
  type PlannedOp,
  planContext,
  snapshotContext,
} from "../../../src/sections/contract/plan.js";
import { MockApi } from "../../../test/mock-api.js";
import { provePlanIdempotent } from "../../../test/sections/plan-idempotence.js";
import { deniedDetail, REPO, unwrap } from "../../../test/sections/section-run.js";
import { validatedInput } from "../../../test/sections/validated-input.js";
import { describeProblem } from "../../problem.js";
import { type SectionInput, sectionGrant } from "../contract/module.js";
import { grantFor } from "../contract/permissions.js";
import { actionsSection, endpointRouted } from "./index.js";
// The `as ActionsConfig` casts below simulate keys GitHub adds: the shape passes unknown keys through verbatim, which the static config type cannot
// spell without giving up typo-checking on the known keys.
import type { ActionsConfig } from "./schema.js";

function shapeError(doc: Record<string, unknown>, sourceLabel: string): string | null {
  return validateSectionShapes(doc, sourceLabel).match(() => null, describeProblem);
}

const BASE = "/repos/o/r/actions/permissions";
const PERMISSIONS = `GET ${BASE}`;
const SELECTED = `GET ${BASE}/selected-actions`;
const WORKFLOW = `GET ${BASE}/workflow`;
const ACCESS = `GET ${BASE}/access`;
const RETENTION = `GET ${BASE}/artifact-and-log-retention`;
const CACHE_RETENTION = "GET /repos/o/r/actions/cache/retention-limit";
const CACHE_STORAGE = "GET /repos/o/r/actions/cache/storage-limit";
const OIDC = "GET /repos/o/r/actions/oidc/customization/sub";
const FORK_APPROVAL = `GET ${BASE}/fork-pr-contributor-approval`;
const FORK_PRIVATE = `GET ${BASE}/fork-pr-workflows-private-repos`;

/**
 * A stateful fake of the Actions settings API: each GET serves the body its
 * PUT last stored, and the selected-actions GET answers 409 while the stored
 * policy is not "selected", as GitHub does.
 */
function liveActions(seed: Record<string, unknown>): GitHubClient & { writes: string[] } {
  const stored = new Map(Object.entries(seed));
  return {
    writes: [],
    async tryRequest(method, path, payload) {
      if (method === "GET") {
        if (path === `${BASE}/selected-actions`) {
          const policy = (stored.get(BASE) as { allowed_actions?: string } | undefined)
            ?.allowed_actions;
          if (policy !== "selected") {
            return { error: { status: 409, message: "Conflict", body: "" } };
          }
        }
        const body = stored.get(path);
        return body === undefined
          ? { error: { status: 404, message: "Not Found", body: "" } }
          : { data: body };
      }
      this.writes.push(`${method} ${path}`);
      // GitHub keeps the fields a partial PUT leaves out, so the stored body merges rather than replaces.
      stored.set(path, { ...(stored.get(path) as object), ...(payload as object) });
      return { data: null };
    },
    async tryGraphql() {
      throw new Error("the actions section issues no GraphQL");
    },
  };
}

describe("actions", () => {
  const plan = async (api: MockApi, desired: SectionInput<"actions">) =>
    unwrap(
      await actionsSection.plan(
        planContext(actionsSection, api, REPO),
        validatedInput("actions", desired),
      ),
    );
  const roles = (api: MockApi) => api.calls.map((c) => `${c.method} ${c.path}`);

  test("routes every divergent key to its own PUT: base, workflow, then the routed table", async () => {
    const api = new MockApi({
      [PERMISSIONS]: { data: { enabled: true, allowed_actions: "all" } },
      [SELECTED]: { error: { status: 409, message: "Conflict", body: "" } },
      [WORKFLOW]: {
        data: { default_workflow_permissions: "write", can_approve_pull_request_reviews: false },
      },
      [ACCESS]: { data: { access_level: "none" } },
    });
    const result = await plan(api, {
      enabled: true,
      allowed_actions: "selected",
      selected_actions: { github_owned_allowed: true },
      default_workflow_permissions: "read",
      access_level: "organization",
    });
    expect(result).toEqual({
      ops: [
        {
          role: "putPermissions",
          payload: { enabled: true, allowed_actions: "selected" },
          drift: ['actions.permissions.allowed_actions: "selected" != "all"'],
          change: "applied actions permissions",
        },
        {
          role: "putWorkflow",
          payload: { default_workflow_permissions: "read" },
          drift: ['actions.workflow.default_workflow_permissions: "read" != "write"'],
          change: "applied workflow token permissions",
        },
        {
          role: "putSelected",
          payload: { github_owned_allowed: true },
          drift: [
            'actions.selected: no selected-actions allowlist is readable (the live allowed_actions policy is not "selected", or no allowlist has been set); apply will set the declared allowlist',
          ],
          change: "applied selected-actions policy",
        },
        {
          role: "putAccess",
          payload: { access_level: "organization" },
          describe: undefined,
          drift: ['actions.access.access_level: "organization" != "none"'],
          change: "applied workflows access level",
        },
      ],
      notes: [],
      drift: [],
    });
    expect(roles(api)).toEqual([PERMISSIONS, WORKFLOW, SELECTED, ACCESS]);
  });

  test("a selected policy already live with no allowlist plans only the allowlist PUT", async () => {
    // The allowlist GET 404s (none exists yet) while the policy already matches, so only putSelected is due.
    const api = new MockApi({
      [PERMISSIONS]: { data: { enabled: true, allowed_actions: "selected" } },
    });
    const result = await plan(api, { selected_actions: { github_owned_allowed: true } });
    expect(result.ops.map((op) => [op.role, op.drift])).toEqual([
      [
        "putSelected",
        [
          'actions.selected: no selected-actions allowlist is readable (the live allowed_actions policy is not "selected", or no allowlist has been set); apply will set the declared allowlist',
        ],
      ],
    ]);
  });

  test("any base-permissions key implies enabled: true in the PUT body", async () => {
    const api = new MockApi({
      [PERMISSIONS]: { data: { enabled: false, allowed_actions: "none" } },
    });
    const result = await plan(api, { allowed_actions: "all" });
    expect(result.ops[0]?.payload).toEqual({ allowed_actions: "all", enabled: true });
    const added = await plan(api, { some_added_key: "x" } as ActionsConfig);
    expect(added.ops[0]?.payload).toEqual({ some_added_key: "x", enabled: true });
  });

  test("the unrecognized-key note reports the enabled value in both modes' terms", async () => {
    const api = new MockApi({ [PERMISSIONS]: { data: { enabled: true } } });
    const result = await plan(api, { some_added_key: "x" } as ActionsConfig);
    expect(result.notes).toEqual([
      "key [some_added_key] is not recognized by this action; it rides verbatim in PUT " +
        "/actions/permissions (a body that also sets enabled: true), where GitHub may ignore " +
        'it - a "no such field" drift line for a key means GitHub does not return it, so it ' +
        "can never be proven to have taken and apply would re-send the body on every run; remove " +
        "it from the actions section of the settings file",
    ]);
    expect(result.ops.flatMap(driftOf)).toEqual([
      'actions.permissions.some_added_key: declared "x" but the API response has no such field (new or write-only field?)',
    ]);
    const off = await plan(api, { enabled: false, some_added_key: "x" } as ActionsConfig);
    expect(off.notes[0]).toContain("enabled: false");
    const two = await plan(api, { some_added_key: "x", other_key: "y" } as ActionsConfig);
    expect(two.notes[0]).toStartWith(
      "keys [some_added_key, other_key] are not recognized by this action; they ride verbatim in PUT " +
        "/actions/permissions (a body that also sets enabled: true), where GitHub may ignore them - ",
    );
  });

  test("retention and cache route to their endpoints, never the base PUT", async () => {
    const api = new MockApi({
      [RETENTION]: { data: { days: 90 } },
      [CACHE_RETENTION]: { data: { max_cache_retention_days: 7 } },
      [CACHE_STORAGE]: { data: { max_cache_size_gb: 10 } },
    });
    const result = await plan(api, {
      artifact_and_log_retention: { days: 30 },
      cache: { max_cache_retention_days: 3, max_cache_size_gb: 25 },
    });
    expect(result.ops).toEqual([
      {
        role: "putRetention",
        payload: { days: 30 },
        describe: "setting the artifact and log retention window",
        drift: ["actions.artifact_and_log_retention.days: 30 != 90"],
        change: "applied artifact and log retention",
      },
      {
        role: "putCacheRetention",
        payload: { max_cache_retention_days: 3 },
        describe: "setting the cache retention limit",
        drift: ["actions.cache.max_cache_retention_days: 3 != 7"],
        change: "applied cache retention limit",
      },
      {
        role: "putCacheStorage",
        payload: { max_cache_size_gb: 25 },
        describe: "setting the cache storage limit",
        drift: ["actions.cache.max_cache_size_gb: 25 != 10"],
        change: "applied cache storage limit",
      },
    ]);
    // No base-permissions read or PUT: these keys alone must not imply enabled: true.
    expect(roles(api)).toEqual([RETENTION, CACHE_RETENTION, CACHE_STORAGE]);
    expect(result.notes).toEqual([]);
  });

  test("an unset limit answers {} (the spec marks the field optional): the declared value is drift, not a read failure", async () => {
    const api = new MockApi({ [CACHE_RETENTION]: { data: {} } });
    const result = await plan(api, { cache: { max_cache_retention_days: 3 } });
    expect(result.ops.map((op) => [op.role, op.drift])).toEqual([
      [
        "putCacheRetention",
        [
          "actions.cache.max_cache_retention_days: declared 3 but the API response has no such field (new or write-only field?)",
        ],
      ],
    ]);
  });

  test("the shape refuses upfront what would otherwise re-PUT forever or 422 at apply time", () => {
    // Each case names the silent failure the refusal prevents. Cases on zod's own wording pin only the
    // path and the offending key, so a zod wording change does not break them; the messages this
    // section writes are pinned whole. The prototype-chain cache keys: an `in`-based check would let
    // "constructor" no-op silently, and JSON.parse creates an own "__proto__" key.
    const refused: [reason: string, actions: Record<string, unknown>, rendered: string[]][] = [
      [
        "a misspelled cache key has no endpoint",
        { cache: { max_cache_size: 25 } },
        ["actions.cache", '"max_cache_size"'],
      ],
      [
        "a prototype-chain cache key is a typo too",
        { cache: { constructor: 5 } },
        ["actions.cache", '"constructor"'],
      ],
      [
        "an own __proto__ cache key is a typo too",
        { cache: JSON.parse('{"__proto__": 5}') },
        ["actions.cache", '"__proto__"'],
      ],
      ["a null cache is not a limit", { cache: null }, ["actions.cache"]],
      ["a scalar cache is not a limit", { cache: 5 }, ["actions.cache"]],
      [
        "a fractional cache size 400s at apply",
        { cache: { max_cache_size_gb: 2.5 } },
        ["actions.cache.max_cache_size_gb"],
      ],
      [
        "a zero cache retention 400s at apply",
        { cache: { max_cache_retention_days: 0 } },
        ["actions.cache.max_cache_retention_days"],
      ],
      [
        "a fractional retention 422s at apply",
        { artifact_and_log_retention: { days: 30.5 } },
        ["actions.artifact_and_log_retention.days"],
      ],
      [
        "a zero retention 422s at apply",
        { artifact_and_log_retention: { days: 0 } },
        ["actions.artifact_and_log_retention.days"],
      ],
      [
        "the plan maximum is reported by the GET and never taken by the PUT: declared, it would diff and re-PUT forever",
        { artifact_and_log_retention: { days: 30, maximum_allowed_days: 400 } },
        [
          "actions.artifact_and_log_retention.maximum_allowed_days: maximum_allowed_days is a value GitHub reports, not a setting it accepts " +
            "(the GET returns it, the PUT does not take it), so a declared value could never be applied; remove it from the settings file",
        ],
      ],
      [
        "the allowlist URL is reported by the permissions GET and never taken by its PUT",
        {
          selected_actions_url:
            "https://api.github.com/repos/octocat/hello/actions/permissions/selected-actions",
        },
        [
          "actions.selected_actions_url: selected_actions_url is a value GitHub reports, not a setting it accepts",
        ],
      ],
      [
        "the subject prefix is reported by the OIDC GET and never taken by its PUT",
        { oidc_customization_sub: { use_default: true, sub_claim_prefix: "repo:octocat/hello" } },
        [
          "actions.oidc_customization_sub.sub_claim_prefix: sub_claim_prefix is a value GitHub reports, not a setting it accepts",
        ],
      ],
      [
        "a misspelled allowlist key would ride the selected-actions PUT on every run: that PUT has no unrecognized-key note",
        { selected_actions: { pattern_allowed: ["docker/*"] } },
        ["actions.selected_actions", '"pattern_allowed"'],
      ],
      [
        "a scalar pattern list 422s at apply",
        { selected_actions: { patterns_allowed: "docker/*" } },
        ["actions.selected_actions.patterns_allowed"],
      ],
      [
        "an unknown approval policy 422s at apply",
        { fork_pr_contributor_approval: { approval_policy: "everyone" } },
        ["actions.fork_pr_contributor_approval.approval_policy"],
      ],
      [
        "an empty approval object 422s at apply",
        { fork_pr_contributor_approval: {} },
        ["actions.fork_pr_contributor_approval.approval_policy"],
      ],
      [
        "a hyphenated claim key 422s at apply",
        {
          oidc_customization_sub: {
            use_default: false,
            include_claim_keys: ["repo", "job-workflow-ref"],
          },
        },
        [
          "actions.oidc_customization_sub.include_claim_keys[1]: a claim key holds only letters, digits, and underscores " +
            '(such as "repo" or "job_workflow_ref")',
        ],
      ],
      [
        "a repeated claim key 422s at apply",
        {
          oidc_customization_sub: {
            use_default: false,
            include_claim_keys: ["repo", "context", "repo"],
          },
        },
        [
          'actions.oidc_customization_sub.include_claim_keys[2]: "repo" repeats an earlier claim key; GitHub requires the keys to be unique',
        ],
      ],
      [
        "a claim-key list under the default template is ignored by GitHub, so it would never take",
        { oidc_customization_sub: { use_default: true, include_claim_keys: ["repo"] } },
        [
          "actions.oidc_customization_sub.include_claim_keys: GitHub ignores include_claim_keys under use_default: true, " +
            "so the declared list could never take; set use_default: false for a custom template, or remove the list",
        ],
      ],
      [
        "a YAML-quoted use_default is truthy on the wire",
        { oidc_customization_sub: { use_default: "false" } },
        ["actions.oidc_customization_sub.use_default"],
      ],
      [
        "a YAML-quoted use_immutable_subject is truthy on the wire",
        { oidc_customization_sub: { use_default: true, use_immutable_subject: "false" } },
        ["actions.oidc_customization_sub.use_immutable_subject"],
      ],
      [
        "the one toggle the PUT requires is missing: a 422 at apply",
        { fork_pr_workflows_private_repos: { send_secrets_and_variables: false } },
        ["actions.fork_pr_workflows_private_repos.run_workflows_from_fork_pull_requests"],
      ],
      [
        "a YAML-quoted toggle is truthy on the wire",
        { fork_pr_workflows_private_repos: { run_workflows_from_fork_pull_requests: "true" } },
        ["actions.fork_pr_workflows_private_repos.run_workflows_from_fork_pull_requests"],
      ],
    ];
    for (const [reason, actions, rendered] of refused) {
      const error = shapeError({ actions }, "f.yml");
      expect(error, reason).not.toBeNull();
      for (const fragment of rendered) {
        expect(error, reason).toContain(fragment);
      }
    }
    // The control: every rule above leaves a well-formed document alone, its open objects still passing
    // unknown keys through (a base-permissions key GitHub adds, a field on the fork PR policy).
    expect(
      shapeError(
        {
          actions: {
            allowed_actions: "selected",
            sha_pinning_required: true,
            some_added_key: "passes through",
            selected_actions: {
              github_owned_allowed: true,
              verified_allowed: false,
              patterns_allowed: ["docker/*", "octocat/hello-world@v2"],
            },
            artifact_and_log_retention: { days: 30 },
            cache: { max_cache_retention_days: 3, max_cache_size_gb: 25 },
            oidc_customization_sub: {
              use_default: false,
              include_claim_keys: ["repo", "context", "job_workflow_ref"],
            },
            fork_pr_contributor_approval: { approval_policy: "first_time_contributors" },
            fork_pr_workflows_private_repos: {
              run_workflows_from_fork_pull_requests: true,
              extra_field: "passes through",
            },
          },
        },
        "f.yml",
      ),
    ).toBeNull();
  });

  test("the OIDC template is planned verbatim: a reordered claim-key list and a false toggle against a live true are both drift", async () => {
    // The claim-key list leaves the remainder diff, so the false toggle proves the remainder is still compared.
    const reordered = new MockApi({
      [OIDC]: {
        data: {
          use_default: false,
          include_claim_keys: ["context", "repo"],
          use_immutable_subject: true,
        },
      },
    });
    const declared = {
      use_default: false,
      include_claim_keys: ["repo", "context"],
      use_immutable_subject: false,
    };
    const result = await plan(reordered, { oidc_customization_sub: declared });
    expect(result.ops).toEqual([
      {
        role: "putOidcSub",
        payload: declared,
        describe: "customizing the OIDC subject claim",
        drift: [
          "actions.oidc_customization_sub.use_immutable_subject: false != true",
          'actions.oidc_customization_sub.include_claim_keys: declared ["repo","context"] != live ["context","repo"] (claim-key order defines the subject format, so order counts); apply will set the declared value',
        ],
        change: "applied the OIDC subject claim template",
      },
    ]);
    const matching = new MockApi({
      [OIDC]: { data: { use_default: false, include_claim_keys: ["repo", "context"] } },
    });
    const clean = await plan(matching, {
      oidc_customization_sub: { use_default: false, include_claim_keys: ["repo", "context"] },
    });
    expect(clean.ops).toEqual([]);
  });

  test("an omitted claim-key list on a custom template is not compared", async () => {
    // {use_default: false} with no list is the documented opt-in to the ORGANIZATION template, whose keys then appear live, so comparing the omitted
    // list would be permanent false drift.
    const custom = new MockApi({
      [OIDC]: { data: { use_default: false, include_claim_keys: ["repo", "context"] } },
    });
    expect((await plan(custom, { oidc_customization_sub: { use_default: false } })).ops).toEqual(
      [],
    );
  });

  test("a denied fork-pr-private read renders the ambiguity denialHint", async () => {
    // If GitHub denies this pair on a public repository this sentence is the whole mitigation, and denialHint rendering has silently broken once
    // before.
    const api = new MockApi({
      [FORK_PRIVATE]: { error: { status: 403, message: "Forbidden", body: "" } },
    });
    let thrown: unknown;
    try {
      await plan(api, {
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
    expect(deniedDetail(thrown)).toContain("can also mean the repository is public");
  });

  test("a denied OIDC read renders the Actions grant, not the section's Administration", async () => {
    const api = new MockApi({
      [OIDC]: { error: { status: 403, message: "Resource not accessible", body: "" } },
    });
    let thrown: unknown;
    try {
      await plan(api, { oidc_customization_sub: { use_default: true } });
    } catch (error) {
      thrown = error;
    }
    const detail = deniedDetail(thrown);
    // The advice grades by the SECTION's need on the override permission: the OIDC PUT sibling writes with the same Actions permission, so read-only
    // advice would cost a second round trip.
    expect(detail).toContain(grantFor({ repo: ["actions"] }));
    expect(detail).not.toContain('"Administration"');
  });

  test("each fork PR policy object is planned verbatim to its own endpoint, every toggle compared", async () => {
    const api = new MockApi({
      [FORK_APPROVAL]: { data: { approval_policy: "first_time_contributors_new_to_github" } },
      [FORK_PRIVATE]: {
        data: {
          run_workflows_from_fork_pull_requests: false,
          send_write_tokens_to_workflows: true,
          send_secrets_and_variables: true,
          require_approval_for_fork_pr_workflows: false,
        },
      },
    });
    const approval = { approval_policy: "first_time_contributors" as const };
    const privateRepos = {
      run_workflows_from_fork_pull_requests: true,
      send_write_tokens_to_workflows: false,
      send_secrets_and_variables: false,
      require_approval_for_fork_pr_workflows: true,
      extra_field: "rides along",
    };
    const result = await plan(api, {
      fork_pr_contributor_approval: approval,
      fork_pr_workflows_private_repos: privateRepos,
    });
    // Deterministic: both keys sit in the routed table, visited in its order.
    expect(result.ops.map((op) => [op.role, op.payload, op.change])).toEqual([
      ["putForkPrApproval", approval, "applied the fork PR contributor approval policy"],
      ["putForkPrPrivate", privateRepos, "applied the private-repo fork PR workflow settings"],
    ]);
    // Every live value is flipped, so an omitted comparison cannot pass here; the passthrough field
    // drifts as unknown to GitHub, and the note says the PUT would never converge on it.
    expect(result.ops[1]?.drift).toEqual([
      "actions.fork_pr_workflows_private_repos.run_workflows_from_fork_pull_requests: true != false",
      "actions.fork_pr_workflows_private_repos.send_write_tokens_to_workflows: false != true",
      "actions.fork_pr_workflows_private_repos.send_secrets_and_variables: false != true",
      "actions.fork_pr_workflows_private_repos.require_approval_for_fork_pr_workflows: true != false",
      'actions.fork_pr_workflows_private_repos.extra_field: declared "rides along" but the API response has no such field (new or write-only field?)',
    ]);
    // No base-permissions read: these keys alone must not imply enabled: true.
    expect(roles(api)).toEqual([FORK_APPROVAL, FORK_PRIVATE]);
    expect(result.notes).toEqual([
      'actions.fork_pr_workflows_private_repos: declared key "extra_field" does not exist on the live fork PR workflow settings, ' +
        "so if GitHub ignores it this PUT will re-run on every apply without converging. Fix the key name, or remove it from the settings file",
    ]);
  });

  test("a key outside a routed mapping's shape that the GET never echoes is noted as never converging, per mapping", async () => {
    const privateRepos = {
      run_workflows_from_fork_pull_requests: true,
      send_write_tokens_to_workflows: false,
      send_secrets_and_variables: false,
      require_approval_for_fork_pr_workflows: true,
    };
    const api = new MockApi({
      [RETENTION]: { data: { days: 30, maximum_allowed_days: 400 } },
      [OIDC]: { data: { use_default: false, include_claim_keys: ["repo"] } },
      [FORK_APPROVAL]: { data: { approval_policy: "first_time_contributors" } },
      [FORK_PRIVATE]: { data: privateRepos },
    });
    const result = await plan(api, {
      artifact_and_log_retention: { days: 30, retention_days: 30 },
      oidc_customization_sub: {
        use_default: false,
        include_claim_keys: ["repo"],
        claim_prefix: "repo",
      },
      fork_pr_contributor_approval: { approval_policy: "first_time_contributors", policy: "all" },
      fork_pr_workflows_private_repos: { ...privateRepos, send_secret_and_variables: false },
    } as ActionsConfig);
    const tail =
      "so if GitHub ignores it this PUT will re-run on every apply without converging. Fix the key name, or remove it from the settings file";
    expect(result.notes).toEqual([
      `actions.artifact_and_log_retention: declared key "retention_days" does not exist on the live retention window, ${tail}`,
      `actions.oidc_customization_sub: declared key "claim_prefix" does not exist on the live OIDC subject claim template, ${tail}`,
      `actions.fork_pr_contributor_approval: declared key "policy" does not exist on the live approval policy, ${tail}`,
      `actions.fork_pr_workflows_private_repos: declared key "send_secret_and_variables" does not exist on the live fork PR workflow settings, ${tail}`,
    ]);
    // The unknown key is the whole drift of each mapping: every declared value matches live.
    expect(result.ops.map((op) => [op.role, op.drift.length])).toEqual([
      ["putRetention", 1],
      ["putOidcSub", 1],
      ["putForkPrApproval", 1],
      ["putForkPrPrivate", 1],
    ]);
  });

  test("a documented template key the GET omits is drift the PUT resolves, never a note: one PUT, then the re-plan is empty", async () => {
    // use_immutable_subject is optional on GitHub's GET; the three routed mapping GETs mark every
    // field required, so only the template has such a key.
    const api = liveActions({
      "/repos/o/r/actions/oidc/customization/sub": { use_default: true },
    });
    const { first, second, changes } = await provePlanIdempotent(actionsSection, api, {
      oidc_customization_sub: { use_default: true, use_immutable_subject: true },
    });
    expect(first.notes).toEqual([]);
    expect(first.ops.map((op) => op.drift)).toEqual([
      [
        "actions.oidc_customization_sub.use_immutable_subject: declared true but the API response has no such field (new or write-only field?)",
      ],
    ]);
    expect(changes).toEqual(["applied the OIDC subject claim template"]);
    expect(second).toEqual({ ops: [], notes: [], drift: [] });
  });

  test("executing the plan converges: every routed PUT lands once, then nothing", async () => {
    const api = liveActions({
      [BASE]: { enabled: true, allowed_actions: "all" },
      [`${BASE}/workflow`]: {
        default_workflow_permissions: "write",
        can_approve_pull_request_reviews: false,
      },
      [`${BASE}/access`]: { access_level: "none" },
      [`${BASE}/artifact-and-log-retention`]: { days: 90 },
      "/repos/o/r/actions/cache/storage-limit": { max_cache_size_gb: 10 },
      "/repos/o/r/actions/oidc/customization/sub": { use_default: true },
    });
    const { second, changes } = await provePlanIdempotent(actionsSection, api, {
      selected_actions: { github_owned_allowed: true, patterns_allowed: ["docker/*"] },
      default_workflow_permissions: "read",
      access_level: "organization",
      artifact_and_log_retention: { days: 30 },
      cache: { max_cache_size_gb: 25 },
      oidc_customization_sub: { use_default: false, include_claim_keys: ["repo", "context"] },
    });
    expect(changes).toEqual([
      "applied actions permissions",
      "applied workflow token permissions",
      "applied selected-actions policy",
      "applied workflows access level",
      "applied artifact and log retention",
      "applied cache storage limit",
      "applied the OIDC subject claim template",
    ]);
    expect(api.writes).toEqual([
      `PUT ${BASE}`,
      `PUT ${BASE}/workflow`,
      `PUT ${BASE}/selected-actions`,
      `PUT ${BASE}/access`,
      `PUT ${BASE}/artifact-and-log-retention`,
      "PUT /repos/o/r/actions/cache/storage-limit",
      "PUT /repos/o/r/actions/oidc/customization/sub",
    ]);
    expect(second).toEqual({ ops: [], notes: [], drift: [] });
  });

  test("the read port exposes exactly the GET roles; the primary read keeps its denied posture", () => {
    const ctx = planContext(actionsSection, new MockApi({}), REPO);
    expect(Object.keys(ctx.read)).toEqual([
      "getPermissions",
      "getSelected",
      "getWorkflow",
      "getAccess",
      "getRetention",
      "getCacheRetention",
      "getCacheStorage",
      "getOidcSub",
      "getForkPrApproval",
      "getForkPrPrivate",
    ]);
    // @ts-expect-error a write role is not a read: the port has no `putPermissions`
    ctx.read.putPermissions;
    // @ts-expect-error nor a `putSelected`
    ctx.read.putSelected;
    // @ts-expect-error nor the raw client
    ctx.api;
    // @ts-expect-error a "denied" primary read offers no 404-tolerant helper
    ctx.read.getPermissions.probeAbsent;
    // The allowlist probe keeps every helper: its 404/409 mean "no allowlist".
    expect(typeof ctx.read.getSelected.probeAbsent).toBe("function");
  });

  test("a routed key's endpoint pair must share a name, and a scalar key must say how it becomes a body", () => {
    // Compile-time only: a GET paired with another key's PUT, or an enum-valued key PUT bare, never reaches the routing table.
    const live = z.looseObject({ access_level: z.string() });
    type Live = z.infer<typeof live>;
    const paired: ReturnType<typeof endpointRouted<"access_level", "Access", Live>> =
      endpointRouted<"access_level", "Access", Live>({
        get: "getAccess",
        put: "putAccess",
        label: "actions.access",
        applied: "applied",
        body: (value) => ({ access_level: value }),
        live,
        read: () => "none",
      });
    expect(typeof paired.plan).toBe("function");
    endpointRouted<"access_level", "Access", Live>({
      get: "getAccess",
      // @ts-expect-error the PUT must carry the GET's name
      put: "putRetention",
      label: "actions.access",
      applied: "applied",
      body: (value) => ({ access_level: value }),
      live,
      read: () => "none",
    });
    // @ts-expect-error an enum-valued key cannot be PUT bare: body is required
    endpointRouted<"access_level", "Access", Live>({
      get: "getAccess",
      put: "putAccess",
      label: "actions.access",
      applied: "applied",
      live,
      read: () => "none",
    });
  });

  test("a planned operation can only name a declared write role, and must justify itself", () => {
    type Op = PlannedOp<typeof actionsSection.endpoints>;
    const read = { role: "getPermissions", drift: ["x"], change: "" } as const;
    // @ts-expect-error a GET role is a read, not a plannable write
    const _read: Op = read;
    const silent = { role: "putPermissions", drift: [], change: "" } as const;
    // @ts-expect-error a write on a non-alwaysRewrite endpoint must carry drift
    const _silent: Op = silent;
  });
});

describe("actions snapshot", () => {
  const snapshot = async (api: GitHubClient, policy: OnMissingPermission = "fail") =>
    unwrap(await actionsSection.snapshot(snapshotContext(actionsSection, api, REPO, policy)));
  /** The note a sub-read the fake has no body for produces: its 404 classifies as a denial. */
  const leftOut = (key: string, path: string, grant = sectionGrant(actionsSection)) =>
    `actions.${key}: left out of the snapshot - the token was denied GET ${path}: 404 Not Found (a 404 here can also mean the resource does not exist). To fix, ${grant}`;

  test("reads every endpoint back onto its key, dropping the server fields each GET adds", async () => {
    const api = liveActions({
      [BASE]: {
        enabled: true,
        allowed_actions: "selected",
        sha_pinning_required: true,
        selected_actions_url: `https://api.github.com${BASE}/selected-actions`,
      },
      // The allowlist slice is closed, so a key GitHub adds is left out rather than emitted into a
      // document the shape then refuses.
      [`${BASE}/selected-actions`]: {
        github_owned_allowed: true,
        verified_allowed: false,
        patterns_allowed: ["actions/*"],
        future_allowed: true,
      },
      [`${BASE}/workflow`]: {
        default_workflow_permissions: "read",
        can_approve_pull_request_reviews: false,
      },
      [`${BASE}/access`]: { access_level: "organization" },
      [`${BASE}/artifact-and-log-retention`]: { days: 30, maximum_allowed_days: 400 },
      "/repos/o/r/actions/cache/retention-limit": { max_cache_retention_days: 5 },
      "/repos/o/r/actions/cache/storage-limit": { max_cache_size_gb: 20 },
      "/repos/o/r/actions/oidc/customization/sub": {
        use_default: false,
        include_claim_keys: ["repo", "context"],
      },
      [`${BASE}/fork-pr-contributor-approval`]: { approval_policy: "first_time_contributors" },
      [`${BASE}/fork-pr-workflows-private-repos`]: {
        run_workflows_from_fork_pull_requests: true,
        send_write_tokens_to_workflows: false,
        send_secrets_and_variables: false,
        require_approval_for_fork_pr_workflows: true,
      },
    });
    expect(await snapshot(api)).toEqual({
      value: {
        enabled: true,
        allowed_actions: "selected",
        sha_pinning_required: true,
        default_workflow_permissions: "read",
        can_approve_pull_request_reviews: false,
        selected_actions: {
          github_owned_allowed: true,
          verified_allowed: false,
          patterns_allowed: ["actions/*"],
        },
        access_level: "organization",
        artifact_and_log_retention: { days: 30 },
        cache: { max_cache_retention_days: 5, max_cache_size_gb: 20 },
        oidc_customization_sub: { use_default: false, include_claim_keys: ["repo", "context"] },
        fork_pr_contributor_approval: { approval_policy: "first_time_contributors" },
        fork_pr_workflows_private_repos: {
          run_workflows_from_fork_pull_requests: true,
          send_write_tokens_to_workflows: false,
          send_secrets_and_variables: false,
          require_approval_for_fork_pr_workflows: true,
        },
      },
      notes: [],
    });
    expect(api.writes).toEqual([]);
  });

  test("the OIDC template reads back as a document the shape accepts: an inactive or null claim-key list and the prefix fall away", async () => {
    // GitHub keeps reporting the last custom list (and sub_claim_prefix) after a switch back to the default template, and answers null for a list
    // never set; either read back verbatim would be a snapshot the shape itself refuses.
    const cases: [
      live: Record<string, unknown>,
      expected: ActionsConfig["oidc_customization_sub"],
    ][] = [
      [
        {
          use_default: true,
          include_claim_keys: ["repo", "context"],
          sub_claim_prefix: "repo:octocat/hello-world",
        },
        { use_default: true },
      ],
      [{ use_default: false, include_claim_keys: null }, { use_default: false }],
      [
        {
          use_default: false,
          include_claim_keys: ["repo"],
          sub_claim_prefix: "repo:octocat/hello-world",
        },
        { use_default: false, include_claim_keys: ["repo"] },
      ],
    ];
    for (const [live, expected] of cases) {
      const api = liveActions({
        [BASE]: { enabled: true, allowed_actions: "all" },
        [`${BASE}/workflow`]: {
          default_workflow_permissions: "read",
          can_approve_pull_request_reviews: false,
        },
        [`${BASE}/access`]: { access_level: "none" },
        [`${BASE}/artifact-and-log-retention`]: { days: 90, maximum_allowed_days: 400 },
        "/repos/o/r/actions/cache/retention-limit": { max_cache_retention_days: 7 },
        "/repos/o/r/actions/cache/storage-limit": { max_cache_size_gb: 10 },
        "/repos/o/r/actions/oidc/customization/sub": live,
        [`${BASE}/fork-pr-contributor-approval`]: { approval_policy: "first_time_contributors" },
        [`${BASE}/fork-pr-workflows-private-repos`]: {
          run_workflows_from_fork_pull_requests: false,
          send_write_tokens_to_workflows: false,
          send_secrets_and_variables: false,
          require_approval_for_fork_pr_workflows: true,
        },
      });
      const read = await snapshot(api);
      expect(read.notes, JSON.stringify(live)).toEqual([]);
      expect(read.value?.oidc_customization_sub, JSON.stringify(live)).toEqual(expected);
      expect(
        shapeError({ actions: read.value as Record<string, unknown> }, "snapshot.yml"),
        JSON.stringify(live),
      ).toBeNull();
    }
  });

  test("an unset cache limit answering {} is left out of the cache key; the other limit still reads back", async () => {
    const api = liveActions({
      [BASE]: { enabled: true, allowed_actions: "all" },
      [`${BASE}/workflow`]: {
        default_workflow_permissions: "read",
        can_approve_pull_request_reviews: false,
      },
      [`${BASE}/access`]: { access_level: "none" },
      [`${BASE}/artifact-and-log-retention`]: { days: 90, maximum_allowed_days: 400 },
      "/repos/o/r/actions/cache/retention-limit": {},
      "/repos/o/r/actions/cache/storage-limit": { max_cache_size_gb: 20 },
      "/repos/o/r/actions/oidc/customization/sub": { use_default: true },
      [`${BASE}/fork-pr-contributor-approval`]: { approval_policy: "first_time_contributors" },
      [`${BASE}/fork-pr-workflows-private-repos`]: {
        run_workflows_from_fork_pull_requests: false,
        send_write_tokens_to_workflows: false,
        send_secrets_and_variables: false,
        require_approval_for_fork_pr_workflows: true,
      },
    });
    const read = await snapshot(api);
    expect(read.notes).toEqual([]);
    expect(read.value?.cache).toEqual({ max_cache_size_gb: 20 });
  });

  test("under warn, a denied sub-read is a note naming its key with the read's own grant; the allowlist is skipped off the selected policy", async () => {
    const live = liveActions({
      [BASE]: { enabled: true, allowed_actions: "all" },
      [`${BASE}/artifact-and-log-retention`]: { days: 90, maximum_allowed_days: 400 },
      "/repos/o/r/actions/cache/retention-limit": { max_cache_retention_days: 7 },
      "/repos/o/r/actions/cache/storage-limit": { max_cache_size_gb: 10 },
      [`${BASE}/fork-pr-contributor-approval`]: { approval_policy: "all_external_contributors" },
    });
    const requested: string[] = [];
    const api: GitHubClient = {
      tryRequest: (method, path, payload) => {
        requested.push(`${method} ${path}`);
        return live.tryRequest(method, path, payload);
      },
      tryGraphql: live.tryGraphql,
    };
    const read = await snapshot(api, "warn");
    expect(read).toEqual({
      value: {
        enabled: true,
        allowed_actions: "all",
        artifact_and_log_retention: { days: 90 },
        cache: { max_cache_retention_days: 7, max_cache_size_gb: 10 },
        fork_pr_contributor_approval: { approval_policy: "all_external_contributors" },
      },
      notes: [
        leftOut(
          "default_workflow_permissions/can_approve_pull_request_reviews",
          `${BASE}/workflow`,
        ),
        leftOut("access_level", `${BASE}/access`),
        leftOut(
          "oidc_customization_sub",
          "/repos/o/r/actions/oidc/customization/sub",
          grantFor({ repo: ["actions"] }, undefined, "write"),
        ),
        `${leftOut("fork_pr_workflows_private_repos", `${BASE}/fork-pr-workflows-private-repos`)}. Note: the fork PR workflow settings are documented for private repositories, so a denial here can also mean the repository is public`,
      ],
    });
    // Off the "selected" policy there is no allowlist to read, so the GET is never issued.
    expect(requested).not.toContain(`GET ${BASE}/selected-actions`);
    expect(live.writes).toEqual([]);
  });

  test("under warn, a denied cache limit is noted by its own key while the readable sibling limit survives", async () => {
    const api = liveActions({
      [BASE]: { enabled: true, allowed_actions: "all" },
      [`${BASE}/workflow`]: {
        default_workflow_permissions: "read",
        can_approve_pull_request_reviews: false,
      },
      [`${BASE}/access`]: { access_level: "none" },
      [`${BASE}/artifact-and-log-retention`]: { days: 90 },
      "/repos/o/r/actions/cache/retention-limit": { max_cache_retention_days: 7 },
      "/repos/o/r/actions/oidc/customization/sub": { use_default: true },
      [`${BASE}/fork-pr-contributor-approval`]: { approval_policy: "first_time_contributors" },
      [`${BASE}/fork-pr-workflows-private-repos`]: {
        run_workflows_from_fork_pull_requests: false,
        send_write_tokens_to_workflows: false,
        send_secrets_and_variables: false,
        require_approval_for_fork_pr_workflows: true,
      },
    });
    const read = await snapshot(api, "warn");
    expect(read.value?.cache).toEqual({ max_cache_retention_days: 7 });
    expect(read.notes).toEqual([
      leftOut("cache.max_cache_size_gb", "/repos/o/r/actions/cache/storage-limit"),
    ]);
  });

  test("under fail, a denied sub-read fails the section with that read's own grant advice, never a note", async () => {
    // Every key but the OIDC template reads back, so the one denial is the sub-read's alone.
    const api = liveActions({
      [BASE]: { enabled: true, allowed_actions: "all" },
      [`${BASE}/workflow`]: {
        default_workflow_permissions: "read",
        can_approve_pull_request_reviews: false,
      },
      [`${BASE}/access`]: { access_level: "none" },
      [`${BASE}/artifact-and-log-retention`]: { days: 90 },
      "/repos/o/r/actions/cache/retention-limit": { max_cache_retention_days: 7 },
      "/repos/o/r/actions/cache/storage-limit": { max_cache_size_gb: 10 },
      [`${BASE}/fork-pr-contributor-approval`]: { approval_policy: "first_time_contributors" },
      [`${BASE}/fork-pr-workflows-private-repos`]: {
        run_workflows_from_fork_pull_requests: false,
        send_write_tokens_to_workflows: false,
        send_secrets_and_variables: false,
        require_approval_for_fork_pr_workflows: true,
      },
    });
    let thrown: unknown;
    try {
      await snapshot(api, "fail");
    } catch (error) {
      thrown = error;
    }
    expect(deniedDetail(thrown)).toBe(
      `the token was denied GET /repos/o/r/actions/oidc/customization/sub: 404 Not Found (a 404 here can also mean the resource does not exist). To fix, ${grantFor({ repo: ["actions"] }, undefined, "write")}`,
    );
    // The control: under warn the same fixture reads back with the denial as its one note.
    const noted = await snapshot(api, "warn");
    expect(noted.value).not.toHaveProperty("oidc_customization_sub");
    expect(noted.notes).toEqual([
      leftOut(
        "oidc_customization_sub",
        "/repos/o/r/actions/oidc/customization/sub",
        grantFor({ repo: ["actions"] }, undefined, "write"),
      ),
    ]);
  });
});
