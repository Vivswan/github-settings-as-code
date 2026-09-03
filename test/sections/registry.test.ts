import { describe, expect, test } from "bun:test";
import { SECTION_KEYS, type SettingsFile, UNDECLARED_POLICY_SECTIONS } from "../../src/schema.js";
import {
  type EndpointDecl,
  endpointKind,
  endpointMethod,
  endpointPath,
  expand,
  matchesTemplate,
  toleratedStatuses,
} from "../../src/sections/contract/endpoints.js";
import type {
  GraphqlOpDecl,
  GraphqlPaginatedReadDecl,
} from "../../src/sections/contract/graphql.js";
import {
  defaultUndeclaredPolicy,
  denialPosture,
  endpointPermission,
  type SectionContext,
  type SectionMeta,
  type SectionModule,
  sectionGrant,
  sectionOperations,
} from "../../src/sections/contract/module.js";
import { grantFor, type SectionPermission } from "../../src/sections/contract/permissions.js";
import type { PlanContext, SectionPlan } from "../../src/sections/contract/plan.js";
import { call, probeAbsent } from "../../src/sections/contract/requests.js";
import {
  allEndpoints,
  allGraphqlOps,
  type MisdeclaredPlanModule,
  SECTIONS,
  sectionModule,
} from "../../src/sections/registry.js";
import { workflowsSection } from "../../src/sections/workflows/index.js";
import type { MustBeNever } from "../../src/types.js";

// The caveat code-scanning appends to its derived grant. Kept here so the
// snapshot below and the derivation check agree on one source of truth.
const CODE_SCANNING_CAVEAT =
  "a 403 on this endpoint can also mean GitHub Advanced Security (code security) is not enabled on the repository, or the repository is archived";

// The caveat code-quality appends: same shape as code-scanning's, for the
// feature-unavailable and archived-repository 403s.
const CODE_QUALITY_CAVEAT =
  "a 403 on this endpoint can also mean code quality is unavailable on the repository, or the repository is archived";

// The caveat check-suite-preferences appends: the endpoint additionally
// requires repo-admin ownership, and with no read endpoint there is no
// preflight probe to catch a denial early.
const CHECK_SUITE_PREFERENCES_CAVEAT =
  "the token owner must be a repository administrator, and with no read endpoint there is nothing to preflight - a denied write surfaces only after other sections' writes landed";

// The caveat actions appends: its OIDC endpoints carry a permission
// override (Actions instead of Administration), so the section grant says
// so wherever a NON-oidc actions endpoint is denied.
const ACTIONS_OIDC_CAVEAT =
  'the "oidc_customization_sub" key alone instead needs "Actions" (read and write)';

// The caveat environments appends: its deployment branch-policy pattern and
// custom deployment protection rule endpoints carry permission overrides
// (Actions for the enabled-rules and pattern-list reads, Administration for
// the available-Apps read and the writes), so the section grant names the
// extra grants wherever an environments endpoint is denied.
const ENVIRONMENTS_POLICIES_CAVEAT =
  'declared "deployment_branch_policies" and "deployment_protection_rules" keys additionally need "Actions" (read) and "Administration" (read and write)';

// The per-section caveats grantFor appends; the derivation test and the
// literal snapshot both read this one map.
const GRANT_CAVEATS: Record<string, string> = {
  code_scanning_default_setup: CODE_SCANNING_CAVEAT,
  code_quality_setup: CODE_QUALITY_CAVEAT,
  check_suite_preferences: CHECK_SUITE_PREFERENCES_CAVEAT,
  actions: ACTIONS_OIDC_CAVEAT,
  environments: ENVIRONMENTS_POLICIES_CAVEAT,
};

// The exact grant prose each section shows in permission errors, captured
// against the pre-refactor literals. grantFor derives these now, so any
// character-level change is a conscious edit here - not a silent drift.
const EXPECTED_GRANT: Record<string, string> = {
  repository: `grant "Administration" (read and write) under the PAT's Repository permissions`,
  labels: `grant "Issues" (read and write) under the PAT's Repository permissions`,
  rulesets: `grant "Administration" (read and write) under the PAT's Repository permissions`,
  branches: `grant "Administration" (read and write) under the PAT's Repository permissions`,
  environments: `grant "Environments" (read and write) under the PAT's Repository permissions; ${ENVIRONMENTS_POLICIES_CAVEAT}`,
  autolinks: `grant "Administration" (read and write) under the PAT's Repository permissions`,
  actions: `grant "Administration" (read and write) under the PAT's Repository permissions; ${ACTIONS_OIDC_CAVEAT}`,
  actions_secrets: `grant "Secrets" (read and write) under the PAT's Repository permissions`,
  dependabot_secrets: `grant "Dependabot secrets" (read and write) under the PAT's Repository permissions`,
  codespaces_secrets: `grant "Codespaces secrets" (read and write) under the PAT's Repository permissions`,
  agents_secrets: `grant "Agent secrets" (read and write) under the PAT's Repository permissions`,
  workflows: `grant "Actions" (read and write) under the PAT's Repository permissions`,
  check_suite_preferences: `grant "Checks" (read and write) under the PAT's Repository permissions; ${CHECK_SUITE_PREFERENCES_CAVEAT}`,
  pages: `grant "Pages" (read and write) under the PAT's Repository permissions`,
  code_scanning_default_setup: `grant "Administration" or "Code scanning alerts" (read and write) under the PAT's Repository permissions; ${CODE_SCANNING_CAVEAT}`,
  code_quality_setup: `grant "Administration" (read and write) under the PAT's Repository permissions; ${CODE_QUALITY_CAVEAT}`,
  collaborators: `grant "Administration" (read and write) under the PAT's Repository permissions`,
  teams: `grant "Members" (read) under the PAT's Organization permissions and "Administration" (read and write) under its Repository permissions`,
  milestones: `grant "Issues" (read and write) under the PAT's Repository permissions`,
  interaction_limits: `grant "Administration" (read and write) under the PAT's Repository permissions`,
  actions_variables: `grant "Variables" (read and write) under the PAT's Repository permissions`,
  agents_variables: `grant "Agent variables" (read and write) under the PAT's Repository permissions`,
  webhooks: `grant "Webhooks" (read and write) under the PAT's Repository permissions`,
  custom_properties: `grant "Custom properties" (read and write) under the PAT's Repository permissions`,
  deploy_keys: `grant "Administration" (read and write) under the PAT's Repository permissions`,
  secret_scanning_custom_patterns: `grant "Secret scanning alerts" (read and write) under the PAT's Repository permissions`,
};

describe("section permissions", () => {
  test("every knobbed section's shape parses both forms and yields a default policy", () => {
    // The knob invariant is mostly compile-time: UNDECLARED_POLICY_SECTIONS
    // is pinned to the SettingsFile types in both directions (schema.ts),
    // and SectionMeta's conditional undeclaredDefault type forces "delete"
    // or "keep" exactly for listed sections. The zod shapes are the one
    // runtime-only piece: merge.ts wraps unconditionally for every listed
    // key, so a listed section whose shape only accepted the plain array
    // would reject its own normalized declaration - and only in multi-repo
    // mode (single-repo skips applyDefaults). Round-tripping both forms
    // here pins the shapes to the same list the merge drives off.
    const byKey = new Map(SECTIONS.map((module) => [module.key as string, module]));
    for (const key of UNDECLARED_POLICY_SECTIONS) {
      const module = byKey.get(key);
      if (!module) {
        throw new Error(`UNDECLARED_POLICY_SECTIONS names "${key}" but no module registers it`);
      }
      expect(module.shape.safeParse([]).success, `${key}: plain array form must parse`).toBe(true);
      expect(
        module.shape.safeParse({ entries: [] }).success,
        `${key}: wrapper without a policy must parse`,
      ).toBe(true);
      expect(
        module.shape.safeParse({ undeclared: "keep", entries: [] }).success,
        `${key}: wrapper with a policy must parse`,
      ).toBe(true);
      const policy = defaultUndeclaredPolicy(sectionModule(key));
      expect(
        ["keep", "delete"],
        `${key}: defaultUndeclaredPolicy returned "${policy}", expected "keep" or "delete"`,
      ).toContain(policy);
    }
  });

  test("every registered section declares a permission with at least one repo resource", () => {
    const offenders = SECTIONS.filter(
      (module) => module.permission === undefined || module.permission.repo.length === 0,
    ).map((module) => module.key);
    expect(
      offenders,
      `section(s) declaring a permission with no repo resource (add at least one PatResource to permission.repo): ${offenders.join(", ")}`,
    ).toEqual([]);
  });

  test("each section's grant caveat matches the pinned per-section caveats", () => {
    for (const module of SECTIONS) {
      expect(sectionGrant(module)).toBe(grantFor(module.permission, GRANT_CAVEATS[module.key]));
    }
  });

  test("each section's grant equals its exact pre-refactor literal", () => {
    // A section without an expected literal (a new one) fails here.
    expect(Object.keys(EXPECTED_GRANT).sort()).toEqual([...SECTION_KEYS].sort());
    for (const module of SECTIONS) {
      expect(sectionGrant(module)).toBe(EXPECTED_GRANT[module.key] ?? "");
    }
  });

  test("no endpoint keys a hint on 403/404 - the permission branch never reads hints", () => {
    // On permission-requiring endpoints, throwFor classifies 403/404 as
    // PermissionDenied before consulting `hints`, so an entry there is dead
    // advice; on a public ("none") endpoint the generic branch WOULD render
    // it, which is why 403/404 hints are forbidden outright - ambiguity on
    // those statuses belongs in `denialHint` (see the EndpointDecl JSDoc).
    // HintableStatus rejects a fresh 403/404 literal - the inline `as const
    // satisfies` declarations every section currently uses - at the
    // declaration site. It cannot catch a NON-FRESH assignment: a hoisted
    // const with a mixed key set ({422: legal, 403: illegal} is non-fresh
    // and the shared 422 satisfies the weak-type check), or one annotated
    // Record<number, string> (the index signature suppresses that check),
    // compiles - and sections already hoist shared hint strings, so this
    // sweep stays as the runtime backstop for the hoisted-object path.
    for (const [key, endpoint] of Object.entries(allEndpoints())) {
      for (const status of Object.keys(endpoint.hints ?? {})) {
        expect(
          ["403", "404"].includes(status),
          `${key} keys a hint on ${status}, which the permission branch swallows; use denialHint`,
        ).toBe(false);
      }
    }
  });

  test("sections declaring the same route agree on its contract", () => {
    // GET /orgs/{org} is declared by more than one section, and the mock
    // resolves a request to the FIRST matching declaration - a sibling that
    // later diverged (an extra status, a different permission) would be
    // silently validated against the other section's contract and no test
    // would notice. Group by route and require the contract fields agree.
    const byRoute = new Map<string, Array<{ key: string; contract: string }>>();
    const sectionPermission = new Map(SECTIONS.map((section) => [section.key, section.permission]));
    // Deep key sort: a replacer ARRAY would filter nested keys (statuses'
    // "200"), so canonicalize recursively instead.
    const canonical = (value: unknown): unknown =>
      Array.isArray(value)
        ? value.map(canonical)
        : value !== null && typeof value === "object"
          ? Object.fromEntries(
              Object.entries(value)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([k, v]) => [k, canonical(v)]),
            )
          : value;
    for (const [key, endpoint] of Object.entries(allEndpoints())) {
      // The WHOLE declaration minus the route itself and the injected
      // bookkeeping: a hand-picked field list would let a later EndpointDecl
      // addition (alwaysRewrite feeds the idempotence proof through the same
      // first-match resolution) diverge uncovered. The EFFECTIVE permission
      // rides along too - two declarations can both omit an override while
      // inheriting different section permissions, and the mock gates on the
      // first match.
      const { route: _route, section, role: _role, ...rest } = endpoint;
      const projected = { ...rest, effective: rest.permission ?? sectionPermission.get(section) };
      const contract = JSON.stringify(canonical(projected));
      const group = byRoute.get(endpoint.route) ?? [];
      group.push({ key, contract });
      byRoute.set(endpoint.route, group);
    }
    for (const [route, group] of byRoute) {
      if (group.length < 2) {
        continue;
      }
      const [first, ...rest] = group;
      for (const sibling of rest) {
        expect(
          sibling.contract,
          `${sibling.key} and ${first?.key} both declare "${route}" but disagree on its contract; the mock resolves the first match, so they must stay identical`,
        ).toBe(first?.contract ?? "");
      }
    }
  });
});

describe("grantFor", () => {
  test("single repo resource", () => {
    const permission: SectionPermission = { repo: ["administration"] };
    expect(grantFor(permission)).toBe(
      `grant "Administration" (read and write) under the PAT's Repository permissions`,
    );
  });

  test("multiple repo resources with a caveat", () => {
    const permission: SectionPermission = { repo: ["administration", "code_scanning_alerts"] };
    expect(grantFor(permission, CODE_SCANNING_CAVEAT)).toBe(
      `grant "Administration" or "Code scanning alerts" (read and write) under the PAT's Repository permissions; ${CODE_SCANNING_CAVEAT}`,
    );
  });

  test("org variant (teams)", () => {
    const permission: SectionPermission = { repo: ["administration"], org: "members" };
    expect(grantFor(permission)).toBe(
      `grant "Members" (read) under the PAT's Organization permissions and "Administration" (read and write) under its Repository permissions`,
    );
  });
});

describe("section endpoints", () => {
  test("every registered section declares at least one endpoint", () => {
    const offenders = SECTIONS.filter((module) => Object.values(module.endpoints).length === 0).map(
      (module) => module.key,
    );
    expect(
      offenders,
      `section(s) declaring no endpoints (add their routes to ENDPOINTS): ${offenders.join(", ")}`,
    ).toEqual([]);
  });

  test("every declared endpoint is well-formed", () => {
    const methods = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
    const problems: string[] = [];
    for (const module of SECTIONS) {
      for (const [role, endpoint] of Object.entries(module.endpoints)) {
        const tag = `${module.key}.${role} ("${endpoint.route}")`;
        const [method, path] = endpoint.route.split(" ");
        if (!methods.has(method ?? "")) {
          problems.push(`${tag}: method "${method}" is not one of GET/POST/PUT/PATCH/DELETE`);
        }
        // Absolute path with no query string; only balanced {param} tokens.
        if (!path?.startsWith("/")) {
          problems.push(`${tag}: path "${path}" does not start with "/"`);
        }
        if (path?.includes("?")) {
          problems.push(
            `${tag}: path "${path}" carries a query string; pass queries at the call site`,
          );
        }
        for (const segment of (path ?? "").split("/").filter(Boolean)) {
          const hasBrace = segment.includes("{") || segment.includes("}");
          if (hasBrace && !/^{[a-z_]+}$/.test(segment)) {
            // A templated segment is exactly one {param} token, nothing else.
            problems.push(
              `${tag}: templated segment "${segment}" is not exactly one {param} token`,
            );
          }
        }
        const statusEntries = Object.entries(endpoint.statuses);
        if (statusEntries.length === 0) {
          problems.push(`${tag}: declares no statuses`);
        }
        for (const [statusKey, meaning] of statusEntries) {
          const status = Number(statusKey);
          if (!Number.isInteger(status) || status < 100 || status >= 600) {
            problems.push(`${tag}: status "${statusKey}" is not an integer in 100-599`);
          }
          // Every status carries a non-empty prose meaning.
          if (typeof meaning !== "string" || meaning.length === 0) {
            problems.push(`${tag}: status ${statusKey} carries no prose meaning`);
          }
        }
      }
    }
    expect(problems, `malformed endpoint declaration(s):\n  ${problems.join("\n  ")}`).toEqual([]);
  });

  test("endpointKind derives read for GET and write for everything else", () => {
    expect(endpointKind({ route: "GET /repos/{owner}/{repo}", statuses: { 200: "x" } })).toBe(
      "read",
    );
    expect(
      endpointKind({ route: "POST /repos/{owner}/{repo}/labels", statuses: { 201: "x" } }),
    ).toBe("write");
    expect(
      endpointKind({ route: "DELETE /repos/{owner}/{repo}/labels/{name}", statuses: { 204: "x" } }),
    ).toBe("write");
  });

  test("an accessGrade override write-gates a GET", () => {
    expect(
      endpointKind({
        route: "GET /repos/{owner}/{repo}/codespaces/secrets",
        statuses: { 200: "x" },
        accessGrade: "write",
      }),
    ).toBe("write");
  });

  test("toleratedStatuses returns exactly the declared tolerable statuses", () => {
    // This pins the invariant the helpers rely on: tolerances are derived
    // from the declared statuses, never wider.
    expect(
      toleratedStatuses({
        route: "GET /repos/{owner}/{repo}/private-vulnerability-reporting",
        statuses: { 200: "a", 404: "b", 422: "c" },
      }),
    ).toEqual([404, 422]);
    expect(
      toleratedStatuses({
        route: "PATCH /repos/{owner}/{repo}/code-scanning/default-setup",
        statuses: { 200: "a", 202: "b", 409: "c" },
      }),
    ).toEqual([409]);
    // No error statuses declared -> nothing tolerated.
    expect(
      toleratedStatuses({
        route: "DELETE /repos/{owner}/{repo}/labels/{name}",
        statuses: { 204: "a" },
      }),
    ).toEqual([]);
  });

  test("only the known endpoints carry a permission override", () => {
    // An override equal to the section permission would be redundant; this
    // guards against redundant or stray overrides creeping in. Exactly these
    // endpoints in the whole registry legitimately override: the branches
    // probe (Contents) and its public App-by-slug bypass-actor lookup, the
    // teams org read (Members), the OIDC subject
    // claim pair (Actions instead of Administration), the environments
    // deployment branch-policy patterns and custom deployment protection
    // rules (Actions for the list reads, Administration for the
    // available-Apps read and the writes), and the custom_properties reads
    // (the org probe is public and the values GET is Metadata-gated only,
    // so both are "none").
    const overridden = Object.entries(allEndpoints())
      .filter(([, endpoint]) => endpoint.permission !== undefined)
      .map(([key]) => key);
    expect(overridden.sort()).toEqual([
      "actions.getOidcSub",
      "actions.putOidcSub",
      "branches.appLookup",
      "branches.branchProbe",
      "custom_properties.list",
      "custom_properties.org",
      "environments.createPolicy",
      "environments.createProtectionRule",
      "environments.listPolicies",
      "environments.listProtectionRuleApps",
      "environments.listProtectionRules",
      "environments.removePolicy",
      "environments.removeProtectionRule",
      "teams.org",
    ]);
  });

  test("endpointPermission resolves override, else section permission", () => {
    const section: SectionMeta = {
      key: "branches",
      permission: { repo: ["administration"] },
      endpoints: {},
      undeclaredDefault: "untouched",
    };
    // No override -> the section's permission. The declarations are typed
    // consts because endpointPermission now takes the FailingOp facet, and a
    // fresh literal's route/statuses would trip the excess-property check.
    const plain: EndpointDecl = { route: "GET /repos/{owner}/{repo}", statuses: { 200: "x" } };
    expect(endpointPermission(section, plain)).toEqual({ repo: ["administration"] });
    // A repo override wins.
    const overridden: EndpointDecl = {
      route: "GET /repos/{owner}/{repo}/branches/{branch}",
      statuses: { 200: "x" },
      permission: { repo: ["contents"] },
    };
    expect(endpointPermission(section, overridden)).toEqual({ repo: ["contents"] });
    // "none" (public) wins.
    const publicEndpoint: EndpointDecl = {
      route: "GET /orgs/{org}",
      statuses: { 200: "x" },
      permission: "none",
    };
    expect(endpointPermission(section, publicEndpoint)).toBe("none");
  });
});

describe("allEndpoints", () => {
  test("flattens every section endpoint under a unique section.role key", () => {
    const all = allEndpoints();
    const keys = Object.keys(all);
    // At least one entry per section, and 55+ overall.
    expect(keys.length).toBeGreaterThanOrEqual(55);
    // Every key is ${sectionKey}.${role}; keys are unique by construction.
    for (const key of keys) {
      expect(key).toMatch(/^[a-z_]+\.[a-zA-Z]+$/);
    }
    expect(new Set(keys).size).toBe(keys.length);
    // Each entry is tagged with its owning section and role, and the counts
    // reconcile with the per-section dictionaries.
    let total = 0;
    for (const module of SECTIONS) {
      total += Object.keys(module.endpoints).length;
    }
    expect(keys.length).toBe(total);
    for (const [key, endpoint] of Object.entries(all)) {
      expect(key).toBe(`${endpoint.section}.${endpoint.role}`);
      expect(endpoint.statuses).toBeDefined();
    }
  });

  test("the returned view is frozen so a consumer cannot corrupt declarations", () => {
    const all = allEndpoints();
    const entry = all["labels.update"];
    expect(entry).toBeDefined();
    expect(Object.isFrozen(all)).toBe(true);
    expect(Object.isFrozen(entry)).toBe(true);
    expect(Object.isFrozen(entry?.statuses)).toBe(true);
    // A mutation attempt through the view throws in strict mode (test files
    // are ES modules, hence strict) and leaves the source declaration intact.
    expect(() => {
      (entry as unknown as { role: string }).role = "hacked";
    }).toThrow();
    // The section's own declaration is unchanged.
    const labels = SECTIONS.find((s) => s.key === "labels");
    expect(labels?.endpoints.update?.route).toBe("PATCH /repos/{owner}/{repo}/labels/{name}");
  });
});

describe("allGraphqlOps", () => {
  /** The injectable section slice allGraphqlOps takes. */
  type SectionSlice = NonNullable<Parameters<typeof allGraphqlOps>[0]>[number];

  /** A minimal section slice carrying just what the flattener reads. */
  function graphqlSection(
    key: string,
    graphql: SectionSlice["graphql"],
    endpoints: SectionSlice["endpoints"] = {},
  ): SectionSlice {
    return { key: key as (typeof SECTION_KEYS)[number], endpoints, graphql };
  }

  const op = (name: string): GraphqlOpDecl & { kind: "read" } => ({
    name,
    kind: "read",
    query: `query ${name} { viewer { login } }`,
    outcomes: { ok: "x" },
  });

  test("flattens, tags, and freezes like allEndpoints", () => {
    const ops = allGraphqlOps([graphqlSection("repository", { toggles: op("RepoToggles") })]);
    const tagged = ops["repository.toggles"];
    expect(tagged).toBeDefined();
    expect(tagged?.section).toBe("repository");
    expect(tagged?.role).toBe("toggles");
    expect(Object.isFrozen(ops)).toBe(true);
    expect(Object.isFrozen(tagged)).toBe(true);
    expect(Object.isFrozen(tagged?.outcomes)).toBe(true);
  });

  test("a duplicate operation name across sections fails at construction", () => {
    expect(() =>
      allGraphqlOps([
        graphqlSection("repository", { toggles: op("RepoToggles") }),
        graphqlSection("branches", { rules: op("RepoToggles") }),
      ]),
    ).toThrow(
      /operation name "RepoToggles" is declared by both repository\.toggles and branches\.rules/,
    );
  });

  test("a role colliding with a REST endpoint role in the same section fails", () => {
    expect(() =>
      allGraphqlOps([
        graphqlSection(
          "repository",
          { get: op("RepoToggles") },
          { get: { route: "GET /repos/{owner}/{repo}", statuses: { 200: "x" } } },
        ),
      ]),
    ).toThrow(/declares both a REST endpoint and a GraphQL operation under the role "get"/);
  });

  test("a declared connection whose query takes no $cursor does not compile", () => {
    // The cursor contract moved from a construction assert into the type:
    // GraphqlPaginatedReadDecl's query template requires the $cursor variable
    // listGraphqlConnection's loop feeds.
    // @ts-expect-error - a connection op without $cursor in its query
    const paginated: GraphqlPaginatedReadDecl = {
      ...op("RepoRules"),
      connection: { path: ["repository", "rules"] },
    };
    void paginated;
    const cursored: GraphqlPaginatedReadDecl = {
      ...op("RepoRules"),
      query: "query RepoRules($cursor: String) { viewer { login } }",
      connection: { path: ["repository", "rules"] },
    };
    expect(() => allGraphqlOps([graphqlSection("repository", { rules: cursored })])).not.toThrow();
  });
});

describe("typed params (compile-time guards)", () => {
  // These assertions are about the TYPE checker, not runtime; the bodies
  // never execute. A route with a path param must require params; a route
  // without one must forbid them AND allow omitting opts entirely.
  const section = {} as SectionMeta;
  const ctx = {} as SectionContext;
  const withName = {
    route: "PATCH /repos/{owner}/{repo}/labels/{name}",
    statuses: { 200: "x" },
  } satisfies EndpointDecl;
  const noParams = {
    route: "GET /repos/{owner}/{repo}/labels",
    statuses: { 200: "x" },
  } satisfies EndpointDecl;

  test("type guards hold", () => {
    // The assertions below are checked by tsc via @ts-expect-error; the body
    // is guarded by a runtime-false condition so nothing actually executes.
    const neverRuns = false as boolean;
    if (neverRuns) {
      // Omitting opts entirely for a route that needs {name} is a compile error.
      // @ts-expect-error - params argument is required for a {name} route
      void call(ctx, section, withName);
      // Providing opts but omitting params is a compile error.
      // @ts-expect-error - params is required inside opts
      void call(ctx, section, withName, {});
      // The correct call type-checks.
      void call(ctx, section, withName, { params: { name: "bug" } });
      // A token-less route allows omitting opts entirely.
      void call(ctx, section, noParams);
      // ...and forbids a stray params key.
      // @ts-expect-error - a token-less route has no params
      void call(ctx, section, noParams, { params: { name: "bug" } });
    }
    expect(true).toBe(true);
  });
});

describe("matchesTemplate", () => {
  test("every {token} consumes exactly one segment", () => {
    expect(matchesTemplate("/repos/{owner}/{repo}/labels", "/repos/o/r/labels")).toBe(true);
    // A missing segment does not match.
    expect(matchesTemplate("/repos/{owner}/{repo}/labels", "/repos/o/labels")).toBe(false);
    // A trailing segment beyond the template does not match.
    expect(matchesTemplate("/repos/{owner}/{repo}/labels", "/repos/o/r/labels/bug")).toBe(false);
  });

  test("a name param consumes exactly one segment", () => {
    expect(matchesTemplate("/repos/{owner}/{repo}/labels/{name}", "/repos/o/r/labels/bug")).toBe(
      true,
    );
    expect(matchesTemplate("/repos/{owner}/{repo}/labels/{name}", "/repos/o/r/labels/a/b")).toBe(
      false,
    );
  });

  test("the teams path shape matches (org, team_slug, owner, repo)", () => {
    expect(
      matchesTemplate(
        "/orgs/{org}/teams/{team_slug}/repos/{owner}/{repo}",
        "/orgs/acme/teams/core/repos/o/r",
      ),
    ).toBe(true);
  });

  test("literal segments must match exactly", () => {
    expect(matchesTemplate("/repos/{owner}/{repo}/pages", "/repos/o/r/pages")).toBe(true);
    expect(matchesTemplate("/repos/{owner}/{repo}/pages", "/repos/o/r/topics")).toBe(false);
  });

  test("the query string is ignored", () => {
    expect(
      matchesTemplate("/repos/{owner}/{repo}/milestones", "/repos/o/r/milestones?state=all"),
    ).toBe(true);
  });

  test("every declared route path matches its own expanded concrete path", () => {
    // Construction parity: each route template matches the path it expands to.
    const ctx: SectionContext = {
      api: { tryRequest: async () => ({ data: null }), tryGraphql: async () => ({ data: {} }) },
      repo: { owner: "octo", name: "repo", slug: "octo/repo" },
      check: true,
    };
    const mismatches: string[] = [];
    for (const endpoint of Object.values(allEndpoints())) {
      const tokens = [...endpointPath(endpoint.route).matchAll(/{([a-z_]+)}/g)]
        .map((m) => m[1])
        .filter((t) => t !== "owner" && t !== "repo");
      const params = Object.fromEntries(tokens.map((t) => [t as string, "x"]));
      const concrete = expand(endpoint, ctx, params);
      if (!matchesTemplate(endpointPath(endpoint.route), concrete)) {
        mismatches.push(
          `${endpoint.section}.${endpoint.role}: expanded path "${concrete}" does not match its own template "${endpointPath(endpoint.route)}"`,
        );
      }
    }
    expect(
      mismatches,
      `endpoint route(s) whose expansion diverges from their own template:\n  ${mismatches.join("\n  ")}`,
    ).toEqual([]);
  });
});

describe("expand", () => {
  const ctx = (): SectionContext => ({
    api: { tryRequest: async () => ({ data: null }), tryGraphql: async () => ({ data: {} }) },
    repo: { owner: "octo", name: "repo", slug: "octo/repo" },
    check: true,
  });

  test("{owner} and {repo} fill from ctx (repo is the name half)", () => {
    const endpoint: EndpointDecl = {
      route: "GET /repos/{owner}/{repo}/labels",
      statuses: { 200: "x" },
    };
    expect(expand(endpoint, ctx())).toBe("/repos/octo/repo/labels");
  });

  test("a {param} is URL-encoded", () => {
    const endpoint: EndpointDecl = {
      route: "PATCH /repos/{owner}/{repo}/labels/{name}",
      statuses: { 200: "x" },
    };
    expect(expand(endpoint, ctx(), { name: "needs review/100%" })).toBe(
      "/repos/octo/repo/labels/needs%20review%2F100%25",
    );
  });

  test("a missing param throws", () => {
    const endpoint: EndpointDecl = {
      route: "PATCH /repos/{owner}/{repo}/labels/{name}",
      statuses: { 200: "x" },
    };
    expect(() => expand(endpoint, ctx())).toThrow(/needs a "name" param/);
  });

  test("an extra (unused) param throws", () => {
    const endpoint: EndpointDecl = {
      route: "GET /repos/{owner}/{repo}/labels",
      statuses: { 200: "x" },
    };
    expect(() => expand(endpoint, ctx(), { name: "bug" })).toThrow(/unused param/);
  });

  test("a query is appended, encoded", () => {
    const endpoint: EndpointDecl = {
      route: "GET /repos/{owner}/{repo}/milestones",
      statuses: { 200: "x" },
    };
    expect(expand(endpoint, ctx(), undefined, { state: "all" })).toBe(
      "/repos/octo/repo/milestones?state=all",
    );
  });
});

describe("probeAbsent tolerance derivation", () => {
  const section: SectionMeta = {
    key: "repository",
    permission: { repo: ["administration"] },
    endpoints: {},
    undeclaredDefault: "untouched",
  };
  const ctxWith = (status: number): SectionContext => ({
    api: {
      tryRequest: async () => ({ error: { status, message: "nope", body: "" } }),
      tryGraphql: async () => ({ error: { status, message: "nope", body: "" } }),
    },
    repo: { owner: "octo", name: "repo", slug: "octo/repo" },
    check: true,
  });

  test("without an explicit tolerate, a declared tolerable status reads as missing", async () => {
    // 404 and 422 are declared, so both are tolerated automatically.
    const endpoint = {
      route: "GET /repos/{owner}/{repo}/private-vulnerability-reporting",
      statuses: { 200: "a", 404: "b", 422: "c" },
    } satisfies EndpointDecl;
    expect(await probeAbsent(ctxWith(404), section, endpoint)).toEqual({ missing: true });
    expect(await probeAbsent(ctxWith(422), section, endpoint)).toEqual({ missing: true });
  });

  test("without an explicit tolerate, an undeclared error status throws", async () => {
    // 404 is NOT declared here, so it is a real failure, not "missing".
    const endpoint = {
      route: "GET /repos/{owner}/{repo}/vulnerability-alerts",
      statuses: { 204: "a" },
    } satisfies EndpointDecl;
    await expect(probeAbsent(ctxWith(404), section, endpoint)).rejects.toThrow();
  });
});

describe("owner sensitivity", () => {
  test('ownerSensitivity: "org" agrees with the tolerated-404 org probe on every section', () => {
    // The bare GET /orgs/{org} probe with a tolerated 404 ("not an
    // organization") is the MECHANISM behind the personal-account no-op the
    // ownerSensitivity declaration models (the oracle folds on the
    // declaration, the handler acts on the probe). The two must never
    // disagree: a declared sensitivity without the probe would predict a
    // no-op the handler cannot perform, and a probe without the declaration
    // would hide the no-op from the oracle.
    const ORG_PROBE = "GET /orgs/{org}";
    for (const section of SECTIONS) {
      const hasProbe = Object.values(section.endpoints).some(
        (endpoint) => endpoint.route === ORG_PROBE && toleratedStatuses(endpoint).includes(404),
      );
      expect(
        section.ownerSensitivity === "org",
        `section "${section.key}": ownerSensitivity ("${section.ownerSensitivity ?? "default"}") and the tolerated-404 org probe (present: ${hasProbe}) must agree`,
      ).toBe(hasProbe);
    }
  });

  test("the org-only set is exactly teams and custom_properties today", () => {
    const declared = SECTIONS.filter((s) => s.ownerSensitivity === "org").map((s) => s.key);
    expect(declared.sort()).toEqual(["custom_properties", "teams"]);
  });
});

describe("the section.role key space reserves ':'", () => {
  /** The injectable section slice allEndpoints takes. */
  type EndpointSlice = NonNullable<Parameters<typeof allEndpoints>[0]>[number];

  function endpointSection(key: string, endpoints: EndpointSlice["endpoints"]): EndpointSlice {
    return { key: key as (typeof SECTION_KEYS)[number], endpoints };
  }
  const LIST = { route: "GET /repos/{owner}/{repo}/labels", statuses: { 200: "x" } } as const;

  test("a role containing ':' fails allEndpoints at construction", () => {
    expect(() => allEndpoints([endpointSection("labels", { "ring:list": LIST })])).toThrow(
      /role "ring:list" contains ":".*reserves.*scope prefix/,
    );
  });

  test("a section key containing ':' fails both flatteners", () => {
    expect(() => allEndpoints([endpointSection("prod:labels", { list: LIST })])).toThrow(
      /section key "prod:labels" contains ":"/,
    );
    expect(() =>
      allGraphqlOps([{ key: "prod:labels" as (typeof SECTION_KEYS)[number], endpoints: {} }]),
    ).toThrow(/section key "prod:labels" contains ":"/);
  });

  test("the live registry passes every construction assert of both flatteners", () => {
    // Colon-free keys and roles, plus the GraphQL declaration asserts: the
    // calls themselves prove the asserts hold over the live registry, and
    // the first section to declare GraphQL operations inherits the check.
    expect(() => allEndpoints()).not.toThrow();
    expect(() => allGraphqlOps()).not.toThrow();
  });
});

describe("handler contracts", () => {
  test("a module declares plan() and nothing else handles", () => {
    // Compile-time only: the bodies never run.
    const base = {
      key: "workflows",
      undeclaredDefault: "untouched",
      permission: { repo: ["actions"] },
      endpoints: {},
      shape: workflowsSection.shape,
    } as const;
    const planOnly = {
      ...base,
      async plan(_ctx: PlanContext): Promise<SectionPlan> {
        return { ops: [], notes: [], drift: [] };
      },
    } satisfies SectionModule<"workflows">;
    const _withRun = {
      ...planOnly,
      // @ts-expect-error a run() handler is not part of the contract
      async run(_ctx: SectionContext) {
        return { check: true as const, drift: [], notes: [] };
      },
    } satisfies SectionModule<"workflows">;
    // A non-literal value carrying run() is refused too: the excess-property check alone would
    // pass it, so the contract pins run to never.
    const aliased = { ...planOnly, run: () => {} };
    // @ts-expect-error run is pinned to never on the contract
    const _aliased: SectionModule<"workflows"> = aliased;
    // @ts-expect-error a module without plan() is not a section
    const _neither = { ...base } satisfies SectionModule<"workflows">;
    expect(SECTIONS.map((s) => s.key)).toContain("workflows");
  });

  test("the exactness tripwire names a module whose plan() is typed over another section's value", () => {
    // The registry's _PlanModulesAreExact pin is only as good as its check: the shipped
    // workflows module measures exact, and the same module with plan() taking labels'
    // declared value measures misdeclared, so a passing pin means every module was compared.
    type Exact = MustBeNever<MisdeclaredPlanModule<"workflows", typeof workflowsSection>>;
    const misdeclared = {
      ...workflowsSection,
      async plan(
        _ctx: PlanContext<typeof workflowsSection.endpoints>,
        _desired: Exclude<SettingsFile["labels"], undefined>,
      ) {
        return { ops: [], notes: [], drift: [] };
      },
    };
    // @ts-expect-error a plan() over labels' value is not exact for workflows
    type Wrong = MustBeNever<MisdeclaredPlanModule<"workflows", typeof misdeclared>>;
    const witness: [Exact, Wrong] | undefined = undefined;
    expect(witness).toBeUndefined();
  });

  test("every reading section declares exactly one primaryRead, and its 404 posture derives from it", () => {
    // denialPosture throws on a missing or repeated posture, so the call is the assertion; a
    // section with no read of either kind classifies nothing before its first write ("absent").
    const declaring: string[] = [];
    for (const section of SECTIONS) {
      const primaries = Object.entries(section.endpoints).filter(
        ([, endpoint]) => endpoint.primaryRead !== undefined,
      );
      const reads = sectionOperations(section).some((op) => op.wire === "read");
      const posture = denialPosture(section);
      expect(primaries.length, `${section.key} primaryRead declarations`).toBe(reads ? 1 : 0);
      if (!reads) {
        expect(posture, `${section.key} declares no read`).toBe("absent");
      }
      for (const [role, endpoint] of primaries) {
        expect(endpoint.route.startsWith("GET "), `${section.key}.${role} is not a read`).toBe(
          true,
        );
        expect(endpoint.primaryRead?.notFound).toBe(posture);
        if (posture === "absent") {
          // An "absent" posture means a 404 reads as "no such resource",
          // which holds only if the endpoint tolerates 404 - the request
          // helpers derive their tolerated set from the declared statuses.
          expect(
            toleratedStatuses(endpoint),
            `${section.key}.${role} claims an "absent" 404 posture but does not declare 404 among its statuses, so the helper would classify it as a denial`,
          ).toContain(404);
        }
        declaring.push(section.key);
      }
    }
    // Every section with a REST read declares exactly one primaryRead.
    expect(declaring).toEqual(
      SECTIONS.filter((s) =>
        Object.values(s.endpoints).some((e) => endpointMethod(e.route) === "GET"),
      ).map((s) => s.key),
    );
  });
});
