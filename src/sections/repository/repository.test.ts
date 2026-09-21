import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { executePlan } from "../../../src/engine/execute.js";
import type { GitHubClient } from "../../../src/github/api.js";
import {
  type OnMissingPermission,
  type PlannedOp,
  planContext,
  snapshotContext,
} from "../../../src/sections/contract/plan.js";
import { MockApi } from "../../../test/mock-api.js";
import { provePlanIdempotent } from "../../../test/sections/plan-idempotence.js";
import { REPO } from "../../../test/sections/section-run.js";
import { validateSectionShapes } from "../../engine/validate.js";
import { describeProblem } from "../../problem.js";
import { PermissionDenied } from "../contract/errors.js";
import { sectionGrant } from "../contract/module.js";
import { FEATURE_TOGGLES, repositorySection } from "./index.js";
import { normalizeTopics, PATCH_FIELDS, RepositoryConfig } from "./schema.js";

function shapeError(doc: Record<string, unknown>, sourceLabel: string): string | null {
  return validateSectionShapes(doc, sourceLabel).match(() => null, describeProblem);
}

const GET = "GET /repos/o/r";
const TOOLS = { resolveSecret: () => "" };

type Desired = Parameters<typeof repositorySection.plan>[1];

const plan = (api: GitHubClient, desired: Desired) =>
  repositorySection.plan(planContext(repositorySection, api, REPO), desired);

/** Plan against `api`, then execute the plan against it: what apply would do. */
async function apply(api: GitHubClient, desired: Desired) {
  return executePlan(await plan(api, desired), repositorySection, api, REPO, TOOLS);
}

/** The rejection must be a PermissionDenied CARRYING the section's grant advice. */
function expectAdministrationDenied(thrown: unknown): void {
  expect(thrown).toBeInstanceOf(PermissionDenied);
  expect((thrown as PermissionDenied).detail).toContain(
    'grant "Administration" (read and write) under the PAT\'s Repository permissions',
  );
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a rejection");
}

const features = (overrides?: Record<string, unknown>) => ({
  "GRAPHQL RepositoryFeatures": {
    data: {
      repository: {
        id: "R_node",
        hasSponsorshipsEnabled: false,
        issueCreationPolicy: "ALL",
        ...overrides,
      },
    },
  },
});

const echo = (fields: Record<string, unknown>) => ({
  "GRAPHQL UpdateRepositoryFeatures": { data: { updateRepository: { repository: fields } } },
});

/** A stateful fake of the repository API: each toggle GET answers as GitHub does, and the write-only LFS pair is stored nowhere. */
function liveRepo(seed: {
  repo?: Record<string, unknown>;
  toggles?: Record<string, boolean>;
  features?: { hasSponsorshipsEnabled: boolean; issueCreationPolicy: string };
}): GitHubClient & { writes: string[] } {
  const repo: Record<string, unknown> = { topics: [], ...seed.repo };
  const toggles: Record<string, boolean> = { ...seed.toggles };
  const feature = seed.features ?? { hasSponsorshipsEnabled: false, issueCreationPolicy: "ALL" };
  const off = { error: { status: 404, message: "Not Found", body: "" } } as const;
  return {
    writes: [],
    async tryRequest(method, path, payload) {
      const body = payload as Record<string, unknown>;
      if (method !== "GET") {
        this.writes.push(`${method} ${path}`);
      }
      if (path === "/repos/o/r") {
        if (method === "PATCH") {
          Object.assign(repo, body);
        }
        return { data: repo };
      }
      if (path === "/repos/o/r/topics") {
        repo.topics = body.names;
        return { data: { names: repo.topics } };
      }
      const feature = path.slice("/repos/o/r/".length);
      if (method === "PUT" || method === "DELETE") {
        toggles[feature] = method === "PUT";
        return { data: null };
      }
      const enabled = toggles[feature] === true;
      switch (feature) {
        case "vulnerability-alerts":
          return enabled ? { data: null } : off;
        case "automated-security-fixes":
          return enabled ? { data: { enabled: true, paused: false } } : off;
        case "private-vulnerability-reporting":
          return { data: { enabled } };
        case "immutable-releases":
          return enabled ? { data: { enabled: true, enforced_by_owner: false } } : off;
        default:
          return off;
      }
    },
    async tryGraphql(op, variables) {
      if (op.name === "RepositoryFeatures") {
        return { data: { repository: { id: "R_node", ...feature } } };
      }
      this.writes.push(`GRAPHQL ${op.name}`);
      const { hasSponsorshipsEnabled, issueCreationPolicy } = variables as Partial<typeof feature>;
      if (hasSponsorshipsEnabled !== undefined) {
        feature.hasSponsorshipsEnabled = hasSponsorshipsEnabled;
      }
      if (issueCreationPolicy !== undefined) {
        feature.issueCreationPolicy = issueCreationPolicy;
      }
      return { data: { updateRepository: { repository: { ...feature } } } };
    },
  };
}

describe("normalizeTopics", () => {
  test.each([
    [
      "a comma string",
      "Copier, template ,GitHub-Actions",
      ["copier", "template", "github-actions"],
    ],
    ["an array, deduped", ["A", "a", "b"], ["a", "b"]],
  ])("lowercases and dedupes %s", (_what, raw, expected) => {
    expect(normalizeTopics(raw)).toEqual(expected);
  });
});

describe("repository", () => {
  test("splits specials onto their endpoints, each write justified by its own drift", async () => {
    const api = new MockApi({
      [GET]: { data: { description: "old", topics: ["a"] } },
      "GET /repos/o/r/automated-security-fixes": { data: { enabled: true } },
    }); // GET vulnerability-alerts 404s: off
    const result = await plan(api, {
      description: "d",
      topics: "A, b",
      enable_vulnerability_alerts: true,
      enable_automated_security_fixes: false,
    });
    expect(result.ops.map((op) => [op.role, op.payload, op.drift, op.change])).toEqual([
      [
        "update",
        { description: "d" },
        ['repository.description: "d" != "old"'],
        "patched repository fields: description",
      ],
      ["topics", { names: ["a", "b"] }, ['repository.topics: missing "b"'], "set topics: a, b"],
      [
        "vulnerabilityAlertsPut",
        undefined,
        [
          "repository.enable_vulnerability_alerts: declared true != live false; apply will set the declared value",
        ],
        "vulnerability alerts: enabled",
      ],
      [
        "automatedSecurityFixesRemove",
        undefined,
        [
          "repository.enable_automated_security_fixes: declared false != live true; apply will set the declared value",
        ],
        "automated security fixes: disabled",
      ],
    ]);
    expect(result.notes).toEqual([]);
    // Planning reads and never writes; no GraphQL without a routed key.
    expect(api.mutations()).toEqual([]);
    expect(api.calls.map((c) => c.method)).toEqual(["GET", "GET", "GET"]);
  });

  test("a declared field the repository GET does not return is noted as a phantom key", async () => {
    // The PATCH is diff-gated, so such a key would re-PATCH on every apply without converging.
    const api = new MockApi({ [GET]: { data: { description: "d" } } });
    const result = await plan(api, { description: "d", extra_field: "x" });
    expect(result.notes).toEqual([
      'repository: declared key "extra_field" does not exist on the live repository, so if GitHub ignores it this PATCH will re-run on every apply without converging. Fix the key name, or remove it from the settings file',
    ]);
    expect(result.ops.map((op) => op.role)).toEqual(["update"]);
  });

  test.each([
    ["vulnerability-alerts", { enabled: true }],
    ["automated-security-fixes", null],
    ["automated-security-fixes", {}],
    ["private-vulnerability-reporting", { enabled: "yes" }],
    ["immutable-releases", []],
  ] as const)(
    "a toggle GET body off the documented shape fails loudly (%s: %p)",
    async (feature, body) => {
      // Neither a definite on nor a definite off may be read off a body the contract does not document, since either would drive a write.
      const key = {
        "vulnerability-alerts": "enable_vulnerability_alerts",
        "automated-security-fixes": "enable_automated_security_fixes",
        "private-vulnerability-reporting": "enable_private_vulnerability_reporting",
        "immutable-releases": "enable_immutable_releases",
      }[feature];
      const api = new MockApi({
        [GET]: { data: {} },
        [`GET /repos/o/r/${feature}`]: { data: body },
      });
      await expect(plan(api, { [key]: true })).rejects.toThrow(
        new RegExp(
          `repository: GET /repos/\\{owner\\}/\\{repo\\}/${feature} returned a body outside the documented shape`,
        ),
      );
    },
  );

  test("a matching repository plans nothing", async () => {
    const api = new MockApi({
      [GET]: { data: { description: "d", topics: ["b", "a"] } },
      "GET /repos/o/r/vulnerability-alerts": { data: null },
    });
    const result = await plan(api, {
      description: "d",
      topics: ["a", "b"],
      enable_vulnerability_alerts: true,
    });
    expect(result).toEqual({ ops: [], notes: [], drift: [] });
  });

  test("permission errors surface as PermissionDenied with the grant advice, at plan and at apply", async () => {
    const denied = new MockApi({
      [GET]: { error: { status: 403, message: "Resource not accessible", body: "" } },
    });
    expectAdministrationDenied(await rejection(plan(denied, { description: "d" })));
    const refused = new MockApi({
      [GET]: { data: {} },
      "PATCH /repos/o/r": { error: { status: 403, message: "Resource not accessible", body: "" } },
    });
    const execution = await apply(refused, { description: "d" });
    expect(execution.status).toBe("failed");
    expectAdministrationDenied((execution as { error: unknown }).error);
  });

  /**
   * Every toggle's endpoint pair, spelled out so a swapped production role fails here instead of being read back as the expectation; `enabledBody` is
   * the GET's answer when the feature is on (LFS has none).
   */
  const TOGGLE_CASES = [
    ["enable_vulnerability_alerts", "vulnerability alerts", "vulnerability-alerts", null],
    [
      "enable_automated_security_fixes",
      "automated security fixes",
      "automated-security-fixes",
      { enabled: true },
    ],
    [
      "enable_private_vulnerability_reporting",
      "private vulnerability reporting",
      "private-vulnerability-reporting",
      { enabled: true },
    ],
    [
      "enable_immutable_releases",
      "immutable releases",
      "immutable-releases",
      { enabled: true, enforced_by_owner: false },
    ],
    ["enable_git_lfs", "Git LFS", "lfs", undefined],
  ] as const;

  test("the toggle table names every case above and nothing else", () => {
    expect(FEATURE_TOGGLES.map((toggle) => toggle.key).sort()).toEqual(
      TOGGLE_CASES.map(([key]) => key).sort(),
    );
  });

  test.each(TOGGLE_CASES)(
    "%s toggles its own endpoint: PUT on true, DELETE on false, never in the PATCH",
    async (key, label, feature, enabledBody) => {
      // Readable toggles start opposite each declaration and LFS has no live state, so every direction plans its write; the exact-mutations assertion
      // proves no toggle leaks into the PATCH.
      const path = `/repos/o/r/${feature}`;
      const on = new MockApi({ [GET]: { data: {} } }).allowMutations(`PUT ${path}`);
      const enabled = await apply(on, { [key]: true });
      expect(on.mutations().map((m) => `${m.method} ${m.path}`)).toEqual([`PUT ${path}`]);
      expect(enabled).toEqual({
        status: "applied",
        changes: [`${label}: enabled`],
        notes: [],
        landed: 1,
      });
      const off = new MockApi({
        [GET]: { data: {} },
        ...(enabledBody === undefined ? {} : { [`GET ${path}`]: { data: enabledBody } }),
      }).allowMutations(`DELETE ${path}`);
      const disabled = await apply(off, { [key]: false });
      expect(off.mutations().map((m) => `${m.method} ${m.path}`)).toEqual([`DELETE ${path}`]);
      expect(disabled.changes).toEqual([`${label}: disabled`]);
    },
  );

  test.each([
    [
      "a 404 on the private vulnerability reporting DELETE",
      { enable_private_vulnerability_reporting: false },
      { "GET /repos/o/r/private-vulnerability-reporting": { data: { enabled: true } } },
      "DELETE /repos/o/r/private-vulnerability-reporting",
      404,
      "repository.enable_private_vulnerability_reporting: the feature is not applicable, so it is already off, so nothing changed (404)",
    ],
    [
      "a 422 on the private vulnerability reporting DELETE",
      { enable_private_vulnerability_reporting: false },
      { "GET /repos/o/r/private-vulnerability-reporting": { data: { enabled: true } } },
      "DELETE /repos/o/r/private-vulnerability-reporting",
      422,
      "repository.enable_private_vulnerability_reporting: the feature is not applicable, so it is already off, so nothing changed (422)",
    ],
    [
      "a 409 on the immutable releases PUT",
      { enable_immutable_releases: true },
      {},
      "PUT /repos/o/r/immutable-releases",
      409,
      "repository.enable_immutable_releases: the repository owner enforces immutable releases, so apply cannot change it from the repository (409)",
    ],
    [
      "a 409 on the immutable releases DELETE",
      { enable_immutable_releases: false },
      {
        "GET /repos/o/r/immutable-releases": { data: { enabled: true, enforced_by_owner: true } },
      },
      "DELETE /repos/o/r/immutable-releases",
      409,
      "repository.enable_immutable_releases: the repository owner enforces immutable releases, so apply cannot change it from the repository (409)",
    ],
  ] as const)(
    "%s is a note, never a change line",
    async (_what, desired, live, write, status, note) => {
      const api = new MockApi({
        [GET]: { data: {} },
        ...live,
        [write]: { error: { status, message: "Nope", body: "" } },
      });
      expect(await apply(api, desired)).toEqual({
        status: "applied",
        changes: [],
        notes: [note],
        landed: 0,
      });
    },
  );

  test("private vulnerability reporting reads the {enabled} body; probe errors are not swallowed", async () => {
    const api = new MockApi({
      [GET]: { data: {} },
      "GET /repos/o/r/private-vulnerability-reporting": { data: { enabled: false } },
    });
    const result = await plan(api, { enable_private_vulnerability_reporting: true });
    expect(result.ops.map((op) => [op.role, op.drift])).toEqual([
      [
        "privateVulnerabilityReportingPut",
        [
          "repository.enable_private_vulnerability_reporting: declared true != live false; apply will set the declared value",
        ],
      ],
    ]);
    const denied = new MockApi({
      [GET]: { data: {} },
      "GET /repos/o/r/private-vulnerability-reporting": {
        error: { status: 403, message: "Forbidden", body: "" },
      },
    });
    expectAdministrationDenied(
      await rejection(plan(denied, { enable_private_vulnerability_reporting: true })),
    );
  });

  test.each([404, 422])(
    "a %i on the private vulnerability reporting probe reads as not applicable, so off",
    async (status) => {
      // A repo where the feature does not apply (private repos): a matching declared false is clean, a declared true is drift with the PUT due.
      const check = new MockApi({
        [GET]: { data: {} },
        "GET /repos/o/r/private-vulnerability-reporting": {
          error: { status, message: "Not applicable", body: "" },
        },
      });
      expect((await plan(check, { enable_private_vulnerability_reporting: false })).ops).toEqual(
        [],
      );
      const on = await plan(check, { enable_private_vulnerability_reporting: true });
      expect(on.ops.map((op) => [op.role, op.drift])).toEqual([
        [
          "privateVulnerabilityReportingPut",
          [
            "repository.enable_private_vulnerability_reporting: declared true != live false; apply will set the declared value",
          ],
        ],
      ]);
    },
  );

  test("non-boolean security toggles are rejected by upfront shape validation with the YAML hint", () => {
    const error = shapeError({ repository: { enable_vulnerability_alerts: "no" } }, "f.yml");
    expect(error).toContain("repository.enable_vulnerability_alerts");
    expect(error).toContain("not a boolean");
    expect(error).toContain('"no"');
  });

  test("git LFS: the cannot-verify note, no drift, an always-rewrite operation, no requests beyond the GET", async () => {
    const api = new MockApi({ [GET]: { data: {} } });
    const result = await plan(api, { enable_git_lfs: true });
    expect(result).toEqual({
      ops: [{ role: "lfsPut", drift: [], change: "Git LFS: enabled" }],
      notes: [
        "repository.enable_git_lfs: GitHub exposes no endpoint to read this state back, so check mode cannot verify it; apply re-asserts the declared value (true) on every run",
      ],
      drift: [],
    });
    expect(api.calls.map((c) => `${c.method} ${c.path}`)).toEqual([GET]);
  });

  test("non-boolean git LFS values hit the shared toggle shape, booleans pass", () => {
    const error = shapeError({ repository: { enable_git_lfs: "yes" } }, "f.yml");
    expect(error).toContain("repository.enable_git_lfs");
    expect(error).toContain("not a boolean");
    // The section stays loose otherwise: booleans and passthrough keys pass.
    expect(
      shapeError({ repository: { enable_git_lfs: true, extra_field: "x" } }, "f.yml"),
    ).toBeNull();
  });

  test("a cyclic toggle value is rejected with a message, never a formatter throw", () => {
    // A YAML alias cycle (enable_git_lfs: &v { self: *v }) reaches the shape as a self-referential object; the error text must be built without
    // JSON.stringify on it, or validation itself would die.
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const error = shapeError({ repository: { enable_git_lfs: cyclic } }, "f.yml");
    expect(error).toContain("repository.enable_git_lfs");
    expect(error).toContain("a mapping is not a boolean");
  });

  test("the section accepts plain mappings only, like the record shape always did", () => {
    // A YAML !!timestamp document parses to a Date, which zod's object schemas would accept as an empty mapping.
    expect(shapeError({ repository: new Date("2020-01-01") }, "f.yml")).toContain("repository");
    expect(shapeError({ repository: [1, 2] }, "f.yml")).toContain("repository");
  });

  test("immutable releases reads the {enabled} body, treats 404 as off, and names owner enforcement", async () => {
    const liveOn = new MockApi({
      [GET]: { data: {} },
      "GET /repos/o/r/immutable-releases": { data: { enabled: true, enforced_by_owner: false } },
    });
    const drift = await plan(liveOn, { enable_immutable_releases: false });
    expect(drift.ops.map((op) => [op.role, op.drift])).toEqual([
      [
        "immutableReleasesRemove",
        [
          "repository.enable_immutable_releases: declared false != live true; apply will set the declared value",
        ],
      ],
    ]);
    const liveOff = new MockApi({
      [GET]: { data: {} },
      "GET /repos/o/r/immutable-releases": {
        error: { status: 404, message: "Not Found", body: "" },
      },
    });
    expect((await plan(liveOff, { enable_immutable_releases: true })).ops[0]?.drift).toEqual([
      "repository.enable_immutable_releases: declared true != live false; apply will set the declared value",
    ]);
    expect((await plan(liveOff, { enable_immutable_releases: false })).ops).toEqual([]);
    // The write is still planned under enforcement; its 409 is covered by the tolerated-status cases.
    const enforced = new MockApi({
      [GET]: { data: {} },
      "GET /repos/o/r/immutable-releases": { data: { enabled: true, enforced_by_owner: true } },
    });
    const planned = await plan(enforced, { enable_immutable_releases: false });
    expect(planned.ops.map((op) => [op.role, op.drift])).toEqual([
      [
        "immutableReleasesRemove",
        [
          "repository.enable_immutable_releases: declared false != live true; the repository owner enforces immutable releases, so apply cannot change it from the repository",
        ],
      ],
    ]);
    expect((await plan(enforced, { enable_immutable_releases: true })).ops).toEqual([]);
  });

  test("executing the plan converges: every drifted write lands once, the LFS re-assertion recurs", async () => {
    const api = liveRepo({
      repo: { description: "old", has_issues: true },
      toggles: { "automated-security-fixes": true },
    });
    const { first, second, changes } = await provePlanIdempotent(repositorySection, api, {
      description: "d",
      has_issues: false,
      topics: ["Automation", "governance"],
      enable_vulnerability_alerts: true,
      enable_automated_security_fixes: false,
      enable_git_lfs: true,
      enable_sponsorships: true,
      issue_creation_policy: "collaborators_only",
    });
    expect(changes).toEqual([
      "patched repository fields: description, has_issues",
      "set topics: automation, governance",
      "vulnerability alerts: enabled",
      "automated security fixes: disabled",
      "Git LFS: enabled",
      "sponsor button: enabled",
      "issue creation policy: collaborators_only",
    ]);
    expect(first.ops.map((op) => op.role)).toEqual([
      "update",
      "topics",
      "vulnerabilityAlertsPut",
      "automatedSecurityFixesRemove",
      "lfsPut",
      "updateFeatures",
    ]);
    expect(second.ops.map((op) => op.role)).toEqual(["lfsPut"]);
    expect(second.notes).toEqual(first.notes);
    // provePlanIdempotent executes the converged plan too, hence the second LFS PUT.
    expect(api.writes).toEqual([
      "PATCH /repos/o/r",
      "PUT /repos/o/r/topics",
      "PUT /repos/o/r/vulnerability-alerts",
      "DELETE /repos/o/r/automated-security-fixes",
      "PUT /repos/o/r/lfs",
      "GRAPHQL UpdateRepositoryFeatures",
      "PUT /repos/o/r/lfs",
    ]);
  });

  test("the read port exposes the repo GET, the four toggle probes, and the features query", () => {
    const ctx = planContext(repositorySection, new MockApi({}), REPO);
    expect(Object.keys(ctx.read)).toEqual([
      "get",
      "vulnerabilityAlertsGet",
      "automatedSecurityFixesGet",
      "privateVulnerabilityReportingGet",
      "immutableReleasesGet",
      "featuresQuery",
    ]);
    // @ts-expect-error a write role is not a read: the port has no `update`
    ctx.read.update;
    // @ts-expect-error nor a `topics`
    ctx.read.topics;
    // @ts-expect-error nor the mutation
    ctx.read.updateFeatures;
    // @ts-expect-error nor the raw client
    ctx.api;
    // @ts-expect-error a "denied" primary read offers no 404-tolerant helper
    ctx.read.get.probeAbsent;
    // A toggle probe keeps probeAbsent: its 404 means "not enabled".
    expect(typeof ctx.read.immutableReleasesGet.probeAbsent).toBe("function");
  });

  test("a planned operation can only name a declared write, driftless only when alwaysRewrite", () => {
    type Op = PlannedOp<typeof repositorySection.endpoints, typeof repositorySection.graphql>;
    const read = { role: "get", drift: ["x"], change: "" } as const;
    // @ts-expect-error the repo GET is a read, not a plannable write
    const _read: Op = read;
    const query = {
      role: "featuresQuery",
      variables: { owner: "o", repo: "r" },
      drift: ["x"],
      change: "",
    } as const;
    // @ts-expect-error the features query is a read, not a plannable write
    const _query: Op = query;
    const silent = { role: "vulnerabilityAlertsPut", drift: [], change: "" } as const;
    // @ts-expect-error a readable toggle's write must carry drift
    const _silent: Op = silent;
    const lfs: Op = { role: "lfsRemove", drift: [], change: "Git LFS: disabled" };
    expect(lfs.drift).toEqual([]);
    const badVariables = {
      role: "updateFeatures",
      variables: { repositoryId: "R", issueCreationPolicy: "everyone" },
      drift: ["x"],
      change: "",
    } as const;
    // @ts-expect-error the mutation's variables are typed by its declaration
    const _badVariables: Op = badVariables;
  });
});

describe("repository GraphQL-routed keys", () => {
  test("mutates only on divergence, carrying the declared fields and the node id, and reports the echoed state", async () => {
    const api = new MockApi({
      [GET]: { data: {} },
      ...features(),
      ...echo({ hasSponsorshipsEnabled: true, issueCreationPolicy: "COLLABORATORS_ONLY" }),
    });
    const planned = await plan(api, {
      enable_sponsorships: true,
      issue_creation_policy: "collaborators_only",
    });
    expect(planned.ops.map((op) => [op.role, op.variables, op.drift])).toEqual([
      [
        "updateFeatures",
        {
          repositoryId: "R_node",
          hasSponsorshipsEnabled: true,
          issueCreationPolicy: "COLLABORATORS_ONLY",
        },
        [
          "repository.enable_sponsorships: declared true != live false; apply will set the declared value",
          "repository.issue_creation_policy: declared collaborators_only != live all; apply will set the declared value",
        ],
      ],
    ]);
    const execution = await executePlan(planned, repositorySection, api, REPO, TOOLS);
    expect(execution).toEqual({
      status: "applied",
      changes: ["sponsor button: enabled", "issue creation policy: collaborators_only"],
      notes: [],
      landed: 1,
    });
    expect(api.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      GET,
      "GRAPHQL RepositoryFeatures",
      "GRAPHQL UpdateRepositoryFeatures",
    ]);
  });

  test("partial divergence: the mutation and the change lines carry only the diverged key", async () => {
    const api = new MockApi({
      [GET]: { data: {} },
      ...features({ hasSponsorshipsEnabled: true }),
      ...echo({ hasSponsorshipsEnabled: true, issueCreationPolicy: "COLLABORATORS_ONLY" }),
    });
    const execution = await apply(api, {
      enable_sponsorships: true,
      issue_creation_policy: "collaborators_only",
    });
    expect(api.mutations()[0]?.payload).toEqual({
      repositoryId: "R_node",
      issueCreationPolicy: "COLLABORATORS_ONLY",
    });
    expect(execution.changes).toEqual(["issue creation policy: collaborators_only"]);
  });

  test("a converged repo issues the read but no mutation", async () => {
    const api = new MockApi({
      [GET]: { data: {} },
      ...features({ hasSponsorshipsEnabled: true, issueCreationPolicy: "COLLABORATORS_ONLY" }),
    });
    const result = await plan(api, {
      enable_sponsorships: true,
      issue_creation_policy: "collaborators_only",
    });
    expect(result.ops).toEqual([]);
    expect(api.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      GET,
      "GRAPHQL RepositoryFeatures",
    ]);
  });

  test("an echo reporting the old value, or no echo at all, fails the write loudly after it landed", async () => {
    // "Accepted but silently ignored" is the REST failure mode that forced these keys onto GraphQL; the mutation's echoed post-state is the guard.
    const stale = new MockApi({
      [GET]: { data: {} },
      ...features(),
      ...echo({ hasSponsorshipsEnabled: false }),
    });
    const execution = await apply(stale, { enable_sponsorships: true });
    expect(execution.status).toBe("failed");
    expect(String((execution as { error: unknown }).error)).toContain("the write did not take");
    expect(stale.mutations()).toHaveLength(1);
    const silent = new MockApi({
      [GET]: { data: {} },
      ...features(),
      "GRAPHQL UpdateRepositoryFeatures": { data: { updateRepository: {} } },
    });
    const unverified = await apply(silent, { enable_sponsorships: true });
    expect(String((unverified as { error: unknown }).error)).toContain(
      "returned no repository echo",
    );
  });

  test("neither key declared means zero GraphQL calls; both are stripped from the base PATCH", async () => {
    const rest = new MockApi({ [GET]: { data: {} } });
    await plan(rest, { has_issues: true });
    expect(rest.calls.map((c) => c.method)).toEqual(["GET"]);
    const both = new MockApi({ [GET]: { data: {} }, ...features() });
    const result = await plan(both, {
      description: "d",
      enable_sponsorships: true,
      issue_creation_policy: "all",
    });
    expect(result.ops.map((op) => [op.role, op.payload])).toEqual([
      ["update", { description: "d" }],
      ["updateFeatures", undefined],
    ]);
  });

  test("a features response without a repository id fails loudly", async () => {
    const api = new MockApi({
      [GET]: { data: {} },
      "GRAPHQL RepositoryFeatures": { data: { repository: null } },
    });
    await expect(plan(api, { enable_sponsorships: true })).rejects.toThrow(
      "returned no repository object with an id",
    );
  });

  test("an unreadable value on a DECLARED key fails loudly instead of folding to a default", async () => {
    // A null issueCreationPolicy (the SDL marks the field nullable) or a non-boolean sponsorship flag must never fold to "all"/false: that could
    // report a clean check against state the section does not understand.
    const nullPolicy = new MockApi({
      [GET]: { data: {} },
      ...features({ issueCreationPolicy: null }),
    });
    await expect(plan(nullPolicy, { issue_creation_policy: "all" })).rejects.toThrow(
      "GitHub reported no issue creation policy",
    );
    const unknownEnum = new MockApi({
      [GET]: { data: {} },
      ...features({ issueCreationPolicy: "MAINTAINERS_ONLY" }),
    });
    await expect(plan(unknownEnum, { issue_creation_policy: "all" })).rejects.toThrow(
      "MAINTAINERS_ONLY",
    );
    // A flag off its wire type never reaches the decoder: the read port refuses the body.
    const stringFlag = new MockApi({
      [GET]: { data: {} },
      ...features({ hasSponsorshipsEnabled: "yes" }),
    });
    await expect(plan(stringFlag, { enable_sponsorships: true })).rejects.toThrow(
      "repository: GRAPHQL RepositoryFeatures returned a body outside the documented shape - repository.hasSponsorshipsEnabled: Invalid input: expected boolean, received string",
    );
  });

  test("an unreadable value on an UNDECLARED key never fails the run", async () => {
    // The strictness is scoped to declared keys: a null policy (SDL-nullable) must not fail a run that only declared the sponsor button.
    const api = new MockApi({
      [GET]: { data: {} },
      ...features({ hasSponsorshipsEnabled: true, issueCreationPolicy: null }),
    });
    expect(await plan(api, { enable_sponsorships: true })).toEqual({
      ops: [],
      notes: [],
      drift: [],
    });
  });

  test("a GraphQL FORBIDDEN on the read surfaces as PermissionDenied", async () => {
    const api = new MockApi({
      [GET]: { data: {} },
      "GRAPHQL RepositoryFeatures": {
        error: {
          status: 403,
          message: "Resource not accessible",
          body: "",
          graphqlTypes: ["FORBIDDEN"],
        },
      },
    });
    expectAdministrationDenied(await rejection(plan(api, { enable_sponsorships: true })));
  });

  test("a non-boolean enable_sponsorships is rejected upfront with the YAML hint", () => {
    const error = shapeError({ repository: { enable_sponsorships: "yes" } }, "f.yml");
    expect(error).toContain("repository.enable_sponsorships");
    expect(error).toContain("not a boolean");
  });

  test("an unrecognized issue_creation_policy is rejected upfront naming the vocabulary", () => {
    const error = shapeError({ repository: { issue_creation_policy: "everyone" } }, "f.yml");
    expect(error).toContain("repository.issue_creation_policy");
    expect(error).toContain('"collaborators_only"');
    expect(shapeError({ repository: { issue_creation_policy: "all" } }, "f.yml")).toBeNull();
  });

  test("prototype-chain property names never pass the policy vocabulary", () => {
    // `"constructor" in ISSUE_CREATION_POLICIES` is true via the prototype chain, so the vocabulary check must be an own-property check or these
    // would map to garbage at the GraphQL boundary.
    for (const name of ["constructor", "toString", "__proto__"]) {
      expect(
        shapeError({ repository: { issue_creation_policy: name } }, "f.yml"),
        `"${name}" must be rejected`,
      ).toContain("repository.issue_creation_policy");
    }
  });
});

describe("repository snapshot", () => {
  const snapshot = (api: GitHubClient, policy: OnMissingPermission = "fail") =>
    repositorySection.snapshot(snapshotContext(repositorySection, api, REPO, policy));
  const LFS_NOTE =
    "repository.enable_git_lfs: GitHub exposes no endpoint to read Git LFS back, so the snapshot leaves it out; declare it yourself to manage it";

  test("reads the PATCH fields, topics, toggles, and GraphQL keys back; what nobody can PATCH and a null field fall away", async () => {
    const api = liveRepo({
      repo: {
        id: 500,
        node_id: "R_kgDOHdPQ2A",
        name: "r",
        full_name: "o/r",
        owner: { login: "o", id: 9 },
        html_url: "https://github.com/o/r",
        forks_count: 3,
        has_downloads: true,
        permissions: { admin: true },
        description: "Docs",
        homepage: null,
        private: false,
        visibility: "public",
        security_and_analysis: { secret_scanning: { status: "enabled" } },
        has_issues: true,
        has_wiki: false,
        default_branch: "main",
        allow_squash_merge: true,
        squash_merge_commit_title: "PR_TITLE",
        archived: false,
        topics: ["ci", "tooling"],
      },
      toggles: { "vulnerability-alerts": true, "automated-security-fixes": true },
      features: { hasSponsorshipsEnabled: true, issueCreationPolicy: "COLLABORATORS_ONLY" },
    });
    expect(await snapshot(api)).toEqual({
      value: {
        description: "Docs",
        private: false,
        visibility: "public",
        security_and_analysis: { secret_scanning: { status: "enabled" } },
        has_issues: true,
        has_wiki: false,
        default_branch: "main",
        allow_squash_merge: true,
        squash_merge_commit_title: "PR_TITLE",
        archived: false,
        topics: ["ci", "tooling"],
        enable_vulnerability_alerts: true,
        enable_automated_security_fixes: true,
        enable_private_vulnerability_reporting: false,
        enable_immutable_releases: false,
        enable_sponsorships: true,
        issue_creation_policy: "collaborators_only",
      },
      notes: [LFS_NOTE],
    });
    expect(api.writes).toEqual([]);
  });

  test("security_and_analysis keeps only its PATCHable sub-keys: dependabot_security_updates is the toggle's, not the passthrough's", async () => {
    const api = liveRepo({
      repo: {
        security_and_analysis: {
          secret_scanning: { status: "enabled" },
          secret_scanning_push_protection: { status: "disabled" },
          dependabot_security_updates: { status: "enabled" },
        },
        topics: [],
      },
      toggles: { "automated-security-fixes": true },
    });
    const { value } = await snapshot(api);
    expect(value?.security_and_analysis).toEqual({
      secret_scanning: { status: "enabled" },
      secret_scanning_push_protection: { status: "disabled" },
    });
    expect(value?.enable_automated_security_fixes).toBe(true);
    // Only the toggle's own key carries the state, so nothing about it is declared twice.
    const bare = liveRepo({
      repo: {
        security_and_analysis: { dependabot_security_updates: { status: "enabled" } },
        topics: [],
      },
    });
    expect((await snapshot(bare)).value).not.toHaveProperty("security_and_analysis");
  });

  /** The fixture a denied toggle probe and a denied features query share across the two policies. */
  const deniedProbeApi = () =>
    new MockApi({
      [GET]: { data: { description: "x", topics: [] } },
      "GET /repos/o/r/private-vulnerability-reporting": {
        error: { status: 403, message: "Forbidden", body: "" },
      },
      "GET /repos/o/r/immutable-releases": { data: { enabled: true, enforced_by_owner: true } },
      ...features({ issueCreationPolicy: "NOBODY" }),
    });

  test("under warn, a denied toggle probe is a note, an owner-enforced toggle reads back with a note, and an unreadable policy is left out", async () => {
    const api = deniedProbeApi();
    expect(await snapshot(api, "warn")).toEqual({
      value: {
        description: "x",
        enable_vulnerability_alerts: false,
        enable_automated_security_fixes: false,
        enable_immutable_releases: true,
        enable_sponsorships: false,
      },
      notes: [
        `repository.enable_private_vulnerability_reporting: left out of the snapshot - the token was denied GET /repos/o/r/private-vulnerability-reporting: 403 Forbidden. To fix, ${sectionGrant(repositorySection)}`,
        "repository.enable_immutable_releases: the repository owner enforces immutable releases, so it reads back as true but cannot be changed from the repository",
        LFS_NOTE,
        'repository.issue_creation_policy: GRAPHQL RepositoryFeatures returned issueCreationPolicy "NOBODY", ' +
          "which this section cannot read as a repository.issue_creation_policy value; a null policy means " +
          "GitHub reported no issue creation policy for this repository; otherwise the field vocabulary may " +
          "have changed, so the snapshot leaves it out",
      ],
    });
    expect(api.mutations()).toEqual([]);
  });

  test("under fail, a denied toggle probe or a denied features query fails the section with the grant advice, never a note", async () => {
    const probe = await rejection(snapshot(deniedProbeApi(), "fail"));
    expectAdministrationDenied(probe);
    expect((probe as PermissionDenied).detail).toContain(
      "the token was denied GET /repos/o/r/private-vulnerability-reporting: 403 Forbidden",
    );
    const features403 = new MockApi({
      [GET]: { data: { topics: [] } },
      "GET /repos/o/r/immutable-releases": { data: { enabled: false, enforced_by_owner: false } },
      "GRAPHQL RepositoryFeatures": {
        error: {
          status: 403,
          message: "Resource not accessible",
          body: "",
          graphqlTypes: ["FORBIDDEN"],
        },
      },
    });
    const query = await rejection(snapshot(features403, "fail"));
    expectAdministrationDenied(query);
    expect((query as PermissionDenied).detail).toContain("GRAPHQL RepositoryFeatures");
  });

  test("four toggle 404s are left out under one note, since a concealed denial answers the same; one other answer proves the grant", async () => {
    // Every unrouted GET answers 404, as a fine-grained token without the grant is answered.
    const allOff = new MockApi({ [GET]: { data: { topics: [] } }, ...features() });
    expect(await snapshot(allOff)).toEqual({
      value: { enable_sponsorships: false, issue_creation_policy: "all" },
      notes: [
        "repository.enable_vulnerability_alerts/enable_automated_security_fixes/enable_private_vulnerability_reporting/enable_immutable_releases: " +
          "every toggle GET answered 404, which reads as off but is also how a fine-grained token missing the grant is answered, so they are left out; " +
          `if the token does ${sectionGrant(repositorySection)}, they are all off and can be declared false`,
        LFS_NOTE,
      ],
    });
    const oneOn = new MockApi({
      [GET]: { data: { topics: [] } },
      "GET /repos/o/r/immutable-releases": { data: { enabled: true, enforced_by_owner: false } },
      ...features(),
    });
    expect((await snapshot(oneOn)).value).toMatchObject({
      enable_vulnerability_alerts: false,
      enable_automated_security_fixes: false,
      enable_private_vulnerability_reporting: false,
      enable_immutable_releases: true,
    });
    // The declared 422 ("not applicable") is answered only to a granted token, so it proves it too.
    const notApplicable = new MockApi({
      [GET]: { data: { topics: [] } },
      "GET /repos/o/r/private-vulnerability-reporting": {
        error: { status: 422, message: "Unprocessable", body: "" },
      },
      ...features(),
    });
    expect((await snapshot(notApplicable)).value).toMatchObject({
      enable_vulnerability_alerts: false,
      enable_automated_security_fixes: false,
      enable_private_vulnerability_reporting: false,
      enable_immutable_releases: false,
    });
  });

  test("under warn, a denied features query leaves both GraphQL keys out under one note", async () => {
    const api = new MockApi({
      [GET]: { data: { topics: [] } },
      "GET /repos/o/r/private-vulnerability-reporting": { data: { enabled: false } },
      "GRAPHQL RepositoryFeatures": { error: { status: 403, message: "Forbidden", body: "" } },
    });
    expect(await snapshot(api, "warn")).toEqual({
      value: {
        enable_vulnerability_alerts: false,
        enable_automated_security_fixes: false,
        enable_private_vulnerability_reporting: false,
        enable_immutable_releases: false,
      },
      notes: [
        LFS_NOTE,
        `repository.enable_sponsorships and repository.issue_creation_policy: left out of the snapshot - the token was denied GRAPHQL RepositoryFeatures: 403 Forbidden. To fix, ${sectionGrant(repositorySection)}`,
      ],
    });
  });
});

describe("repository parse refusals", () => {
  /** The section's own issue lines, without the document-level wrapper prose around them. */
  const refusals = (repository: Record<string, unknown>): readonly string[] =>
    validateSectionShapes({ repository }, "f.yml").match(
      () => [],
      (problem) => problem.issues,
    );

  const SQUASH_PAIRS =
    "PR_TITLE with PR_BODY or BLANK or COMMIT_MESSAGES; COMMIT_OR_PR_TITLE with COMMIT_MESSAGES";

  test.each([
    [
      "has_downloads",
      { has_downloads: false },
      "repository.has_downloads: has_downloads is reported by GitHub but cannot be set through the API; remove it",
    ],
    [
      "custom_properties",
      { custom_properties: { team: "docs" } },
      "repository.custom_properties: custom_properties is reported by GitHub but cannot be set through the repository PATCH; declare it in the custom_properties section instead",
    ],
    [
      "has_pages",
      { has_pages: true },
      "repository.has_pages: has_pages is reported by GitHub but cannot be set through the repository PATCH; declare it in the pages section instead",
    ],
  ])(
    "a GET-only key (%s) is refused at parse: the PATCH ignores it, so check would report the same drift on every run",
    (_key, declared, message) => {
      expect(refusals({ has_issues: true, ...declared })).toEqual([message]);
    },
  );

  test("a key in neither the GET nor the PATCH still passes through, so a field GitHub adds tomorrow works day one", () => {
    const declared = { name: "renamed", future_field: 1, has_issues: true };
    expect(
      validateSectionShapes({ repository: declared }, "f.yml").match(
        (parsed) => parsed.repository,
        (problem) => problem.issues,
      ),
    ).toEqual(declared);
  });

  test.each([
    [
      "the GET-only dependabot_security_updates",
      { dependabot_security_updates: { status: "enabled" } },
      'repository.security_and_analysis: "dependabot_security_updates" is reported by GitHub here but the PATCH rejects it; declare enable_automated_security_fixes instead',
    ],
    [
      "an unknown sub-key",
      { not_a_security_feature: { status: "enabled" } },
      'repository.security_and_analysis: "not_a_security_feature" is not a key security_and_analysis accepts ' +
        '(GitHub rejects it with a 422); remove it. Known keys: "advanced_security", "code_security", ' +
        '"secret_scanning", "secret_scanning_push_protection", "secret_scanning_ai_detection", ' +
        '"secret_scanning_non_provider_patterns", "secret_scanning_delegated_alert_dismissal", ' +
        '"secret_scanning_delegated_bypass", "secret_scanning_delegated_bypass_options", ' +
        '"secret_scanning_validity_checks"',
    ],
    [
      "a status outside enabled/disabled",
      { secret_scanning: { status: "on" } },
      'repository.security_and_analysis.secret_scanning.status: "on" is not a feature status; use "enabled" or "disabled"',
    ],
    [
      "a key beside status",
      { secret_scanning: { status: "enabled", enabled: true } },
      'repository.security_and_analysis.secret_scanning: "enabled" is not a key a security_and_analysis feature accepts (GitHub rejects it with a 422); remove it. Known keys: "status"',
    ],
    [
      "an unknown reviewer key",
      {
        secret_scanning_delegated_bypass_options: {
          reviewers: [{ reviewer_id: 7, reviewer_type: "TEAM", exempt: true }],
        },
      },
      'repository.security_and_analysis.secret_scanning_delegated_bypass_options.reviewers[0]: "exempt" is not a key a bypass reviewer accepts (GitHub rejects it with a 422); remove it. Known keys: "reviewer_id", "reviewer_type", "mode"',
    ],
  ])(
    "security_and_analysis refuses %s at parse instead of surfacing GitHub's 422 at apply",
    (_what, declared, message) => {
      expect(refusals({ security_and_analysis: declared })).toEqual([message]);
    },
  );

  test("security_and_analysis accepts the null the PATCH body documents, and the validity-checks sub-key the descriptor omits", () => {
    expect(refusals({ security_and_analysis: null })).toEqual([]);
    expect(
      refusals({
        security_and_analysis: { secret_scanning_validity_checks: { status: "enabled" } },
      }),
    ).toEqual([]);
  });

  test.each([
    [
      "a squash message without its title",
      { squash_merge_commit_message: "PR_BODY" },
      `repository.squash_merge_commit_message: squash_merge_commit_message needs squash_merge_commit_title declared beside it (GitHub requires the pair). Legal pairs: ${SQUASH_PAIRS}`,
    ],
    [
      "COMMIT_OR_PR_TITLE with PR_BODY",
      { squash_merge_commit_title: "COMMIT_OR_PR_TITLE", squash_merge_commit_message: "PR_BODY" },
      `repository.squash_merge_commit_message: squash_merge_commit_title COMMIT_OR_PR_TITLE cannot pair with squash_merge_commit_message PR_BODY (GitHub answers 422). Legal pairs: ${SQUASH_PAIRS}`,
    ],
    [
      "a squash title outside the vocabulary",
      { squash_merge_commit_title: "COMMIT_TITLE", squash_merge_commit_message: "PR_BODY" },
      `repository.squash_merge_commit_title: "COMMIT_TITLE" is not a squash_merge_commit_title value; use "PR_TITLE", "COMMIT_OR_PR_TITLE". Legal pairs: ${SQUASH_PAIRS}`,
    ],
    [
      "a merge message without its title",
      { merge_commit_message: "PR_TITLE" },
      "repository.merge_commit_message: merge_commit_message needs merge_commit_title declared beside it (GitHub requires the pair)",
    ],
    [
      "a merge message outside the vocabulary",
      { merge_commit_title: "PR_TITLE", merge_commit_message: "COMMIT_MESSAGES" },
      'repository.merge_commit_message: "COMMIT_MESSAGES" is not a merge_commit_message value; use "PR_BODY", "BLANK", "PR_TITLE"',
    ],
  ])(
    "commit message defaults: %s is refused at parse instead of as GitHub's 422 at apply",
    (_what, declared, message) => {
      expect(refusals(declared)).toEqual([message]);
    },
  );

  test.each([
    ["PR_TITLE", "PR_BODY"],
    ["PR_TITLE", "BLANK"],
    ["PR_TITLE", "COMMIT_MESSAGES"],
    ["COMMIT_OR_PR_TITLE", "COMMIT_MESSAGES"],
  ])("commit message defaults: the legal squash pair %s with %s parses", (title, message) => {
    expect(
      refusals({ squash_merge_commit_title: title, squash_merge_commit_message: message }),
    ).toEqual([]);
  });

  test.each([
    [
      "the default merge pair",
      { merge_commit_title: "MERGE_MESSAGE", merge_commit_message: "PR_TITLE" },
    ],
    [
      "a merge pair GitHub documents no refusal for",
      { merge_commit_title: "MERGE_MESSAGE", merge_commit_message: "PR_BODY" },
    ],
    [
      "a lone title, whose pair is only decidable against the live message",
      { squash_merge_commit_title: "PR_TITLE", merge_commit_title: "PR_TITLE" },
    ],
  ])("commit message defaults: %s parses", (_what, declared) => {
    expect(refusals(declared)).toEqual([]);
  });

  const TOPIC_RULE =
    "is not a topic GitHub accepts: a topic is 1 to 50 characters, each a letter, digit, or hyphen, starting with a letter or digit (uppercase is lowercased on the wire)";

  test.each([
    [
      "a space inside a topic",
      ["GitHub Actions"],
      `repository.topics[0]: "GitHub Actions" ${TOPIC_RULE}`,
    ],
    [
      "a leading hyphen, in the comma-string form",
      "ci, -lead",
      `repository.topics: "-lead" (entry 2 of the comma list) ${TOPIC_RULE}`,
    ],
    [
      "a 51-character topic",
      ["a".repeat(51)],
      `repository.topics[0]: "${"a".repeat(51)}" ${TOPIC_RULE}`,
    ],
    [
      "21 topics",
      Array.from({ length: 21 }, (_, index) => `topic-${index}`),
      "repository.topics: 21 topics declared; GitHub allows at most 20",
    ],
  ])(
    "topics: %s is refused at parse instead of as a 422 from PUT /topics",
    (_what, topics, message) => {
      expect(refusals({ topics })).toEqual([message]);
    },
  );

  const EMPTY_TOPIC =
    "is not one GitHub accepts; drop the entry, or declare topics: [] to remove every topic";

  test.each([
    [
      "an empty list item, once dropped silently",
      ["ci", ""],
      `repository.topics[1]: an empty topic ${EMPTY_TOPIC}`,
    ],
    [
      "an empty comma-string segment, once dropped silently",
      "ci,,tooling",
      `repository.topics: an empty topic (entry 2 of the comma list) ${EMPTY_TOPIC}`,
    ],
    [
      "an empty string, once the wholesale clear",
      "",
      `repository.topics: an empty topic ${EMPTY_TOPIC}`,
    ],
  ])("topics: %s is refused at parse, the refusal naming the entry", (_what, topics, message) => {
    expect(refusals({ topics })).toEqual([message]);
  });

  test("topics: the cap counts distinct topics after the fold, so 22 entries naming 2 topics parse", () => {
    expect(
      refusals({ topics: [...Array.from({ length: 20 }, () => "CI"), "ci", "tooling"] }),
    ).toEqual([]);
  });

  test("topics: 20 well-formed topics, a 50-character one and uppercase input among them, parse", () => {
    const topics = [
      "Copier",
      "a".repeat(50),
      "9lives",
      ...Array.from({ length: 17 }, (_, index) => `topic-${index}`),
    ];
    expect(refusals({ topics })).toEqual([]);
    expect(refusals({ topics: topics.join(", ") })).toEqual([]);
  });

  test("topics: [] parses; it is the one spelling of the wholesale clear", () => {
    expect(refusals({ topics: [] })).toEqual([]);
  });

  const TOGGLE_NULL = "null is not a boolean, and a toggle has no empty state; write true or false";
  const TOGGLE_QUOTED =
    " is not a boolean, so the toggle direction is ambiguous. Use unquoted true or false " +
    '(YAML parses "no"/"off"/"yes" as strings, not booleans)';

  /** The PATCH fields the schema types as booleans, read off the shape so the rows follow the table. */
  const PATCH_TOGGLES = PATCH_FIELDS.filter(
    (key) => RepositoryConfig.shape[key].unwrap() instanceof z.ZodBoolean,
  );

  test("every PATCH toggle takes true and false, and refuses null and a quoted boolean naming the two values", () => {
    // The control: an empty list would pass the loop below without pinning anything.
    expect(PATCH_TOGGLES).toContain("has_wiki");
    for (const key of PATCH_TOGGLES) {
      expect(refusals({ [key]: true })).toEqual([]);
      expect(refusals({ [key]: false })).toEqual([]);
      expect(refusals({ [key]: null })).toEqual([`repository.${key}: ${TOGGLE_NULL}`]);
      expect(refusals({ [key]: "true" })).toEqual([`repository.${key}: "true"${TOGGLE_QUOTED}`]);
    }
  });

  test.each([
    [
      "default_branch: null",
      { default_branch: null },
      "repository.default_branch: null is not a string; quote the value",
    ],
    [
      "description: 7",
      { description: 7 },
      "repository.description: 7 is not a string; quote the value, or write null to clear the field",
    ],
    [
      "pull_request_creation_policy: everyone",
      { pull_request_creation_policy: "everyone" },
      'repository.pull_request_creation_policy: "everyone" is not a recognized policy. Use "all" (everyone) or "collaborators_only"',
    ],
  ])(
    "a PATCH field outside its type (%s) is refused at parse instead of as GitHub's 422",
    (_what, declared, message) => {
      expect(refusals({ has_issues: true, ...declared })).toEqual([message]);
    },
  );

  test("the PATCH strings take what GitHub does: null clears description and homepage, and default_branch and visibility are plain strings", () => {
    expect(
      refusals({
        description: null,
        homepage: null,
        default_branch: "trunk",
        visibility: "internal",
        pull_request_creation_policy: "collaborators_only",
      }),
    ).toEqual([]);
    expect(refusals({ description: "docs", homepage: "https://example.com" })).toEqual([]);
  });
});
