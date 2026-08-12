import { describe, expect, test } from "bun:test";
import { validateSectionShapes } from "../../src/engine/validate.js";
import { PermissionDenied, toleratedStatuses } from "../../src/sections/contract.js";
import {
  FEATURE_TOGGLES,
  normalizeTopics,
  repositorySection,
} from "../../src/sections/repository.js";
import { MockApi } from "../mock-api.js";
import { ctx } from "./context.js";

describe("feature-toggle write tolerances", () => {
  test("every toggle write tolerates only statuses the apply loop interprets", () => {
    // The apply loop reports a change for any tolerated outcome that is not
    // a 409, so a toggle write may only tolerate 409 (owner-enforced note)
    // and, on a REMOVE only, the 404/422 that mean "already off". A new
    // tolerated status (say, a 403 on the LFS put, or a 404 on any put)
    // would otherwise fall through to a change line for a request that
    // failed.
    const interpreted = {
      put: new Set([409]),
      remove: new Set([404, 409, 422]),
    };
    for (const toggle of FEATURE_TOGGLES) {
      for (const direction of ["put", "remove"] as const) {
        const endpoint = toggle[direction];
        for (const status of toleratedStatuses(endpoint)) {
          expect(
            interpreted[direction].has(status),
            `${toggle.key} tolerates ${status} on ${endpoint.route}, which the apply loop does not know how to interpret on a ${direction}`,
          ).toBe(true);
        }
      }
    }
  });
});

describe("normalizeTopics", () => {
  test("comma string", () => {
    expect(normalizeTopics("Copier, template , ,GitHub-Actions")).toEqual([
      "copier",
      "template",
      "github-actions",
    ]);
  });
  test("array and dedupe", () => {
    expect(normalizeTopics(["A", "a", "b"])).toEqual(["a", "b"]);
  });
});

describe("repository", () => {
  test("splits specials onto their endpoints", async () => {
    const api = new MockApi({}).allowMutations(
      "PATCH /repos/o/r",
      "PUT /repos/o/r/topics",
      "PUT /repos/o/r/vulnerability-alerts",
      "DELETE /repos/o/r/automated-security-fixes",
    );
    await repositorySection.run(ctx(api), {
      description: "d",
      topics: "A, b",
      enable_vulnerability_alerts: true,
      enable_automated_security_fixes: false,
    });
    expect(api.mutations().map((m) => `${m.method} ${m.path}`)).toEqual([
      "PATCH /repos/o/r",
      "PUT /repos/o/r/topics",
      "PUT /repos/o/r/vulnerability-alerts",
      "DELETE /repos/o/r/automated-security-fixes",
    ]);
    const patch = api.mutations()[0]?.payload as Record<string, unknown>;
    expect(Object.keys(patch)).toEqual(["description"]);
    const topics = api.mutations()[1]?.payload as { names: string[] };
    expect(topics.names).toEqual(["a", "b"]);
  });

  test("permission error surfaces as PermissionDenied", async () => {
    const api = new MockApi({
      "PATCH /repos/o/r": { error: { status: 403, message: "Resource not accessible", body: "" } },
    });
    await expect(repositorySection.run(ctx(api), { description: "d" })).rejects.toBeInstanceOf(
      PermissionDenied,
    );
  });

  test("private vulnerability reporting toggles its own endpoint", async () => {
    const api = new MockApi({}).allowMutations(
      "PUT /repos/o/r/private-vulnerability-reporting",
      "DELETE /repos/o/r/private-vulnerability-reporting",
    );
    const on = await repositorySection.run(ctx(api), {
      enable_private_vulnerability_reporting: true,
    });
    expect(on.changes).toEqual(["private vulnerability reporting: enabled"]);
    await repositorySection.run(ctx(api), { enable_private_vulnerability_reporting: false });
    expect(api.mutations().map((m) => `${m.method} ${m.path}`)).toEqual([
      "PUT /repos/o/r/private-vulnerability-reporting",
      "DELETE /repos/o/r/private-vulnerability-reporting",
    ]);
  });

  test("private vulnerability reporting check reads the {enabled} body", async () => {
    const api = new MockApi({
      "GET /repos/o/r": { data: {} },
      "GET /repos/o/r/private-vulnerability-reporting": { data: { enabled: false } },
    });
    const result = await repositorySection.run(ctx(api, true), {
      enable_private_vulnerability_reporting: true,
    });
    expect(result.drift).toEqual([
      "repository.enable_private_vulnerability_reporting: declared true != live false; apply will set the declared value",
    ]);
    expect(api.mutations()).toEqual([]);
    const clean = new MockApi({
      "GET /repos/o/r": { data: {} },
      "GET /repos/o/r/private-vulnerability-reporting": { data: { enabled: true } },
    });
    const noDrift = await repositorySection.run(ctx(clean, true), {
      enable_private_vulnerability_reporting: true,
    });
    expect(noDrift.drift).toEqual([]);
  });

  test("private vulnerability reporting probe errors are not swallowed", async () => {
    const api = new MockApi({
      "GET /repos/o/r": { data: {} },
      "GET /repos/o/r/private-vulnerability-reporting": {
        error: { status: 403, message: "Forbidden", body: "" },
      },
    });
    await expect(
      repositorySection.run(ctx(api, true), { enable_private_vulnerability_reporting: true }),
    ).rejects.toBeInstanceOf(PermissionDenied);
  });

  test("private vulnerability reporting treats 404/422 as not applicable", async () => {
    // Check mode: a private repo (422) with a matching declared false is clean.
    const check = new MockApi({
      "GET /repos/o/r": { data: {} },
      "GET /repos/o/r/private-vulnerability-reporting": {
        error: { status: 422, message: "Bad Request", body: "" },
      },
    });
    const clean = await repositorySection.run(ctx(check, true), {
      enable_private_vulnerability_reporting: false,
    });
    expect(clean.drift).toEqual([]);
    const drift = await repositorySection.run(ctx(check, true), {
      enable_private_vulnerability_reporting: true,
    });
    expect(drift.drift).toHaveLength(1);
    // Apply mode: DELETE answering 422 is already the declared state.
    const apply = new MockApi({
      "DELETE /repos/o/r/private-vulnerability-reporting": {
        error: { status: 422, message: "Bad Request", body: "" },
      },
    });
    const off = await repositorySection.run(ctx(apply), {
      enable_private_vulnerability_reporting: false,
    });
    expect(off.changes).toEqual(["private vulnerability reporting: disabled"]);
  });

  test("non-boolean security toggles are rejected by upfront shape validation with the YAML hint", () => {
    const error = validateSectionShapes(
      { repository: { enable_vulnerability_alerts: "no" } },
      "f.yml",
    );
    expect(error).toContain("repository.enable_vulnerability_alerts");
    expect(error).toContain("not a boolean");
    expect(error).toContain('"no"');
  });

  test("git LFS applies blindly: PUT on true, DELETE on false, never in the PATCH", async () => {
    const on = new MockApi({}).allowMutations("PUT /repos/o/r/lfs");
    const enabled = await repositorySection.run(ctx(on), { enable_git_lfs: true });
    expect(on.mutations().map((m) => `${m.method} ${m.path}`)).toEqual(["PUT /repos/o/r/lfs"]);
    expect(enabled.changes).toEqual(["Git LFS: enabled"]);
    const off = new MockApi({}).allowMutations("DELETE /repos/o/r/lfs");
    const disabled = await repositorySection.run(ctx(off), { enable_git_lfs: false });
    expect(off.mutations().map((m) => `${m.method} ${m.path}`)).toEqual(["DELETE /repos/o/r/lfs"]);
    expect(disabled.changes).toEqual(["Git LFS: disabled"]);
  });

  test("git LFS check mode emits the cannot-verify note, no drift, no requests beyond the GET", async () => {
    const api = new MockApi({ "GET /repos/o/r": { data: {} } });
    const result = await repositorySection.run(ctx(api, true), { enable_git_lfs: true });
    expect(result.drift).toEqual([]);
    expect(result.notes).toHaveLength(1);
    expect(result.notes[0]).toContain("repository.enable_git_lfs");
    expect(result.notes[0]).toContain("cannot verify");
    expect(api.mutations()).toEqual([]);
    expect(api.calls.map((c) => `${c.method} ${c.path}`)).toEqual(["GET /repos/o/r"]);
  });

  test("non-boolean git LFS values hit the shared toggle shape, booleans pass", () => {
    const error = validateSectionShapes({ repository: { enable_git_lfs: "yes" } }, "f.yml");
    expect(error).toContain("repository.enable_git_lfs");
    expect(error).toContain("not a boolean");
    // The section stays loose otherwise: booleans and passthrough keys pass.
    expect(
      validateSectionShapes({ repository: { enable_git_lfs: true, future_field: "x" } }, "f.yml"),
    ).toBeNull();
  });

  test("a cyclic toggle value is rejected with a message, never a formatter throw", () => {
    // A YAML alias cycle (enable_git_lfs: &v { self: *v }) reaches the shape
    // as a self-referential object; the error text must be built without
    // JSON.stringify on it, or validation itself would die and the run would
    // lose its normal failed result.
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const error = validateSectionShapes({ repository: { enable_git_lfs: cyclic } }, "f.yml");
    expect(error).toContain("repository.enable_git_lfs");
    expect(error).toContain("a mapping is not a boolean");
  });

  test("the section accepts plain mappings only, like the record shape always did", () => {
    // requirePlainMapping guards the passthrough mapping: a YAML !!timestamp
    // document parses to a Date, which zod's object schemas would accept as
    // an empty mapping, so it must fail shape validation instead.
    expect(validateSectionShapes({ repository: new Date("2020-01-01") }, "f.yml")).toContain(
      "repository",
    );
    expect(validateSectionShapes({ repository: [1, 2] }, "f.yml")).toContain("repository");
  });

  test("immutable releases toggles its own endpoint: PUT on true, DELETE on false", async () => {
    const on = new MockApi({}).allowMutations("PUT /repos/o/r/immutable-releases");
    const enabled = await repositorySection.run(ctx(on), { enable_immutable_releases: true });
    expect(on.mutations().map((m) => `${m.method} ${m.path}`)).toEqual([
      "PUT /repos/o/r/immutable-releases",
    ]);
    expect(enabled.changes).toEqual(["immutable releases: enabled"]);
    const off = new MockApi({}).allowMutations("DELETE /repos/o/r/immutable-releases");
    const disabled = await repositorySection.run(ctx(off), { enable_immutable_releases: false });
    expect(off.mutations().map((m) => `${m.method} ${m.path}`)).toEqual([
      "DELETE /repos/o/r/immutable-releases",
    ]);
    expect(disabled.changes).toEqual(["immutable releases: disabled"]);
  });

  test("immutable releases check reads the {enabled} body and treats 404 as off", async () => {
    // Live enabled, declared false: ordinary drift with the apply promise.
    const liveOn = new MockApi({
      "GET /repos/o/r": { data: {} },
      "GET /repos/o/r/immutable-releases": { data: { enabled: true, enforced_by_owner: false } },
    });
    const drift = await repositorySection.run(ctx(liveOn, true), {
      enable_immutable_releases: false,
    });
    expect(drift.drift).toEqual([
      "repository.enable_immutable_releases: declared false != live true; apply will set the declared value",
    ]);
    expect(liveOn.mutations()).toEqual([]);
    // The probe's 404 reads as off: drift against declared true, clean against
    // declared false.
    const liveOff = new MockApi({
      "GET /repos/o/r": { data: {} },
      "GET /repos/o/r/immutable-releases": {
        error: { status: 404, message: "Not Found", body: "" },
      },
    });
    const missing = await repositorySection.run(ctx(liveOff, true), {
      enable_immutable_releases: true,
    });
    expect(missing.drift).toEqual([
      "repository.enable_immutable_releases: declared true != live false; apply will set the declared value",
    ]);
    const clean = await repositorySection.run(ctx(liveOff, true), {
      enable_immutable_releases: false,
    });
    expect(clean.drift).toEqual([]);
  });

  test("owner-enforced immutable releases drift says apply cannot change it", async () => {
    const api = new MockApi({
      "GET /repos/o/r": { data: {} },
      "GET /repos/o/r/immutable-releases": { data: { enabled: true, enforced_by_owner: true } },
    });
    const result = await repositorySection.run(ctx(api, true), {
      enable_immutable_releases: false,
    });
    expect(result.drift).toEqual([
      "repository.enable_immutable_releases: declared false != live true; the repository owner enforces immutable releases, so apply cannot change it from the repository",
    ]);
    // A matching declaration stays clean even under enforcement.
    const matching = await repositorySection.run(ctx(api, true), {
      enable_immutable_releases: true,
    });
    expect(matching.drift).toEqual([]);
  });

  test("a 409 on either immutable-releases write is a note, never a change line", async () => {
    const conflict = { status: 409, message: "Conflict", body: "" };
    const put = new MockApi({ "PUT /repos/o/r/immutable-releases": { error: conflict } });
    const onEnable = await repositorySection.run(ctx(put), { enable_immutable_releases: true });
    expect(onEnable.changes).toEqual([]);
    expect(onEnable.notes).toEqual([
      "repository.enable_immutable_releases: the repository owner enforces immutable releases, so apply cannot change it from the repository (409)",
    ]);
    const remove = new MockApi({ "DELETE /repos/o/r/immutable-releases": { error: conflict } });
    const onDisable = await repositorySection.run(ctx(remove), {
      enable_immutable_releases: false,
    });
    expect(onDisable.changes).toEqual([]);
    expect(onDisable.notes).toEqual([
      "repository.enable_immutable_releases: the repository owner enforces immutable releases, so apply cannot change it from the repository (409)",
    ]);
  });
});

describe("repository GraphQL-routed keys", () => {
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
    "GRAPHQL UpdateRepositoryFeatures": {
      data: { updateRepository: { repository: fields } },
    },
  });

  test("apply mutates only on divergence, carrying the declared fields and the node id", async () => {
    const api = new MockApi({
      ...features(),
      ...echo({ hasSponsorshipsEnabled: true, issueCreationPolicy: "COLLABORATORS_ONLY" }),
    });
    const result = await repositorySection.run(ctx(api), {
      enable_sponsorships: true,
      issue_creation_policy: "collaborators_only",
    });
    expect(api.mutations().map((m) => `${m.method} ${m.path}`)).toEqual([
      "GRAPHQL UpdateRepositoryFeatures",
    ]);
    expect(api.mutations()[0]?.payload).toEqual({
      repositoryId: "R_node",
      hasSponsorshipsEnabled: true,
      issueCreationPolicy: "COLLABORATORS_ONLY",
    });
    // The complete call sequence: ONE features read, then the mutation.
    expect(api.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "GRAPHQL RepositoryFeatures",
      "GRAPHQL UpdateRepositoryFeatures",
    ]);
    expect(result.changes).toEqual([
      "sponsor button: enabled",
      "issue creation policy: collaborators_only",
    ]);
  });

  test("partial divergence: the mutation and the change lines carry only the diverged key", async () => {
    // enable_sponsorships already matches live; only the policy moves. A
    // change line for the untouched sponsor button would be a false claim
    // (the section's own 409 rule: a note, never a false change line).
    const api = new MockApi({
      ...features({ hasSponsorshipsEnabled: true }),
      ...echo({ hasSponsorshipsEnabled: true, issueCreationPolicy: "COLLABORATORS_ONLY" }),
    });
    const result = await repositorySection.run(ctx(api), {
      enable_sponsorships: true,
      issue_creation_policy: "collaborators_only",
    });
    expect(api.mutations()[0]?.payload).toEqual({
      repositoryId: "R_node",
      issueCreationPolicy: "COLLABORATORS_ONLY",
    });
    expect(result.changes).toEqual(["issue creation policy: collaborators_only"]);
  });

  test("a converged repo issues the read but no mutation", async () => {
    const api = new MockApi(
      features({ hasSponsorshipsEnabled: true, issueCreationPolicy: "COLLABORATORS_ONLY" }),
    );
    const result = await repositorySection.run(ctx(api), {
      enable_sponsorships: true,
      issue_creation_policy: "collaborators_only",
    });
    expect(api.mutations()).toEqual([]);
    expect(result.changes).toEqual([]);
    expect(api.calls.map((c) => `${c.method} ${c.path}`)).toEqual(["GRAPHQL RepositoryFeatures"]);
  });

  test("the mutation carries only the declared key", async () => {
    const api = new MockApi({
      ...features(),
      ...echo({ issueCreationPolicy: "COLLABORATORS_ONLY" }),
    });
    await repositorySection.run(ctx(api), { issue_creation_policy: "collaborators_only" });
    expect(api.mutations()[0]?.payload).toEqual({
      repositoryId: "R_node",
      issueCreationPolicy: "COLLABORATORS_ONLY",
    });
  });

  test("an echo reporting the old value fails loudly: the write did not take", async () => {
    // "Accepted but silently ignored" is the REST failure mode that forced
    // these keys onto GraphQL; the mutation's echoed post-state is the guard.
    const api = new MockApi({
      ...features(),
      ...echo({ hasSponsorshipsEnabled: false }),
    });
    await expect(repositorySection.run(ctx(api), { enable_sponsorships: true })).rejects.toThrow(
      "the write did not take",
    );
  });

  test("a mutation response without the repository echo fails loudly", async () => {
    const api = new MockApi({
      ...features(),
      "GRAPHQL UpdateRepositoryFeatures": { data: { updateRepository: {} } },
    });
    await expect(repositorySection.run(ctx(api), { enable_sponsorships: true })).rejects.toThrow(
      "returned no repository echo",
    );
  });

  test("neither key declared means zero GraphQL calls", async () => {
    const api = new MockApi({}).allowMutations("PATCH /repos/o/r");
    await repositorySection.run(ctx(api), { has_issues: true });
    expect(api.calls.map((c) => c.method)).toEqual(["PATCH"]);
  });

  test("both keys are stripped from the base PATCH", async () => {
    const api = new MockApi({
      ...features(),
      ...echo({ hasSponsorshipsEnabled: true, issueCreationPolicy: "ALL" }),
    }).allowMutations("PATCH /repos/o/r");
    await repositorySection.run(ctx(api), {
      description: "d",
      enable_sponsorships: true,
      issue_creation_policy: "all",
    });
    const patch = api.calls.find((c) => c.method === "PATCH")?.payload as Record<string, unknown>;
    expect(Object.keys(patch)).toEqual(["description"]);
  });

  test("check mode reports per-key drift and stays clean when live matches", async () => {
    const drifted = new MockApi({
      "GET /repos/o/r": { data: {} },
      ...features({ hasSponsorshipsEnabled: true }),
    });
    const result = await repositorySection.run(ctx(drifted, true), {
      enable_sponsorships: false,
      issue_creation_policy: "collaborators_only",
    });
    expect(result.drift).toEqual([
      "repository.enable_sponsorships: declared false != live true; apply will set the declared value",
      "repository.issue_creation_policy: declared collaborators_only != live all; apply will set the declared value",
    ]);
    expect(drifted.mutations()).toEqual([]);
    const clean = new MockApi({
      "GET /repos/o/r": { data: {} },
      ...features({ hasSponsorshipsEnabled: true, issueCreationPolicy: "COLLABORATORS_ONLY" }),
    });
    const noDrift = await repositorySection.run(ctx(clean, true), {
      enable_sponsorships: true,
      issue_creation_policy: "collaborators_only",
    });
    expect(noDrift.drift).toEqual([]);
  });

  test("a features response without a repository id fails loudly", async () => {
    const api = new MockApi({ "GRAPHQL RepositoryFeatures": { data: { repository: null } } });
    await expect(repositorySection.run(ctx(api), { enable_sponsorships: true })).rejects.toThrow(
      "returned no repository object with an id",
    );
  });

  test("an unreadable value on a DECLARED key fails loudly instead of folding to a default", async () => {
    // A null issueCreationPolicy (the SDL marks the field nullable) or a
    // non-boolean sponsorship flag must never read as "all"/false - that
    // could report a clean check against state the section does not
    // understand.
    const nullPolicy = new MockApi({
      "GET /repos/o/r": { data: {} },
      ...features({ issueCreationPolicy: null }),
    });
    await expect(
      repositorySection.run(ctx(nullPolicy, true), { issue_creation_policy: "all" }),
    ).rejects.toThrow("GitHub reported no issue creation policy");
    const unknownEnum = new MockApi({
      "GET /repos/o/r": { data: {} },
      ...features({ issueCreationPolicy: "MAINTAINERS_ONLY" }),
    });
    await expect(
      repositorySection.run(ctx(unknownEnum, true), { issue_creation_policy: "all" }),
    ).rejects.toThrow("MAINTAINERS_ONLY");
    const stringFlag = new MockApi({
      "GET /repos/o/r": { data: {} },
      ...features({ hasSponsorshipsEnabled: "yes" }),
    });
    await expect(
      repositorySection.run(ctx(stringFlag, true), { enable_sponsorships: true }),
    ).rejects.toThrow("cannot read as a repository.enable_sponsorships value");
  });

  test("an unreadable value on an UNDECLARED key never fails the run", async () => {
    // The strictness is scoped to declared keys: a null policy (SDL-nullable)
    // must not fail a run that only declared the sponsor button.
    const api = new MockApi({
      "GET /repos/o/r": { data: {} },
      ...features({ hasSponsorshipsEnabled: true, issueCreationPolicy: null }),
    });
    const result = await repositorySection.run(ctx(api, true), { enable_sponsorships: true });
    expect(result.drift).toEqual([]);
    const applied = new MockApi(
      features({ hasSponsorshipsEnabled: true, issueCreationPolicy: null }),
    );
    const converged = await repositorySection.run(ctx(applied), { enable_sponsorships: true });
    expect(applied.mutations()).toEqual([]);
    expect(converged.changes).toEqual([]);
  });

  test("a GraphQL FORBIDDEN on the read surfaces as PermissionDenied", async () => {
    const api = new MockApi({
      "GRAPHQL RepositoryFeatures": {
        error: {
          status: 403,
          message: "Resource not accessible",
          body: "",
          graphqlTypes: ["FORBIDDEN"],
        },
      },
    });
    await expect(
      repositorySection.run(ctx(api), { enable_sponsorships: true }),
    ).rejects.toBeInstanceOf(PermissionDenied);
  });

  test("a non-boolean enable_sponsorships is rejected upfront with the YAML hint", () => {
    const error = validateSectionShapes({ repository: { enable_sponsorships: "yes" } }, "f.yml");
    expect(error).toContain("repository.enable_sponsorships");
    expect(error).toContain("not a boolean");
  });

  test("an unrecognized issue_creation_policy is rejected upfront naming the vocabulary", () => {
    const error = validateSectionShapes(
      { repository: { issue_creation_policy: "everyone" } },
      "f.yml",
    );
    expect(error).toContain("repository.issue_creation_policy");
    expect(error).toContain('"collaborators_only"');
    expect(
      validateSectionShapes({ repository: { issue_creation_policy: "all" } }, "f.yml"),
    ).toBeNull();
  });

  test("prototype-chain property names never pass the policy vocabulary", () => {
    // `"constructor" in ISSUE_CREATION_POLICIES` is true via the prototype
    // chain; the vocabulary check must be an own-property check or these
    // would validate and then map to garbage at the GraphQL boundary.
    for (const name of ["constructor", "toString", "__proto__"]) {
      expect(
        validateSectionShapes({ repository: { issue_creation_policy: name } }, "f.yml"),
        `"${name}" must be rejected`,
      ).toContain("repository.issue_creation_policy");
    }
  });
});
