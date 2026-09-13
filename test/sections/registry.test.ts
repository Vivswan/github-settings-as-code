import { describe, expect, test } from "bun:test";
import {
  type SECTION_KEYS,
  type SettingsFile,
  UNDECLARED_POLICY_SECTIONS,
} from "../../src/schema.js";
import type { checkSuitePreferencesSection } from "../../src/sections/check_suite_preferences/index.js";
import {
  type EndpointDecl,
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
  denialPosture,
  endpointPermission,
  type GraphqlDict,
  planningReads,
  type SectionContext,
  type SectionMeta,
  type SectionModule,
} from "../../src/sections/contract/module.js";
import { grantFor, type SectionPermission } from "../../src/sections/contract/permissions.js";
import type {
  PlanContext,
  SectionPlan,
  SnapshotContext,
} from "../../src/sections/contract/plan.js";
import { call, probeAbsent } from "../../src/sections/contract/requests.js";
import { labelsSection } from "../../src/sections/labels/index.js";
import {
  allEndpoints,
  allGraphqlOps,
  type MisdeclaredPlanModule,
  type MisdeclaredSnapshotModule,
  type ReadingModuleWithoutSnapshot,
  SECTIONS,
  sectionShape,
} from "../../src/sections/registry.js";
import { workflowsSection } from "../../src/sections/workflows/index.js";
import type { MustBeNever } from "../../src/types.js";
import { denialResponse } from "../e2e/mock/grading.js";

/** The identity facet of a list section's declaration, as the erased registry view exposes it. */
interface ListDeclView {
  readonly identity: {
    readonly field: string;
    readonly fold: (name: string) => string;
    readonly renameKey?: string;
    readonly aliases?: (entry: object) => readonly string[];
  };
}

const CODE_SCANNING_CAVEAT =
  "a 403 on this endpoint can also mean GitHub Advanced Security (code security) is not enabled on the repository, or the repository is archived";

describe("section permissions", () => {
  test("every knobbed section's shape parses both forms", () => {
    // UNDECLARED_POLICY_SECTIONS is pinned to the types at compile time (schema.ts, SectionMeta's undeclaredDefault); the zod shapes are the one
    // piece only a runtime round-trip can check.
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
        module.shape.safeParse({ _undeclared: "keep", entries: [] }).success,
        `${key}: wrapper with a policy must parse`,
      ).toBe(true);
    }
  });

  test("_layering is accepted on every top-level knobbed wrapper and rejected on the nested ones", () => {
    // A list nested in an entry is replaced wholesale by the merge, so a _layering accepted there would validate and never act.
    const wrapper = { entries: [], _layering: "merge" };
    const nested = {
      deployment_branch_policies: wrapper,
      deployment_protection_rules: wrapper,
      variables: wrapper,
      secrets: wrapper,
    };
    const verdict = sectionShape("environments").safeParse([{ name: "prod", ...nested }]);
    expect({
      topLevel: Object.fromEntries(
        UNDECLARED_POLICY_SECTIONS.map((key) => [
          key,
          sectionShape(key).safeParse(wrapper).success,
        ]),
      ),
      nested: verdict.success
        ? "accepted"
        : verdict.error.issues.map((issue) => [issue.path.join("."), issue.message]).sort(),
    }).toEqual({
      topLevel: Object.fromEntries(UNDECLARED_POLICY_SECTIONS.map((key) => [key, true])),
      nested: Object.keys(nested)
        .map((list) => [
          `0.${list}`,
          'Unrecognized key: "_layering"; the wrapper\'s directives are "_undeclared" and, on a top-level section, "_layering", and nothing else - there are no private-note keys. Remove the key, or keep the note as a YAML comment',
        ])
        .sort(),
    });
  });

  test("a layered section is knobbed, and its layering keys are the identities its planner folds and claims", () => {
    // The merge pairs entries by these keys and the planner by the folded identity plus its aliases (a rename's old name), so a key the
    // planner would not claim pairs entries it treats as distinct, or leaves a document it refuses.
    const knobbed: readonly string[] = UNDECLARED_POLICY_SECTIONS;
    const entries: Record<string, string>[] = [
      { name: "Bug" },
      { name: "Bug", new_name: "Defect" },
    ];
    const at = (entry: Record<string, string>, field: string | undefined): string | undefined =>
      field === undefined ? undefined : entry[field];
    const layered = SECTIONS.filter((module) => module.layering !== undefined);
    expect(layered.length).toBeGreaterThan(0);
    for (const module of layered) {
      const layering = module.layering;
      if (layering === undefined) {
        continue;
      }
      expect(knobbed, `${module.key} layers without the undeclared knob`).toContain(module.key);
      const identity = "decl" in module ? (module.decl as ListDeclView).identity : undefined;
      for (const entry of entries) {
        const claimed =
          identity === undefined
            ? [at(entry, layering.keyField) ?? ""]
            : [
                identity.fold(at(entry, identity.renameKey) ?? at(entry, identity.field) ?? ""),
                ...(identity.aliases?.(entry) ?? []).map(identity.fold),
              ];
        expect(layering.keys(entry), `${module.key} keys of ${JSON.stringify(entry)}`).toEqual(
          claimed,
        );
      }
    }
  });

  test("no endpoint keys a hint on 403/404 - the permission branch never reads hints", () => {
    // throwFor classifies 403/404 as PermissionDenied before reading `hints`, so a hint there is dead advice; ambiguity on those statuses goes in
    // `denialHint`. HintableStatus misses a hoisted hints object that also carries a permitted key, and sections hoist shared hints, so this sweep
    // is the runtime backstop.
    for (const [key, endpoint] of Object.entries(allEndpoints())) {
      for (const status of Object.keys(endpoint.hints ?? {})) {
        expect(
          ["403", "404"].includes(status),
          `${key} keys a hint on ${status}, which the permission branch swallows; use denialHint`,
        ).toBe(false);
      }
    }
  });

  test("no definitive rejection spells a body the mock's denial gate answers", () => {
    // A rejection whose body a denial can carry would read a missing grant as the definite meaning, under every policy.
    const declared = Object.entries(allEndpoints()).flatMap(([key, endpoint]) =>
      (endpoint.rejections ?? []).map(
        (rejection) => [key, rejection.status, rejection.message] as const,
      ),
    );
    // The control: at least one declaration exists, or the sweep below proves nothing.
    expect(declared.length).toBeGreaterThan(0);
    const denials = (["fine_grained", 403, 404] as const).flatMap((style) =>
      (["read", "write"] as const).map((kind) => {
        const denial = denialResponse(style, kind);
        return [denial.status, (denial.body as { message: string }).message] as const;
      }),
    );
    for (const [key, status, message] of declared) {
      expect(
        denials,
        `${key} declares a body the mock's denial gate answers, so a denied request would read as definitive`,
      ).not.toContainEqual([status, message]);
    }
  });

  test("sections declaring the same route agree on its contract", () => {
    // The mock resolves a request to the FIRST matching declaration, so a sibling that diverged (GET /orgs/{org} is declared by two sections, teams
    // and custom_properties) would be validated against another section's contract unnoticed.
    const byRoute = new Map<string, Array<{ key: string; contract: string }>>();
    const sectionPermission = new Map(SECTIONS.map((section) => [section.key, section.permission]));
    // A JSON.stringify replacer ARRAY would filter nested keys (statuses' "200"), so canonicalize recursively.
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
      // The WHOLE wire declaration is compared, so a later EndpointDecl field cannot diverge uncovered; only the
      // 404 posture stays out, since it is the SECTION's (denialPosture reads it per section, never per route).
      // The effective permission rides along: two declarations can both omit an override while inheriting different section permissions.
      const { route: _route, section, role: _role, primaryRead: _posture, ...rest } = endpoint;
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
  test("every declared endpoint names at least one status, each an HTTP status with a prose meaning", () => {
    // The route itself is compile-checked against the OpenAPI-derived Route union; the statuses are a plain record, so only this sweep sees them.
    const problems: string[] = [];
    for (const module of SECTIONS) {
      for (const [role, endpoint] of Object.entries(module.endpoints)) {
        const tag = `${module.key}.${role} ("${endpoint.route}")`;
        const statusEntries = Object.entries(endpoint.statuses);
        if (statusEntries.length === 0) {
          problems.push(`${tag}: declares no statuses`);
        }
        for (const [statusKey, meaning] of statusEntries) {
          const status = Number(statusKey);
          if (!Number.isInteger(status) || status < 100 || status >= 600) {
            problems.push(`${tag}: status "${statusKey}" is not an integer in 100-599`);
          }
          if (typeof meaning !== "string" || meaning.length === 0) {
            problems.push(`${tag}: status ${statusKey} carries no prose meaning`);
          }
        }
      }
    }
    expect(problems, `malformed endpoint declaration(s):\n  ${problems.join("\n  ")}`).toEqual([]);
  });

  test("endpointPermission resolves override, else section permission", () => {
    const section: SectionMeta = {
      key: "branches",
      permission: { repo: ["administration"] },
      endpoints: {},
      undeclaredDefault: "untouched",
    };
    // Typed consts: endpointPermission takes the FailingOp facet, so a fresh literal's route/statuses would trip the excess-property check.
    const plain: EndpointDecl = { route: "GET /repos/{owner}/{repo}", statuses: { 200: "x" } };
    expect(endpointPermission(section, plain)).toEqual({ repo: ["administration"] });
    const overridden: EndpointDecl = {
      route: "GET /repos/{owner}/{repo}/branches/{branch}",
      statuses: { 200: "x" },
      permission: { repo: ["contents"] },
    };
    expect(endpointPermission(section, overridden)).toEqual({ repo: ["contents"] });
    const publicEndpoint: EndpointDecl = {
      route: "GET /orgs/{org}",
      statuses: { 200: "x" },
      permission: "none",
    };
    expect(endpointPermission(section, publicEndpoint)).toBe("none");
  });
});

describe("declarations are frozen at registration", () => {
  test("mutating any registered section's declaration throws, with no view called first", () => {
    // The module, endpoint, and op objects themselves are frozen by no view (the views freeze only the tagged copies they build), so a
    // frozen source here is freezeDeclarations' work alone. ES module test files are strict, so an assignment on a frozen object throws.
    const attempts: [string, () => void][] = [];
    let endpointCount = 0;
    for (const section of SECTIONS) {
      expect(Object.isFrozen(section), `${section.key} module`).toBe(true);
      attempts.push([
        `${section.key} permission`,
        () => {
          (section as { permission: unknown }).permission = "none";
        },
      ]);
      for (const [role, endpoint] of Object.entries(section.endpoints)) {
        endpointCount++;
        const tag = `${section.key}.${role}`;
        expect(Object.isFrozen(endpoint), tag).toBe(true);
        attempts.push(
          [
            `${tag} replace`,
            () => {
              (section.endpoints as Record<string, unknown>)[role] = {};
            },
          ],
          [
            `${tag} route`,
            () => {
              (endpoint as { route: string }).route = "DELETE /repos/{owner}/{repo}";
            },
          ],
          [
            `${tag} statuses`,
            () => {
              (endpoint.statuses as Record<number, string>)[299] = "hacked";
            },
          ],
        );
        if (endpoint.hints !== undefined) {
          attempts.push([
            `${tag} hints`,
            () => {
              (endpoint.hints as Record<number, string>)[422] = "hacked";
            },
          ]);
        }
        if (typeof endpoint.permission === "object") {
          attempts.push([
            `${tag} permission`,
            () => {
              (endpoint.permission as unknown as { repo: string[] }).repo.push("hacked");
            },
          ]);
        }
        if (endpoint.rejections !== undefined) {
          attempts.push([
            `${tag} rejections`,
            () => {
              (endpoint.rejections as unknown as object[]).push({});
            },
          ]);
        }
      }
      if (section.closedSurface !== undefined) {
        attempts.push([
          `${section.key} closedSurface.known`,
          () => {
            (section.closedSurface?.known as Record<string, true>).typo = true;
          },
        ]);
      }
      for (const [role, op] of Object.entries(section.graphql ?? {})) {
        const tag = `${section.key}.${role}`;
        expect(Object.isFrozen(op), tag).toBe(true);
        attempts.push(
          [
            `${tag} outcomes`,
            () => {
              (op.outcomes as Record<string, string>).ok = "hacked";
            },
          ],
          [
            `${tag} kind`,
            () => {
              (op as { kind: string }).kind = "write";
            },
          ],
        );
        if (op.connection !== undefined) {
          attempts.push([
            `${tag} connection`,
            () => {
              (op.connection as unknown as { path: string[] }).path.push("hacked");
            },
          ]);
        }
      }
    }
    expect(attempts.length).toBeGreaterThanOrEqual(SECTIONS.length + endpointCount * 3);
    for (const [what, mutate] of attempts) {
      expect(mutate, what).toThrow(TypeError);
    }
    // Control: the same assignment on a spread copy lands, so the throws come from the freeze and not from the assignments themselves.
    const copy: { route: string } = { ...labelsSection.endpoints.update };
    copy.route = "DELETE /repos/{owner}/{repo}";
    expect(copy.route).toBe("DELETE /repos/{owner}/{repo}");
    expect(labelsSection.endpoints.update.route).toBe("PATCH /repos/{owner}/{repo}/labels/{name}");
  });
});

describe("allEndpoints", () => {
  test("flattens every section endpoint under its section.role key, tagged with both", () => {
    const all = allEndpoints();
    const declared = SECTIONS.flatMap((section) =>
      Object.entries(section.endpoints).map(
        ([role, endpoint]) =>
          [`${section.key}.${role}`, { ...endpoint, section: section.key, role }] as const,
      ),
    );
    expect(declared.length).toBeGreaterThan(0);
    expect(Object.fromEntries(declared)).toEqual(all);
  });

  test("the returned view is frozen through every nested field, so a consumer cannot corrupt declarations", () => {
    const all = allEndpoints();
    const entry = all["labels.update"];
    expect(entry).toEqual({ ...labelsSection.endpoints.update, section: "labels", role: "update" });
    expect(Object.isFrozen(all)).toBe(true);
    expect(Object.isFrozen(entry)).toBe(true);
    // Assignment on a frozen object throws only in strict mode; ES module test files are strict.
    // Every nested facet a declaration can carry, on a real declaration that carries it.
    const nested: Record<string, () => void> = {
      role: () => {
        (entry as unknown as { role: string }).role = "hacked";
      },
      statuses: () => {
        (entry.statuses as Record<number, string>)[200] = "hacked";
      },
      primaryRead: () => {
        (all["labels.list"].primaryRead as { notFound: string }).notFound = "absent";
      },
      hints: () => {
        (all["deploy_keys.create"].hints as Record<number, string>)[422] = "hacked";
      },
      permission: () => {
        (all["branches.listProtected"].permission as unknown as { repo: string[] }).repo.push("x");
      },
      rejections: () => {
        (all["branches.putProtection"].rejections as unknown as { message: string }[])[0] = {
          message: "x",
        };
      },
    };
    for (const [facet, mutate] of Object.entries(nested)) {
      expect(mutate, facet).toThrow(TypeError);
    }
    const labels = SECTIONS.find((s) => s.key === "labels");
    expect(labels?.endpoints.update?.route).toBe("PATCH /repos/{owner}/{repo}/labels/{name}");
    // The source declaration is frozen with its view, so neither path can move a route.
    expect(Object.isFrozen(labels?.endpoints.update)).toBe(true);
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

  test("flattens, tags, and freezes through every nested field like allEndpoints", () => {
    const toggles = {
      ...op("RepoToggles"),
      query: "query RepoToggles($cursor: String) { viewer { login } }",
      permission: { repo: ["administration"] },
      connection: { path: ["repository", "rules"] },
    } satisfies GraphqlPaginatedReadDecl;
    const ops = allGraphqlOps([graphqlSection("repository", { toggles })]);
    expect(ops).toEqual({
      "repository.toggles": {
        name: "RepoToggles",
        kind: "read",
        query: "query RepoToggles($cursor: String) { viewer { login } }",
        outcomes: { ok: "x" },
        permission: { repo: ["administration"] },
        connection: { path: ["repository", "rules"] },
        section: "repository",
        role: "toggles",
      },
    });
    const tagged = ops["repository.toggles"];
    if (tagged === undefined) {
      throw new Error("the flattened op is missing");
    }
    expect(Object.isFrozen(ops)).toBe(true);
    expect(Object.isFrozen(tagged)).toBe(true);
    const nested: Record<string, () => void> = {
      outcomes: () => {
        (tagged.outcomes as Record<string, string>).ok = "hacked";
      },
      permission: () => {
        (tagged.permission as unknown as { repo: string[] }).repo.push("issues");
      },
      connection: () => {
        (tagged.connection as unknown as { path: string[] }).path.push("nodes");
      },
    };
    for (const [facet, mutate] of Object.entries(nested)) {
      expect(mutate, facet).toThrow(TypeError);
    }
    // The injected declaration is frozen with its view.
    expect(Object.isFrozen(toggles.connection.path)).toBe(true);
  });

  test("a duplicate operation name across sections fails at construction", () => {
    expect(() =>
      allGraphqlOps([
        graphqlSection("repository", { toggles: op("RepoToggles") }),
        graphqlSection("branches", { rules: op("RepoToggles") }),
      ]),
    ).toThrow(
      new Error(
        'BUG: GraphQL operation name "RepoToggles" is declared by both repository.toggles and branches.rules; operation names are the wire dispatch key and must be globally unique',
      ),
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
    ).toThrow(
      new Error(
        'BUG: section "repository" declares both a REST endpoint and a GraphQL operation under the role "get"; fault and corruption directives share the "section.role" key space, so roles must be distinct',
      ),
    );
  });

  test("a declared connection whose query takes no $cursor does not compile", () => {
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
    const neverRuns = false as boolean;
    if (neverRuns) {
      // @ts-expect-error - params argument is required for a {name} route
      void call(ctx, section, withName);
      // @ts-expect-error - params is required inside opts
      void call(ctx, section, withName, {});
      void call(ctx, section, withName, { params: { name: "bug" } });
      void call(ctx, section, noParams);
      // @ts-expect-error - a token-less route has no params
      void call(ctx, section, noParams, { params: { name: "bug" } });
    }
    expect(true).toBe(true);
  });
});

describe("matchesTemplate", () => {
  test("every {token} consumes exactly one segment", () => {
    expect(matchesTemplate("/repos/{owner}/{repo}/labels", "/repos/o/r/labels")).toBe(true);
    expect(matchesTemplate("/repos/{owner}/{repo}/labels", "/repos/o/labels")).toBe(false);
    expect(matchesTemplate("/repos/{owner}/{repo}/labels", "/repos/o/r/labels/bug")).toBe(false);
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

  test("without an explicit tolerate, an undeclared error status throws", async () => {
    const endpoint = {
      route: "GET /repos/{owner}/{repo}/vulnerability-alerts",
      statuses: { 204: "a" },
    } satisfies EndpointDecl;
    await expect(probeAbsent(ctxWith(404), section, endpoint)).rejects.toThrow();
  });
});

describe("owner sensitivity", () => {
  test('ownerSensitivity: "org" agrees with the tolerated-404 org probe on every section', () => {
    // The tolerated-404 org probe is the mechanism behind the personal-account no-op that ownerSensitivity declares to the oracle; one without the
    // other predicts a no-op the handler cannot perform, or hides one it does.
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
      new Error(
        'BUG: role "ring:list" contains ":", which the "section.role" key space reserves for a future scope prefix ("<scope>:<section>.<role>"); rename it without a colon',
      ),
    );
  });

  test("a section key containing ':' fails both flatteners", () => {
    const colonKey = new Error(
      'BUG: section key "prod:labels" contains ":", which the "section.role" key space reserves for a future scope prefix ("<scope>:<section>.<role>"); rename it without a colon',
    );
    expect(() => allEndpoints([endpointSection("prod:labels", { list: LIST })])).toThrow(colonKey);
    expect(() =>
      allGraphqlOps([{ key: "prod:labels" as (typeof SECTION_KEYS)[number], endpoints: {} }]),
    ).toThrow(colonKey);
  });

  test("the live registry passes every construction assert of both flatteners", () => {
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
    // The registry's _PlanModulesAreExact pin proves nothing unless its check can measure misdeclared; the same module with plan() over labels' value
    // is the negative control.
    type _Exact = MustBeNever<MisdeclaredPlanModule<"workflows", typeof workflowsSection>>;
    const misdeclared = {
      ...workflowsSection,
      async plan(
        _ctx: PlanContext<typeof workflowsSection.endpoints, GraphqlDict, "workflows">,
        _desired: Exclude<SettingsFile["labels"], undefined>,
      ) {
        return { ops: [], notes: [], drift: [] };
      },
    };
    // @ts-expect-error a plan() over labels' value is not exact for workflows
    type _Wrong = MustBeNever<MisdeclaredPlanModule<"workflows", typeof misdeclared>>;
    // The key arm: workflows' own dictionary and value under labels' context brand is misdeclared too.
    const foreignKey = {
      ...workflowsSection,
      async plan(
        _ctx: PlanContext<typeof workflowsSection.endpoints, GraphqlDict, "labels">,
        _desired: Exclude<SettingsFile["workflows"], undefined>,
      ) {
        return { ops: [], notes: [], drift: [] };
      },
    };
    // @ts-expect-error a plan() branded with labels' key is not exact for workflows
    type _ForeignKey = MustBeNever<MisdeclaredPlanModule<"workflows", typeof foreignKey>>;
    // The snapshot twin: a module without snapshot() measures exact (nothing to compare), the
    // shipped labels module measures exact, and labels' snapshot() over workflows' dictionary
    // measures misdeclared.
    type _NoSnapshot = MustBeNever<
      MisdeclaredSnapshotModule<"check_suite_preferences", typeof checkSuitePreferencesSection>
    >;
    type _ExactSnapshot = MustBeNever<MisdeclaredSnapshotModule<"labels", typeof labelsSection>>;
    const misdeclaredSnapshot = {
      ...labelsSection,
      async snapshot(
        _ctx: SnapshotContext<typeof workflowsSection.endpoints, GraphqlDict, "labels">,
      ) {
        return { value: undefined, notes: [] };
      },
    };
    type Misdeclared = typeof misdeclaredSnapshot;
    // @ts-expect-error a snapshot() over workflows' dictionary is not exact for labels
    type _WrongSnapshot = MustBeNever<MisdeclaredSnapshotModule<"labels", Misdeclared>>;
  });

  test("the door tripwire names a reading module registered without snapshot(); a write-only module passes", () => {
    type _WriteOnly = MustBeNever<
      ReadingModuleWithoutSnapshot<"check_suite_preferences", typeof checkSuitePreferencesSection>
    >;
    type _Reading = MustBeNever<ReadingModuleWithoutSnapshot<"labels", typeof labelsSection>>;
    const { snapshot: _dropped, ...withoutSnapshot } = labelsSection;
    // @ts-expect-error labels declares a GET, so registering it without snapshot() is flagged by name
    type _Flagged = MustBeNever<ReadingModuleWithoutSnapshot<"labels", typeof withoutSnapshot>>;
  });

  test("every reading section declares exactly one primaryRead, and its 404 posture derives from it", () => {
    // denialPosture throws on a repeated posture, or a missing one when the section has planning reads, so the call itself is an assertion.
    const declaring: string[] = [];
    for (const section of SECTIONS) {
      const primaries = Object.entries(section.endpoints).filter(
        ([, endpoint]) => endpoint.primaryRead !== undefined,
      );
      const reads = planningReads(section).length > 0;
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
          expect(
            toleratedStatuses(endpoint),
            `${section.key}.${role} claims an "absent" 404 posture but does not declare 404 among its statuses, so the helper would classify it as a denial`,
          ).toContain(404);
        }
        declaring.push(section.key);
      }
    }
    expect(declaring).toEqual(
      SECTIONS.filter((s) =>
        Object.values(s.endpoints).some(
          (e) => endpointMethod(e.route) === "GET" && e.phase !== "execution",
        ),
      ).map((s) => s.key),
    );
  });
});
