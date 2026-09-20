import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  type GitHubClient,
  SECRET_RESPONSE_WITHHELD,
  SECRET_TRANSPORT_WITHHELD,
} from "../../src/github/api.js";
import { actionsSection } from "../../src/sections/actions/index.js";
import {
  type EndpointDecl,
  endpointKind,
  toleratedStatuses,
} from "../../src/sections/contract/endpoints.js";
import {
  errorOf,
  failureFor,
  PermissionDenied,
  raise,
} from "../../src/sections/contract/errors.js";
import { type GraphqlOpDecl, graphqlOp } from "../../src/sections/contract/graphql.js";
import { parseLive } from "../../src/sections/contract/live.js";
import {
  denialPosture,
  freezeDeclarations,
  planningReads,
  readGating,
  type SectionMeta,
  type SectionModule,
  sectionGrant,
  sectionOperations,
  writeGatedReads,
} from "../../src/sections/contract/module.js";
import { type SectionPermission, samePermission } from "../../src/sections/contract/permissions.js";
import {
  DenialPolicy,
  hasDrift,
  plainData,
  planContext,
  snapshotContext,
} from "../../src/sections/contract/plan.js";
import {
  call,
  callDeclared,
  callGraphql,
  declaredTolerance,
  probeAbsent,
  tryCall,
  tryCallDeclared,
} from "../../src/sections/contract/requests.js";
import { customPropertiesSection } from "../../src/sections/custom_properties/index.js";
import { rulesetsSection } from "../../src/sections/rulesets/index.js";
import type { readOrNote } from "../../src/sections/shared/snapshot-helpers.js";
import { MockApi } from "../mock-api.js";

const section: SectionMeta = rulesetsSection;

describe("sectionOperations", () => {
  const readOp: GraphqlOpDecl = {
    name: "SyntheticRead",
    kind: "read",
    query: "query SyntheticRead($owner: String!, $repo: String!) { repository { id } }",
    outcomes: { ok: "x" },
  };

  test("flattens BOTH dictionaries, so a GraphQL-read-only section is not read-free", () => {
    // The shape the oracle's NO_READ_SECTIONS derivation must never misread: a derivation walking section.endpoints alone would call this section
    // read-free.
    const graphqlOnly: SectionMeta = {
      key: "repository",
      permission: { repo: ["administration"] },
      endpoints: {},
      graphql: { read: readOp },
      undeclaredDefault: "untouched",
    };
    expect(sectionOperations(graphqlOnly)).toEqual([
      {
        role: "read",
        wire: "read",
        grade: "read",
        permission: { repo: ["administration"] },
        phase: "plan",
      },
    ]);
  });

  test("resolves per-operation permission overrides and accessGrade write-gating", () => {
    const overridden: SectionMeta = {
      key: "repository",
      permission: { repo: ["administration"] },
      endpoints: {
        gatedList: {
          route: "GET /repos/{owner}/{repo}/codespaces/secrets",
          statuses: { 200: "x" },
          accessGrade: "write",
        },
      },
      graphql: { read: { ...readOp, permission: "none" } },
      undeclaredDefault: "untouched",
    };
    expect(sectionOperations(overridden)).toEqual([
      {
        role: "gatedList",
        wire: "read",
        grade: "write",
        permission: { repo: ["administration"] },
        phase: "plan",
      },
      { role: "read", wire: "read", grade: "read", permission: "none", phase: "plan" },
    ]);
  });

  test("an execution-phase read is not a planning read: a section with only that read plans read-free", () => {
    // The shape a write-only section gains when a mutation input needs a node id: check mode and preflight never meet the lookup, so gating, posture,
    // and the oracle's no-read set all read it as read-free.
    const writeWithLookup = {
      key: "repository",
      permission: { repo: ["administration"] },
      undeclaredDefault: "untouched",
      endpoints: {
        app: {
          route: "GET /apps/{app_slug}",
          statuses: { 200: "the App" },
          permission: "none",
          phase: "execution",
        },
        put: {
          route: "PATCH /repos/{owner}/{repo}",
          statuses: { 200: "updated" },
        },
      },
      graphql: { lookup: { ...readOp, phase: "execution" } },
    } as const satisfies SectionMeta;
    expect(sectionOperations(writeWithLookup)).toEqual([
      { role: "app", wire: "read", grade: "read", permission: "none", phase: "execution" },
      {
        role: "put",
        wire: "write",
        grade: "write",
        permission: { repo: ["administration"] },
        phase: "plan",
      },
      {
        role: "lookup",
        wire: "read",
        grade: "read",
        permission: { repo: ["administration"] },
        phase: "execution",
      },
    ]);
    expect(planningReads(writeWithLookup)).toEqual([]);
    expect(readGating(writeWithLookup)).toBe("plain");
    expect(denialPosture(writeWithLookup)).toBe("absent");
    // An execution-phase read can carry no posture: plan() never meets its denial.
    const postured: SectionMeta = {
      ...writeWithLookup,
      endpoints: {
        app: { ...writeWithLookup.endpoints.app, primaryRead: { notFound: "denied" } },
      },
    };
    expect(() => denialPosture(postured)).toThrow(
      new Error(
        "BUG: repository declares primaryRead on the execution-phase read GET /apps/{app_slug}; plan() never issues it, so no denied first read can be classified from it",
      ),
    );
  });
});

describe("readGating", () => {
  const plainGet: EndpointDecl = {
    route: "GET /repos/{owner}/{repo}/interaction-limits",
    statuses: { 200: "x" },
  };
  const gatedGet: EndpointDecl = {
    route: "GET /repos/{owner}/{repo}/interaction-limits/pulls/creation-cap",
    statuses: { 200: "x" },
    accessGrade: "write",
  };
  const put: EndpointDecl = {
    route: "PUT /repos/{owner}/{repo}/interaction-limits",
    statuses: { 200: "x" },
  };
  const withEndpoints = (endpoints: SectionMeta["endpoints"]): SectionMeta => ({
    key: "interaction_limits",
    permission: { repo: ["administration"] },
    endpoints,
    undeclaredDefault: "untouched",
  });

  test("accessGrade is representable on a GET only, and grades the read at write", () => {
    // A mutating route is write-graded by its method, so the override there is a redundant state the EndpointDecl arms refuse.
    const mutating: EndpointDecl = {
      route: "PUT /repos/{owner}/{repo}/interaction-limits",
      statuses: { 200: "x" },
      // @ts-expect-error accessGrade on a PUT
      accessGrade: "write",
    };
    expect(endpointKind(mutating)).toBe("write");
    expect(endpointKind(plainGet)).toBe("read");
    expect(endpointKind(gatedGet)).toBe("write");
    // A public endpoint has no grant to gate, so a gated read cannot be "none".
    // @ts-expect-error permission "none" on a write-gated read
    const publicGated: EndpointDecl = { ...gatedGet, permission: "none" };
    expect(endpointKind(publicGated)).toBe("write");
  });

  test("the recurrence flags are representable on a write only, one at a time", () => {
    // A read has no second-apply behaviour to declare, and one write cannot both recur by contract and merely be allowed to.
    const rewritten: EndpointDecl = { ...put, alwaysRewrite: true };
    const unverifiable: EndpointDecl = { ...put, unverifiable: true };
    expect([rewritten.alwaysRewrite, unverifiable.unverifiable]).toEqual([true, true]);
    // @ts-expect-error alwaysRewrite on a GET
    const _readRewrite: EndpointDecl = { ...plainGet, alwaysRewrite: true };
    // @ts-expect-error unverifiable on a GET
    const _readUnverifiable: EndpointDecl = { ...plainGet, unverifiable: true };
    // @ts-expect-error unverifiable on a write-gated read
    const _gatedUnverifiable: EndpointDecl = { ...gatedGet, unverifiable: true };
    // @ts-expect-error both flags on one write
    const _both: EndpointDecl = { ...put, alwaysRewrite: true, unverifiable: true };
  });

  test("classifies a section by how many of its reads GitHub gates at write", () => {
    expect(readGating(withEndpoints({ get: plainGet, put }))).toBe("plain");
    expect(readGating(withEndpoints({ get: gatedGet, put }))).toBe("write-gated");
    expect(readGating(withEndpoints({ get: plainGet, capGet: gatedGet, put }))).toBe("mixed");
    // No reads at all: nothing a grant could deny.
    expect(readGating(withEndpoints({ put }))).toBe("plain");
  });

  test("a GraphQL read counts as a plain read, so it can turn write-gated into mixed", () => {
    const readOp: GraphqlOpDecl = {
      name: "SyntheticRead",
      kind: "read",
      query: "query SyntheticRead($owner: String!, $repo: String!) { repository { id } }",
      outcomes: { ok: "x" },
    };
    expect(readGating({ ...withEndpoints({ get: gatedGet }), graphql: { read: readOp } })).toBe(
      "mixed",
    );
  });

  test("writeGatedReads lists the gated GETs with route and effective permission, in order", () => {
    const section = withEndpoints({
      get: plainGet,
      capGet: gatedGet,
      other: { ...gatedGet, permission: { repo: ["actions"] } },
      put,
    });
    expect(writeGatedReads(section)).toEqual([
      { route: gatedGet.route, permission: { repo: ["administration"] } },
      { route: gatedGet.route, permission: { repo: ["actions"] } },
    ]);
    expect(writeGatedReads(withEndpoints({ get: plainGet, put }))).toEqual([]);
  });
});

/** A synthetic write declaration carrying just the context fields under test. */
function endpoint(
  extra: Partial<
    Pick<EndpointDecl, "hints" | "denialHint" | "permission" | "statuses" | "rejections">
  >,
): EndpointDecl {
  return { route: "POST /repos/{owner}/{repo}/rulesets", statuses: { 201: "created" }, ...extra };
}

function raiseFor(...args: Parameters<typeof failureFor>): never {
  throw errorOf(failureFor(...args));
}

describe("failureFor context enrichment", () => {
  const rejection = {
    status: 422,
    message: 'Validation Failed ([{"field":"rules","message":"Invalid rule"}])',
    body: "",
  };

  test("generic rejection without context keeps the classic shape", () => {
    expect(() => raiseFor(section, "POST", "/repos/o/r/rulesets", rejection)).toThrow(
      new Error(
        'rulesets: POST /repos/o/r/rulesets: 422 Validation Failed ([{"field":"rules","message":"Invalid rule"}]). The API rejected the request; fix the "rulesets" values in the settings file to satisfy the message above',
      ),
    );
  });

  test("operation label prefixes the cause", () => {
    expect(() =>
      raiseFor(section, "POST", "/repos/o/r/rulesets", rejection, {
        operation: 'creating ruleset "quality"',
      }),
    ).toThrow(
      new Error(
        'rulesets: creating ruleset "quality" failed - POST /repos/o/r/rulesets: 422 ' +
          'Validation Failed ([{"field":"rules","message":"Invalid rule"}]). The API rejected ' +
          'the request; fix the "rulesets" values in the settings file to satisfy the message ' +
          "above",
      ),
    );
  });

  test("a GraphQL rejection appends the declared outcome prose of each observed error type; undeclared types add nothing", () => {
    // The GraphQL twin of the status-keyed REST hint, which a GraphQL op's type forbids.
    const op = {
      name: "PinEnvironment",
      kind: "write",
      query: "mutation PinEnvironment { pinEnvironment { environment { name } } }",
      outcomes: {
        ok: "pinned",
        UNPROCESSABLE: "the pinned list is full; unpin one in the GitHub UI",
      },
    } as const;
    const message = (types: readonly string[]): string => {
      try {
        raiseFor(
          section,
          "GRAPHQL",
          "PinEnvironment",
          {
            status: 422,
            message: "Repositories may only have 10 pinned",
            body: "",
            graphqlTypes: types,
          },
          { operation: 'pinning environment "prod"', op },
        );
      } catch (error) {
        return (error as Error).message;
      }
      throw new Error("failureFor returned");
    };
    expect(message(["UNPROCESSABLE"])).toBe(
      'rulesets: pinning environment "prod" failed - GRAPHQL PinEnvironment: 422 Repositories ' +
        'may only have 10 pinned. The API rejected the request; fix the "rulesets" values in the ' +
        "settings file to satisfy the message above. The pinned list is full; unpin one in the " +
        "GitHub UI",
    );
    const undeclared =
      'rulesets: pinning environment "prod" failed - GRAPHQL PinEnvironment: 422 Repositories ' +
      'may only have 10 pinned. The API rejected the request; fix the "rulesets" values in the ' +
      "settings file to satisfy the message above";
    expect(message(["FORBIDDEN"])).toBe(undeclared);
    expect(message([])).toBe(undeclared);
  });

  test("the status-matched hint and documentation_url are appended to the generic branch", () => {
    expect(() =>
      raiseFor(
        section,
        "POST",
        "/repos/o/r/rulesets",
        { ...rejection, documentationUrl: "https://docs.github.com/rest/repos/rules" },
        { op: endpoint({ hints: { 422: "Usually this means a typo" } }) },
      ),
    ).toThrow(
      new Error(
        "rulesets: POST /repos/o/r/rulesets: 422 Validation Failed " +
          '([{"field":"rules","message":"Invalid rule"}]). The API rejected the request; fix the ' +
          '"rulesets" values in the settings file to satisfy the message above. Usually this ' +
          "means a typo. The fields and values this endpoint accepts are documented at " +
          "https://docs.github.com/rest/repos/rules",
      ),
    );
  });

  test("a hint keyed to a different status is not rendered", () => {
    expect(() =>
      raiseFor(
        section,
        "POST",
        "/repos/o/r/rulesets",
        { status: 409, message: "Conflict", body: "" },
        { op: endpoint({ hints: { 422: "never rendered on a 409" } }) },
      ),
    ).toThrow(
      new Error(
        'rulesets: POST /repos/o/r/rulesets: 409 Conflict. The API rejected the request; fix the "rulesets" values in the settings file to satisfy the message above',
      ),
    );
  });

  test("permission errors keep the grant advice and gain the operation label", () => {
    let thrown: unknown;
    try {
      raiseFor(
        section,
        "POST",
        "/repos/o/r/rulesets",
        { status: 403, message: "Resource not accessible", body: "" },
        {
          operation: 'creating ruleset "quality"',
          op: endpoint({ hints: { 422: "never rendered here" } }),
        },
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(PermissionDenied);
    expect((thrown as PermissionDenied).detail).toBe(
      'the token was denied POST /repos/o/r/rulesets (creating ruleset "quality"): 403 Resource not accessible. To fix, grant "Administration" (read and write) under the PAT\'s Repository permissions',
    );
  });

  test.each([
    [
      "the declared status and body",
      { status: 404, message: "Branch not found" },
      {
        error:
          'rulesets: protecting "x" failed - PUT /repos/o/r/branches/x/protection: 404 Branch not found. The declared branch does not exist; create it',
      },
    ],
    [
      "the declared status with a denial body",
      { status: 404, message: "Not Found" },
      {
        denied:
          'the token was denied PUT /repos/o/r/branches/x/protection (protecting "x"): 404 Not Found (a 404 here can also mean the resource does not exist). To fix, grant "Administration" (read and write) under the PAT\'s Repository permissions',
      },
    ],
    [
      "the declared body as a prefix of a longer one",
      { status: 404, message: "Branch not found on fork" },
      {
        denied:
          'the token was denied PUT /repos/o/r/branches/x/protection (protecting "x"): 404 Branch not found on fork ' +
          '(a 404 here can also mean the resource does not exist). To fix, grant "Administration" (read and write) under the PAT\'s Repository permissions',
      },
    ],
    [
      "the declared body on the other denial status",
      { status: 403, message: "Branch not found" },
      {
        denied:
          'the token was denied PUT /repos/o/r/branches/x/protection (protecting "x"): 403 Branch not found. To fix, grant "Administration" (read and write) under the PAT\'s Repository permissions',
      },
    ],
  ] as const)(
    "a declared definitive rejection is claimed back from the permission branch by status AND message: %s",
    (_case, error, expected) => {
      const op = endpoint({
        rejections: [
          {
            status: 404,
            message: "Branch not found",
            advice: "the declared branch does not exist; create it",
          },
        ],
      });
      let thrown: unknown;
      try {
        raiseFor(
          section,
          "PUT",
          "/repos/o/r/branches/x/protection",
          { ...error, body: "" },
          { operation: 'protecting "x"', op },
        );
      } catch (caught) {
        thrown = caught;
      }
      if ("error" in expected) {
        expect(thrown).not.toBeInstanceOf(PermissionDenied);
        expect(thrown).toEqual(new Error(expected.error));
      } else {
        expect(thrown).toBeInstanceOf(PermissionDenied);
        expect((thrown as PermissionDenied).detail).toBe(expected.denied);
      }
    },
  );

  test("denialHint is appended to the permission branch, and only there", () => {
    let thrown: unknown;
    try {
      raiseFor(
        section,
        "PUT",
        "/repos/o/r/lfs",
        { status: 403, message: "Git LFS is globally disabled", body: "" },
        {
          op: endpoint({
            denialHint: "a 403 here can also mean LFS is disabled account-wide",
          }),
        },
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(PermissionDenied);
    expect((thrown as PermissionDenied).detail).toBe(
      'the token was denied PUT /repos/o/r/lfs: 403 Git LFS is globally disabled. To fix, grant "Administration" (read and write) under the PAT\'s Repository permissions. Note: a 403 here can also mean LFS is disabled account-wide',
    );
    // The generic branch never renders it.
    expect(() =>
      raiseFor(
        section,
        "PUT",
        "/repos/o/r/lfs",
        { status: 422, message: "nope", body: "" },
        { op: endpoint({ denialHint: "not for 422s" }) },
      ),
    ).toThrow(
      new Error(
        'rulesets: PUT /repos/o/r/lfs: 422 nope. The API rejected the request; fix the "rulesets" values in the settings file to satisfy the message above',
      ),
    );
  });

  test("the rate-limit and 5xx branches render their own advice without the hint", () => {
    // A 5xx-keyed hint is unrepresentable (HintableStatus), so the fixture carries a 422 one.
    const hinted = { op: endpoint({ hints: { 422: "never rendered here" } }) };
    expect(() =>
      raiseFor(
        section,
        "GET",
        "/repos/o/r/rulesets",
        { status: 500, message: "Server Error", body: "" },
        hinted,
      ),
    ).toThrow(
      new Error(
        "rulesets: GET /repos/o/r/rulesets: 500 Server Error. GitHub returned a server error; re-run the workflow, and retry later if it persists",
      ),
    );
    expect(() =>
      raiseFor(
        section,
        "GET",
        "/repos/o/r/rulesets",
        { status: 403, message: "API rate limit exceeded", body: "", rateLimited: true },
        hinted,
      ),
    ).toThrow(
      new Error(
        "rulesets: GET /repos/o/r/rulesets: 403 API rate limit exceeded. The API rate limit was hit; re-run the workflow after the limit resets, or use a token with a higher rate limit",
      ),
    );
  });

  test("a permission override renders the endpoint's own grant, not the section's", () => {
    let thrown: unknown;
    try {
      raiseFor(
        section,
        "POST",
        "/repos/o/r/actions/oidc/customization/sub",
        { status: 403, message: "Resource not accessible", body: "" },
        { op: endpoint({ permission: { repo: ["actions"] } }) },
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(PermissionDenied);
    // No rulesets sibling carries the synthetic permission, so the sibling scan finds no write and advises read; what matters is the RESOURCE: the
    // endpoint's own grant renders, never the section's.
    expect((thrown as PermissionDenied).detail).toBe(
      'the token was denied POST /repos/o/r/actions/oidc/customization/sub: 403 Resource not accessible. To fix, grant "Actions" (read) under the PAT\'s Repository permissions',
    );
  });

  test("override advice grades by the section's need: a write sibling on the same permission advises write", () => {
    // The failing call is the GET, but putOidcSub writes with the same Actions permission; read-only advice would cost a second round trip (grant
    // read, pass preflight, fail on the write).
    let thrown: unknown;
    try {
      raiseFor(
        actionsSection,
        "GET",
        "/repos/o/r/actions/oidc/customization/sub",
        { status: 403, message: "Resource not accessible", body: "" },
        { op: actionsSection.endpoints.getOidcSub as EndpointDecl },
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(PermissionDenied);
    expect((thrown as PermissionDenied).detail).toBe(
      'the token was denied GET /repos/o/r/actions/oidc/customization/sub: 403 Resource not accessible. To fix, grant "Actions" (read and write) under the PAT\'s Repository permissions',
    );
  });

  test('a public endpoint ("none") cannot be a missing-grant failure', () => {
    // A denied PUBLIC endpoint is not about the token's grants, so grant advice cannot help.
    let thrown: unknown;
    try {
      raiseFor(
        section,
        "GET",
        "/repos/o/r/rulesets",
        { status: 403, message: "Forbidden", body: "" },
        { op: endpoint({ permission: "none" }) },
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).not.toBeInstanceOf(PermissionDenied);
    expect((thrown as Error).message).toBe(
      'rulesets: GET /repos/o/r/rulesets: 403 Forbidden. The API rejected the request; fix the "rulesets" values in the settings file to satisfy the message above',
    );
  });

  test("the custom property values GET is public, so its denial asks for no grant the section itself needs", () => {
    // The section is gated ("Custom properties"); only the endpoint's own "none" keeps that grant out of the advice.
    expect(sectionGrant(customPropertiesSection)).toMatch(/^grant /);
    let thrown: unknown;
    try {
      raiseFor(
        customPropertiesSection,
        "GET",
        "/repos/o/r/properties/values",
        { status: 403, message: "Forbidden", body: "" },
        { op: customPropertiesSection.endpoints.list },
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).not.toBeInstanceOf(PermissionDenied);
    expect((thrown as Error).message).not.toMatch(/grant/);
  });

  test("a no-override denial keeps the section grant's caveat", () => {
    // sectionGrant(section) and grantFor(effective) coincide for a caveat-free section, so only a caveat-bearing one catches a refactor that
    // re-derives the grant from the resolved permission and drops every caveat.
    let thrown: unknown;
    const noOverride: EndpointDecl = {
      route: "GET /repos/{owner}/{repo}/actions/permissions",
      statuses: { 200: "x" },
    };
    try {
      raiseFor(
        actionsSection,
        "GET",
        "/repos/o/r/actions/permissions",
        { status: 403, message: "Resource not accessible", body: "" },
        { op: noOverride },
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(PermissionDenied);
    expect((thrown as PermissionDenied).detail).toBe(
      "the token was denied GET /repos/o/r/actions/permissions: 403 Resource not accessible. " +
        'To fix, grant "Administration" (read and write) under the PAT\'s Repository ' +
        'permissions; the "oidc_customization_sub" key alone instead needs "Actions" (read and ' +
        "write)",
    );
  });
});

describe("freezeDeclarations", () => {
  test("freezes the module and every declaration facet in place, leaving the shape and the handlers alone", () => {
    const shape = z.object({ name: z.string() });
    const module = {
      key: "labels",
      permission: { repo: ["issues"] },
      undeclaredDefault: "delete",
      endpoints: {
        list: {
          route: "GET /repos/{owner}/{repo}/labels",
          statuses: { 200: "x" },
          primaryRead: { notFound: "denied" },
        },
      },
      graphql: {
        probe: {
          name: "FreezeProbe",
          kind: "read",
          query: "query FreezeProbe { viewer { login } }",
          outcomes: { ok: "x" },
        },
      },
      layering: {
        keys: () => ["x"],
        keyField: "name",
        nested: { rules: { keys: () => null, keyField: "type" } },
      },
      closedSurface: {
        known: { name: true },
        describe: () => "an entry",
        consequence: "the key would be ignored",
      },
      shape,
      plan: async () => ({ ops: [], notes: [], drift: [] }),
    } as unknown as SectionModule;
    expect(freezeDeclarations(module)).toBe(module);
    expect(Object.isFrozen(module)).toBe(true);
    const facets = {
      endpoints: module.endpoints,
      endpoint: module.endpoints.list,
      statuses: module.endpoints.list?.statuses,
      primaryRead: module.endpoints.list?.primaryRead,
      graphql: module.graphql,
      op: module.graphql?.probe,
      outcomes: module.graphql?.probe?.outcomes,
      permission: module.permission,
      layering: module.layering,
      nested: module.layering?.nested?.rules,
      closedSurface: module.closedSurface,
      known: module.closedSurface?.known,
    };
    for (const [facet, value] of Object.entries(facets)) {
      expect(Object.isFrozen(value), facet).toBe(true);
    }
    // The shape is zod's object and the handlers are functions: neither is a declaration, and both stay as built.
    expect(Object.isFrozen(shape)).toBe(false);
    expect(shape.safeParse({ name: "a" }).success).toBe(true);
    expect(Object.isFrozen(module.plan)).toBe(false);
    expect(Object.isFrozen(module.layering?.keys)).toBe(false);
  });

  test("a module declaring no optional facets freezes the same way", () => {
    const module = {
      key: "workflows",
      permission: { repo: ["actions"] },
      undeclaredDefault: "untouched",
      endpoints: {},
      shape: z.unknown(),
      plan: async () => ({ ops: [], notes: [], drift: [] }),
    } as unknown as SectionModule;
    expect(() => freezeDeclarations(module)).not.toThrow();
    expect(Object.isFrozen(module)).toBe(true);
    expect(Object.isFrozen(module.endpoints)).toBe(true);
    expect(Object.isFrozen(module.permission)).toBe(true);
  });
});

describe("denialPosture", () => {
  const get = (notFound?: "denied" | "absent"): EndpointDecl => ({
    route: "GET /repos/{owner}/{repo}/interaction-limits",
    statuses: { 200: "x", 404: "none set" },
    ...(notFound === undefined ? {} : { primaryRead: { notFound } }),
  });
  const put: EndpointDecl = {
    route: "PUT /repos/{owner}/{repo}/interaction-limits",
    statuses: { 200: "x" },
  };
  const readOp: GraphqlOpDecl = {
    name: "PostureProbe",
    kind: "read",
    query: "query PostureProbe($owner: String!, $repo: String!) { repository { id } }",
    outcomes: { ok: "x" },
  };
  const meta = (endpoints: SectionMeta["endpoints"], graphql?: SectionMeta["graphql"]) =>
    ({
      key: "interaction_limits",
      permission: { repo: ["administration"] },
      endpoints,
      graphql,
      undeclaredDefault: "untouched",
    }) as SectionMeta;

  test("reads the declared posture, and a section with no read at all is absent", () => {
    expect(denialPosture(meta({ get: get("denied"), put }))).toBe("denied");
    expect(denialPosture(meta({ get: get("absent"), put }))).toBe("absent");
    expect(denialPosture(meta({ put }))).toBe("absent");
  });

  test("a reading section without a posture, or with two, is a BUG rather than a guess", () => {
    const unpostured = new Error(
      "BUG: interaction_limits reads but declares no primaryRead posture, so a denied first read cannot be classified",
    );
    expect(() => denialPosture(meta({ get: get(), put }))).toThrow(unpostured);
    // A GraphQL read is a read the posture must cover too.
    expect(() => denialPosture(meta({ put }, { probe: readOp }))).toThrow(unpostured);
    expect(() => denialPosture(meta({ get: get("denied"), other: get("absent"), put }))).toThrow(
      new Error(
        "BUG: interaction_limits declares primaryRead on 2 endpoints; at most one read carries the 404 posture",
      ),
    );
  });
});

describe("planContext read port", () => {
  const REPO = { owner: "o", name: "r", slug: "o/r" };

  /** Deliberately MUTABLE declarations, the shape a hostile or buggy caller could hold. */
  function mutableSection() {
    const endpoints: Record<string, { route: string; statuses: Record<number, string> }> = {
      list: { route: "GET /repos/{owner}/{repo}/labels", statuses: { 200: "the labels" } },
    };
    const graphql: Record<
      string,
      { name: string; kind: string; query: string; outcomes: { ok: string } }
    > = {
      probe: {
        name: "PortProbe",
        kind: "read",
        query: "query PortProbe($owner: String!, $repo: String!) { repository { id } }",
        outcomes: { ok: "the repository" },
      },
    };
    const section = {
      key: "labels",
      permission: { repo: ["administration"] },
      undeclaredDefault: "delete",
      endpoints,
      graphql,
    } as unknown as SectionMeta;
    return { section, endpoints, graphql };
  }

  test("mutating a declaration after binding cannot turn a bound read into a write", async () => {
    const { section, endpoints, graphql } = mutableSection();
    const api = new MockApi(
      {
        "GET /repos/o/r/labels": { data: [] },
        "GRAPHQL PortProbe": { data: { repository: { id: "R_1" } } },
      },
      { unroutedMutations: "succeed" },
    );
    const ctx = planContext(section, api, REPO) as unknown as {
      read: {
        list: { call(schema: z.ZodType): Promise<unknown> };
        probe: { call(schema: z.ZodType, variables: Record<string, unknown>): Promise<unknown> };
      };
    };
    (endpoints.list as { route: string }).route = "DELETE /repos/{owner}/{repo}/labels";
    (graphql.probe as { kind: string }).kind = "write";
    await ctx.read.list.call(z.unknown());
    await ctx.read.probe.call(z.unknown(), { owner: "o", repo: "r" });
    expect(api.calls.map((c) => `${c.method} ${c.path} ${c.graphqlKind ?? ""}`.trim())).toEqual([
      "GET /repos/o/r/labels",
      "GRAPHQL PortProbe read",
    ]);
    expect(api.mutations()).toEqual([]);
    expect(Object.isFrozen(ctx.read)).toBe(true);
  });

  test("an advisory read exposes only tryCall, which tolerates every error status", async () => {
    // No failure on an advisory read may abort the section, and a 500 is not "absent", so the port offers only tryCall.
    const advisory = {
      key: "branches",
      permission: { repo: ["administration"] },
      undeclaredDefault: "untouched",
      endpoints: {
        probe: {
          route: "GET /repos/{owner}/{repo}/branches/{branch}",
          statuses: { 200: "the branch", 404: "no such branch" },
          advisory: true,
        },
        plain: {
          route: "GET /repos/{owner}/{repo}/branches",
          statuses: { 200: "the branches" },
        },
      },
    } as const satisfies SectionMeta;
    const api = new MockApi({
      "GET /repos/o/r/branches/main": {
        error: { status: 500, message: "Internal Server Error", body: "" },
      },
      "GET /repos/o/r/branches": {
        error: { status: 500, message: "Internal Server Error", body: "" },
      },
    });
    const ctx = planContext(advisory, api, REPO);
    // @ts-expect-error an advisory read offers no must-succeed call
    ctx.read.probe.call;
    // @ts-expect-error nor an absence probe
    ctx.read.probe.probeAbsent;
    // @ts-expect-error nor a list
    ctx.read.probe.listAll;
    // @ts-expect-error nor an enveloped list
    ctx.read.probe.listAllEnveloped;
    expect(await ctx.read.probe.tryCall(z.unknown(), { params: { branch: "main" } })).toEqual({
      error: { status: 500, message: "Internal Server Error", body: "" },
    });
    // The control: the same status on a plain read classifies through failureFor.
    expect(typeof ctx.read.plain.call).toBe("function");
    await expect(ctx.read.plain.tryCall(z.unknown())).rejects.toThrow(
      new Error(
        "branches: GET /repos/o/r/branches: 500 Internal Server Error. GitHub returned a server error; re-run the workflow, and retry later if it persists",
      ),
    );
  });

  test("advisory wins over a primaryRead posture on the same declaration", () => {
    // Compile-time only: the advisory arm is tested first, so a "denied" posture cannot hand a must-succeed call to an advisory read.
    const both = {
      key: "branches",
      permission: { repo: ["administration"] },
      undeclaredDefault: "untouched",
      endpoints: {
        probe: {
          route: "GET /repos/{owner}/{repo}/branches/{branch}",
          statuses: { 200: "the branch" },
          advisory: true,
          primaryRead: { notFound: "denied" },
        },
      },
    } as const satisfies SectionMeta;
    const ctx = planContext(both, new MockApi({}), REPO);
    // @ts-expect-error the denied posture's call is not offered under advisory
    ctx.read.probe.call;
    expect(typeof ctx.read.probe.tryCall).toBe("function");
  });

  test("an execution-phase read demands the ExecTools token only a thunk holds, REST and GraphQL alike", async () => {
    const gated = {
      key: "branches",
      permission: { repo: ["administration"] },
      undeclaredDefault: "untouched",
      endpoints: {
        app: {
          route: "GET /apps/{app_slug}",
          statuses: { 200: "the App" },
          permission: "none",
          phase: "execution",
        },
        plain: {
          route: "GET /repos/{owner}/{repo}/branches",
          statuses: { 200: "the branches" },
        },
      },
      graphql: {
        repo: graphqlOp<{ owner: string; repo: string }>()({
          name: "GateProbe",
          kind: "read",
          phase: "execution",
          query: "query GateProbe($owner: String!, $repo: String!) { repository { id } }",
          outcomes: { ok: "the repository" },
        }),
      },
    } as const satisfies SectionMeta;
    const api = new MockApi({
      "GET /apps/deploy-gate": { data: { node_id: "A_1" } },
      "GET /repos/o/r/branches": { data: [] },
      "GRAPHQL GateProbe": { data: { repository: { id: "R_1" } } },
    });
    const ctx = planContext(gated, api, REPO);
    const exec = {
      resolveSecret: (): string => {
        throw new Error("no secrets here");
      },
    };
    // A plan() body holds no token, so it cannot spell the call; the ungated read beside them is the control.
    // @ts-expect-error a schema is not the token
    const forgedRest: Parameters<typeof ctx.read.app.call>[0] = z.unknown();
    // @ts-expect-error nor is one for a GraphQL read
    const forgedGraphql: Parameters<typeof ctx.read.repo.call>[0] = z.unknown();
    expect([forgedRest, forgedGraphql].length).toBe(2);
    expect(
      await ctx.read.app.call(exec, z.unknown(), { params: { app_slug: "deploy-gate" } }),
    ).toEqual({
      node_id: "A_1",
    });
    expect(await ctx.read.repo.call(exec, z.unknown(), { owner: "o", repo: "r" })).toEqual({
      repository: { id: "R_1" },
    });
    expect(await ctx.read.plain.call(z.unknown())).toEqual([]);
    expect(api.calls.map((c) => c.path)).toEqual([
      "/apps/deploy-gate",
      "GateProbe",
      "/repos/o/r/branches",
    ]);
  });
});

describe("parseLive", () => {
  const strict = z.object({
    id: z.number(),
    name: z.string(),
    url: z.string(),
    active: z.boolean(),
    events: z.array(z.string()),
  });
  const right = { id: 1, name: "n", url: "u", active: true, events: [] };
  const wrong = { id: "1", name: 1, url: 1, active: "yes", events: "push" };
  const wrongIn = (n: number) => ({
    ...right,
    ...Object.fromEntries(Object.entries(wrong).slice(0, n)),
  });
  const HEAD =
    "^rulesets: POST /repos/\\{owner\\}/\\{repo\\}/rulesets returned a body outside the documented shape - ";

  test.each<[hidden: number, tail: string]>([
    [1, "; and 1 more issue"],
    [2, "; and 2 more issues"],
  ])("three issues shown and %i hidden: the remainder agrees with its count", (hidden, tail) => {
    expect(() => raise(parseLive(section, endpoint({}), strict, wrongIn(3 + hidden)))).toThrow(
      new RegExp(`${HEAD}id: [^;]+; name: [^;]+; url: [^;]+${tail}\\. Check`),
    );
  });

  test("three issues or fewer render whole, with no remainder", () => {
    expect(() => raise(parseLive(section, endpoint({}), strict, wrongIn(3)))).toThrow(
      new RegExp(`${HEAD}id: [^;]+; name: [^;]+; url: [^;]+\\. Check`),
    );
  });
});

describe("plainData", () => {
  test("accepts a parsed-YAML shape and returns it as is", () => {
    const shape = {
      name: "x",
      enabled: true,
      count: 3,
      nothing: null,
      omitted: undefined,
      rules: [{ type: "deletion" }, { type: "update", parameters: { tags: ["a", "b"] } }],
    };
    expect(plainData(shape)).toBe(shape);
    expect(plainData([1, "two", null, { three: 3 }])).toEqual([1, "two", null, { three: 3 }]);
  });

  const BUG = "BUG: a planned payload carries a value JSON cannot carry at ";
  const PLAIN = "; request data must be plain";
  // One refusal covers two list shapes; it names both and what JSON does with each, so the reader can tell them apart.
  const HOLE_OR_HIDDEN_ITEM = new RegExp(
    `^${BUG}list: (?=.*\\ba hole, which JSON \\w+ as null\\b)(?=.*\\bnon-enumerable item, which JSON keeps\\b).*${PLAIN}$`,
  );
  test.each<[what: string, value: unknown, message: string | RegExp]>([
    ["a function", { rules: [{ check: () => true }] }, `${BUG}rules[0].check: a function${PLAIN}`],
    ["a bigint", { limit: 10n }, `${BUG}limit: a bigint${PLAIN}`],
    ["a class instance", { when: new Date(0) }, `${BUG}when: a non-plain object${PLAIN}`],
    ["a symbol", [Symbol("s")], `${BUG}[0]: a symbol${PLAIN}`],
    [
      "a non-finite number",
      { ratio: Number.NaN },
      `${BUG}ratio: a non-finite number, which JSON would turn into null${PLAIN}`,
    ],
    [
      "an undefined list item",
      { list: [undefined] },
      `${BUG}list[0]: an undefined list item, which JSON would turn into null${PLAIN}`,
    ],
    ["undefined at the root", undefined, `${BUG}(root): undefined, which has no JSON form${PLAIN}`],
    // Keys that are not bare identifiers render bracketed, so a dotted key and a nested key cannot read the same.
    ["a value under a dotted key", { "a.b": { c: 1n } }, `${BUG}["a.b"].c: a bigint${PLAIN}`],
    ["a value under an empty key", { "": 1n }, `${BUG}[""]: a bigint${PLAIN}`],
    [
      "a symbol-keyed property",
      { ok: true, [Symbol("hidden")]: 1n },
      `${BUG}(root): a symbol-keyed property, which JSON drops${PLAIN}`,
    ],
    [
      // The symbol check runs before the list branch, so a list is covered too.
      "a symbol-keyed list",
      { list: Object.assign([1], { [Symbol("hidden")]: 1n }) },
      `${BUG}list: a symbol-keyed property, which JSON drops${PLAIN}`,
    ],
    [
      // Own property NAMES, not keys: a non-enumerable extra is dropped by JSON all the same.
      "a list with a non-enumerable named property",
      { list: Object.defineProperty([1], "extra", { value: 2 }) },
      `${BUG}list: a list carrying named properties, which JSON drops${PLAIN}`,
    ],
    [
      "a list of a subclass",
      { list: new (class Tagged extends Array {})() },
      `${BUG}list: a list of a subclass, which JSON serializes as a plain list${PLAIN}`,
    ],
    [
      // Enumerable keys against the length: a hole and a non-enumerable item both fall short of it.
      "a list with a non-enumerable item",
      { list: Object.defineProperty([1], "0", { enumerable: false }) },
      HOLE_OR_HIDDEN_ITEM,
    ],
    [
      "a list with a hole",
      { list: Object.assign(new Array(3), { 0: 1, 2: 3 }) },
      HOLE_OR_HIDDEN_ITEM,
    ],
  ])("rejects %s, naming its path", (_what, value, message) => {
    expect(() => plainData(value)).toThrow(
      typeof message === "string" ? new Error(message) : message,
    );
  });

  test("rejects a cycle, and only a cycle: a shared sibling reference is plain", () => {
    const shared = { tag: "x" };
    expect(plainData({ a: shared, b: shared })).toEqual({ a: { tag: "x" }, b: { tag: "x" } });
    const cyclic: Record<string, unknown> = { name: "loop" };
    cyclic.self = cyclic;
    expect(() => plainData(cyclic)).toThrow(
      new Error(
        "BUG: a planned payload carries a value JSON cannot carry at self: a reference back to one of its own containers (a cycle); request data must be plain",
      ),
    );
  });
});

describe("hasDrift", () => {
  test("narrows a computed drift list to the non-empty tuple an operation demands", () => {
    const lines: readonly string[] = ["labels[bug]: color d73a4a != live ffffff"];
    expect(hasDrift([])).toBe(false);
    expect(hasDrift(lines)).toBe(true);
    if (hasDrift(lines)) {
      const [head] = lines;
      expect(head).toBe("labels[bug]: color d73a4a != live ffffff");
    }
  });
});

describe("declaredTolerance", () => {
  const endpoint: EndpointDecl = {
    route: "GET /repos/{owner}/{repo}/branches/{branch}",
    statuses: { 200: "the branch", 404: "no such branch", 409: "empty repository" },
  };

  test("an explicit list tolerates exactly what it names", () => {
    const tolerated = declaredTolerance(endpoint, [404]);
    expect([404, 409, 500].map(tolerated)).toEqual([true, false, false]);
  });

  test("an explicit list may only name declared tolerable statuses", () => {
    // Only an erased caller can spell these; each is refused before any request could leave.
    for (const status of [422, 200, 401, 500]) {
      expect(() => declaredTolerance(endpoint, [status])).toThrow(
        new Error(
          `BUG: GET /repos/{owner}/{repo}/branches/{branch} was asked to tolerate status(es) ${status}, which it does not declare as a tolerable error status; a tolerance may only name declared 4xx statuses other than 401 and 429`,
        ),
      );
    }
    // The control: the declared 404 and 409 pass, together.
    expect(declaredTolerance(endpoint, [404, 409])(409)).toBe(true);
  });

  test("the declared tolerable set is the 4xx statuses minus 401 and 429; 5xx never; none declared, none tolerated", () => {
    expect(
      toleratedStatuses({
        route: "GET /repos/{owner}/{repo}/pages",
        statuses: {
          200: "ok",
          401: "bad token",
          404: "gone",
          422: "no",
          429: "limited",
          500: "down",
        },
      }),
    ).toEqual([404, 422]);
    expect(
      toleratedStatuses({
        route: "DELETE /repos/{owner}/{repo}/labels/{name}",
        statuses: { 204: "a" },
      }),
    ).toEqual([]);
  });

  test("an advisory endpoint tolerates every status", () => {
    const tolerated = declaredTolerance({ ...endpoint, advisory: true });
    expect([404, 409, 500, 401].map(tolerated)).toEqual([true, true, true, true]);
    // An explicit list still wins over the advisory default.
    expect(declaredTolerance({ ...endpoint, advisory: true }, [404])(500)).toBe(false);
  });

  test("otherwise the endpoint's declared tolerable statuses", () => {
    const tolerated = declaredTolerance(endpoint);
    expect([404, 409, 500, 200].map(tolerated)).toEqual([true, true, false, false]);
  });
});

describe("a marked request's failure is rebuilt on the engine's side of the client port", () => {
  const ctx = { repo: { owner: "o", name: "r", slug: "o/r" }, check: false as const };
  const endpoint: EndpointDecl = {
    route: "PATCH /repos/{owner}/{repo}/code-quality/setup",
    statuses: { 200: "updated", 409: "a run is in progress" },
  };
  const op = graphqlOp<{ token: string }>()({
    name: "MarkedWrite",
    kind: "write",
    query: "mutation MarkedWrite($token: String!) { noop(token: $token) { id } }",
    outcomes: { ok: "written" },
  });
  // What a caller's own client may hand back for a rejected secret: the value, verbatim, in the message.
  const echo = "Validation Failed: token hunter2 is too weak";
  const answering = (status: number, message = echo): GitHubClient => ({
    tryRequest: async () => ({ error: { status, message, body: message } }),
    tryGraphql: async () => ({
      error: { status, message, body: message, graphqlTypes: ["UNPROCESSABLE"] },
    }),
  });
  const throwing: GitHubClient = {
    tryRequest: async () => {
      throw new Error(echo);
    },
    tryGraphql: async () => {
      throw new Error(echo);
    },
  };
  const rest = (api: GitHubClient, carriesSecret: boolean) =>
    callDeclared({ ...ctx, api, resolveSecret: () => "" }, actionsSection, endpoint, {
      payload: { token: "hunter2" },
      carriesSecret,
      describe: "arming the setup",
    }).then(raise);
  const graphql = (api: GitHubClient, carriesSecret: boolean) =>
    callGraphql(
      { ...ctx, api, resolveSecret: () => "" },
      actionsSection,
      op,
      { token: "hunter2" },
      {
        describe: "arming the setup",
        carriesSecret,
      },
    ).then(raise);

  test.each([
    {
      wire: "REST, the client answers 422",
      run: () => rest(answering(422), true),
      thrown: `actions: arming the setup failed - PATCH /repos/o/r/code-quality/setup: 422 ${SECRET_RESPONSE_WITHHELD}. The API rejected the request; fix the "actions" values in the settings file to satisfy the message above`,
    },
    {
      wire: "REST, the client throws",
      run: () => rest(throwing, true),
      thrown: `PATCH /repos/o/r/code-quality/setup failed: ${SECRET_TRANSPORT_WITHHELD}. Check network connectivity from the runner to the GitHub API, then re-run`,
    },
    {
      wire: "GraphQL, the client answers with errors",
      run: () => graphql(answering(422), true),
      thrown: `actions: arming the setup failed - GRAPHQL MarkedWrite: 422 ${SECRET_RESPONSE_WITHHELD}. The API rejected the request; fix the "actions" values in the settings file to satisfy the message above`,
    },
    {
      wire: "GraphQL, the client throws",
      run: () => graphql(throwing, true),
      thrown: `GRAPHQL MarkedWrite failed: ${SECRET_TRANSPORT_WITHHELD}. Check network connectivity from the runner to the GitHub API, then re-run`,
    },
    {
      wire: "REST, the client answers a rate limit signalled only by its message",
      run: () => rest(answering(403, "API rate limit exceeded for hunter2"), true),
      thrown: `actions: arming the setup failed - PATCH /repos/o/r/code-quality/setup: 403 ${SECRET_RESPONSE_WITHHELD}. The API rate limit was hit; re-run the workflow after the limit resets, or use a token with a higher rate limit`,
    },
    {
      wire: "REST, the client answers a plain 403",
      run: () => rest(answering(403), true),
      thrown:
        `actions: the token was denied PATCH /repos/o/r/code-quality/setup (arming the setup): 403 ${SECRET_RESPONSE_WITHHELD}. ` +
        `To fix, grant "Administration" (read and write) under the PAT's Repository permissions; the "oidc_customization_sub" key alone instead needs "Actions" (read and write)`,
    },
    // The controls: unmarked, the same answers render as the client gave them.
    {
      wire: "REST unmarked, the client answers 422",
      run: () => rest(answering(422), false),
      thrown: `actions: arming the setup failed - PATCH /repos/o/r/code-quality/setup: 422 ${echo}. The API rejected the request; fix the "actions" values in the settings file to satisfy the message above`,
    },
    {
      wire: "GraphQL unmarked, the client throws",
      run: () => graphql(throwing, false),
      thrown: echo,
    },
  ])("$wire", async ({ run, thrown }) => {
    await expect(run()).rejects.toThrow(new Error(thrown));
  });

  test("a tolerated status on a marked request comes back withheld too, keeping the status the tolerance reads", async () => {
    // The tolerance's outcome thunk may render error.message into a note or failure (shared/setup-section.ts does).
    const result = raise(
      await tryCallDeclared(
        { ...ctx, api: answering(409), resolveSecret: () => "" },
        actionsSection,
        endpoint,
        {
          payload: { token: "hunter2" },
          carriesSecret: true,
          tolerated: declaredTolerance(endpoint),
        },
      ),
    );
    expect(result).toEqual({
      error: { status: 409, message: SECRET_RESPONSE_WITHHELD, body: SECRET_RESPONSE_WITHHELD },
    });
  });

  test("a payload-bearing request cannot be built without stating the mark", () => {
    // @ts-expect-error the erased executor core demands carriesSecret beside a payload
    const withoutMark: Parameters<typeof callDeclared>[3] = { payload: { token: "hunter2" } };
    expect(withoutMark.payload).toEqual({ token: "hunter2" });
    // A WIDENED variable escapes excess-property checks, which only a literal gets; `payload?: never` refuses it anyway.
    // The route is literal so `params` is optional, and a GET so the port binds it: the only thing left to refuse is the payload.
    const literal = {
      route: "GET /repos/{owner}/{repo}/code-quality/setup",
      statuses: { 200: "the setup" },
    } as const satisfies EndpointDecl;
    const widened = { describe: "arming the setup", payload: { token: "hunter2" } };
    const readCtx = { ...ctx, api: new MockApi({}), check: true as const };
    void (() => call(readCtx, actionsSection, literal, { describe: widened.describe }));
    // @ts-expect-error the typed helpers admit no payload, literal or widened
    void (() => call(readCtx, actionsSection, literal, widened));
    // @ts-expect-error the typed helpers admit no payload, literal or widened
    void (() => tryCall(readCtx, actionsSection, literal, widened));
    // The section-facing port forwards its options to those helpers, so it refuses the same object.
    const port = planContext(
      { ...actionsSection, endpoints: { setup: literal } } as SectionMeta<
        "actions",
        { setup: typeof literal }
      >,
      readCtx.api,
      readCtx.repo,
    );
    void (() => port.read.setup.call(z.unknown(), { describe: widened.describe }));
    // @ts-expect-error the port admits no payload either
    void (() => port.read.setup.call(z.unknown(), widened));
    // @ts-expect-error the port admits no payload either
    void (() => port.read.setup.tryCall(z.unknown(), widened));
    expect(widened.payload).toEqual({ token: "hunter2" });
  });
});

describe("tryCallDeclared", () => {
  const ctx = { repo: { owner: "o", name: "r", slug: "o/r" }, check: false as const };
  const endpoint: EndpointDecl = {
    route: "PATCH /repos/{owner}/{repo}/code-quality/setup",
    statuses: { 200: "updated", 409: "a run is in progress" },
  };
  const answering = (status: number, message: string, rateLimited?: true) =>
    new MockApi({
      "PATCH /repos/o/r/code-quality/setup": {
        error: { status, message, body: "", ...(rateLimited ? { rateLimited } : {}) },
      },
    });

  test("a tolerated status comes back as { error }; any other classifies through failureFor", async () => {
    const tolerated = declaredTolerance(endpoint);
    expect(
      raise(
        await tryCallDeclared(
          { ...ctx, api: answering(409, "Conflict"), resolveSecret: () => "" },
          actionsSection,
          endpoint,
          { tolerated, carriesSecret: false, describe: "arming the setup" },
        ),
      ),
    ).toEqual({ error: { status: 409, message: "Conflict", body: "" } });
    await expect(
      tryCallDeclared(
        { ...ctx, api: answering(422, "Unprocessable"), resolveSecret: () => "" },
        actionsSection,
        endpoint,
        { tolerated, carriesSecret: false, describe: "arming the setup" },
      ).then(raise),
    ).rejects.toThrow(
      new Error(
        'actions: arming the setup failed - PATCH /repos/o/r/code-quality/setup: 422 Unprocessable. The API rejected the request; fix the "actions" values in the settings file to satisfy the message above',
      ),
    );
  });

  test("a rate limit is never a tolerated outcome, even under a tolerated 403", async () => {
    // A rate limit is a transport failure whatever status carries it; the control shows an ordinary 403 under the same tolerance is handed back.
    const declares403 = {
      route: "GET /repos/{owner}/{repo}/pages",
      statuses: { 200: "the site", 403: "forbidden", 404: "no site" },
    } as const satisfies EndpointDecl;
    const limited = new MockApi({
      "GET /repos/o/r/pages": {
        error: { status: 403, message: "API rate limit exceeded", body: "", rateLimited: true },
      },
    });
    const limitHit = new Error(
      "actions: GET /repos/o/r/pages: 403 API rate limit exceeded. The API rate limit was hit; re-run the workflow after the limit resets, or use a token with a higher rate limit",
    );
    await expect(
      tryCallDeclared(
        { ...ctx, api: limited, resolveSecret: () => "" },
        actionsSection,
        declares403,
        { tolerated: declaredTolerance(declares403), carriesSecret: false },
      ).then(raise),
    ).rejects.toThrow(limitHit);
    await expect(
      probeAbsent({ ...ctx, api: limited, check: true }, actionsSection, declares403).then(raise),
    ).rejects.toThrow(limitHit);
    const plain = new MockApi({
      "GET /repos/o/r/pages": { error: { status: 403, message: "Forbidden", body: "" } },
    });
    expect(
      raise(
        await tryCallDeclared(
          { ...ctx, api: plain, resolveSecret: () => "" },
          actionsSection,
          declares403,
          { tolerated: declaredTolerance(declares403), carriesSecret: false },
        ),
      ),
    ).toEqual({ error: { status: 403, message: "Forbidden", body: "" } });
    expect(
      raise(await probeAbsent({ ...ctx, api: plain, check: true }, actionsSection, declares403)),
    ).toEqual({ missing: true });
  });

  test("probeAbsent shares the tolerance boundary: an undeclared status is refused before the request", async () => {
    const api = new MockApi({ "GET /repos/o/r/pages": { data: {} } });
    const probe = {
      route: "GET /repos/{owner}/{repo}/pages",
      statuses: { 200: "the site", 404: "no site" },
    } as const satisfies EndpointDecl;
    await expect(
      probeAbsent({ ...ctx, api, check: true }, actionsSection, probe, {
        tolerate: [422 as unknown as 404],
      }).then(raise),
    ).rejects.toThrow(
      new Error(
        "BUG: GET /repos/{owner}/{repo}/pages was asked to tolerate status(es) 422, which it does not declare as a tolerable error status; a tolerance may only name declared 4xx statuses other than 401 and 429",
      ),
    );
    expect(api.calls).toEqual([]);
  });
});

describe("DenialPolicy", () => {
  test("only snapshotContext() mints the policy readOrNote honors; a literal, a stand-in, or a new is a compile error", () => {
    const REPO = { owner: "o", name: "r", slug: "o/r" };
    const api = new MockApi({});
    expect(
      snapshotContext(actionsSection, api, REPO, "warn").onMissingPermission.notesDenials,
    ).toBe(true);
    expect(
      snapshotContext(actionsSection, api, REPO, "fail").onMissingPermission.notesDenials,
    ).toBe(false);
    // The negative controls: each of these is how a section could have picked "warn" for itself.
    type Carrier = Parameters<typeof readOrNote>[0];
    // @ts-expect-error the input string is not the minted carrier
    const _literal: Carrier = { onMissingPermission: "warn" };
    // @ts-expect-error a structural stand-in is not the carrier either: the class is nominal
    const _standIn: Carrier = { onMissingPermission: { notesDenials: true } };
    // @ts-expect-error the constructor is private
    const _minted: DenialPolicy = new DenialPolicy("warn");
  });
});

describe("samePermission", () => {
  test.each<
    [label: string, a: SectionPermission | "none", b: SectionPermission | "none", same: boolean]
  >([
    [
      "the same alternatives in another order",
      { repo: ["administration", "code_scanning_alerts"] },
      { repo: ["code_scanning_alerts", "administration"] },
      true,
    ],
    ["a duplicated alternative", { repo: ["actions", "actions"] }, { repo: ["actions"] }, true],
    [
      "the same org grant",
      { repo: ["administration"], org: "members" },
      { repo: ["administration"], org: "members" },
      true,
    ],
    [
      "a differing org grant",
      { repo: ["administration"], org: "members" },
      { repo: ["administration"] },
      false,
    ],
    ["a differing resource", { repo: ["actions"] }, { repo: ["issues"] }, false],
    ["a strict subset", { repo: ["actions"] }, { repo: ["actions", "issues"] }, false],
    ['"none" against itself', "none", "none", true],
    ['"none" against a permission', "none", { repo: ["actions"] }, false],
  ])("compares %s as %p, symmetrically", (_label, a, b, same) => {
    expect(samePermission(a, b)).toBe(same);
    expect(samePermission(b, a)).toBe(same);
  });

  test("an override restating the section's permission as a separate literal keeps the caveat", () => {
    // Equal by structure, distinct by identity: an identity comparison would take the override path and render a caveat-free grant.
    const restated: EndpointDecl = {
      route: "GET /repos/{owner}/{repo}/actions/permissions",
      statuses: { 200: "x" },
      permission: { repo: ["administration"] },
    };
    expect(restated.permission).not.toBe(actionsSection.permission);
    let thrown: unknown;
    try {
      raiseFor(
        actionsSection,
        "GET",
        "/repos/o/r/actions/permissions",
        { status: 403, message: "Resource not accessible", body: "" },
        { op: restated },
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(PermissionDenied);
    expect((thrown as PermissionDenied).detail).toBe(
      "the token was denied GET /repos/o/r/actions/permissions: 403 Resource not accessible. " +
        'To fix, grant "Administration" (read and write) under the PAT\'s Repository ' +
        'permissions; the "oidc_customization_sub" key alone instead needs "Actions" (read and ' +
        "write)",
    );
  });
});
