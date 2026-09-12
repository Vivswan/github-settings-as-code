import { describe, expect, test } from "bun:test";
import { GithubApi } from "../../../src/github/api.js";
import { maskRegistry } from "../../../src/io.js";
import { endpointPermission } from "../../../src/sections/contract/module.js";
import { allEndpoints, SECTIONS } from "../../../src/sections/registry.js";
import { ADMIN_OWNER as OWNER, ADMIN_REPO as REPO } from "../constants.js";
import { assertFaultKeys } from "./chaos.js";
import { declaredStatuses, statusAllowed } from "./dispatch.js";
import { assertHandlerCompleteness } from "./handlers.js";
import { startMockServer } from "./server.js";
import {
  AUTH,
  call,
  json,
  jsonArray,
  labelsPath,
  mockServerLifecycle,
  multiState,
  scenario,
  singleState,
} from "./server-test-support.js";
import { slicePage } from "./support.js";

const start = mockServerLifecycle();

const silentTrace = { debug: () => {}, ...maskRegistry(() => {}) };

describe("handler-completeness startup assertion", () => {
  test("passes for the real table", () => {
    expect(() => assertHandlerCompleteness()).not.toThrow();
  });

  test("fires when an endpoint has no handler", () => {
    const endpoints = { "phantom.role": {} } as unknown as Parameters<
      typeof assertHandlerCompleteness
    >[0];
    expect(() => assertHandlerCompleteness(endpoints, {})).toThrow(/no mock handler/);
  });

  test("fires when a handler names no known endpoint", () => {
    const handlers = { "ghost.role": () => ({ status: 200, body: null }) } as unknown as Parameters<
      typeof assertHandlerCompleteness
    >[1];
    expect(() => assertHandlerCompleteness({}, handlers)).toThrow(/no known endpoint/);
  });
});

describe("pagination slicing", () => {
  test("first page returns up to per_page items", () => {
    const items = Array.from({ length: 250 }, (_, i) => i);
    expect(slicePage(items, { per_page: "100", page: "1" })).toHaveLength(100);
    expect(slicePage(items, { per_page: "100", page: "1" })[0]).toBe(0);
  });

  test("the 100-boundary: exactly 100 items yields a full page then an empty one", () => {
    const items = Array.from({ length: 100 }, (_, i) => i);
    expect(slicePage(items, { per_page: "100", page: "1" })).toHaveLength(100);
    expect(slicePage(items, { per_page: "100", page: "2" })).toHaveLength(0);
  });

  test("defaults per_page to 100 and page to 1 when absent or invalid", () => {
    const items = Array.from({ length: 150 }, (_, i) => i);
    expect(slicePage(items, {})).toHaveLength(100);
    expect(slicePage(items, { per_page: "0", page: "-1" })).toHaveLength(100);
  });

  test("an endpoint cap clamps an oversized request, exactly as GitHub does", () => {
    // The variables list is capped at 30 and GitHub clamps, so the mock must not be more generous.
    const items = Array.from({ length: 40 }, (_, i) => i);
    expect(slicePage(items, { per_page: "100", page: "1" }, 30)).toHaveLength(30);
    expect(slicePage(items, { per_page: "100", page: "2" }, 30)).toHaveLength(10);
    expect(slicePage(items, { per_page: "10", page: "1" }, 30)).toHaveLength(10);
  });

  test("a page past the end is empty", () => {
    expect(slicePage([1, 2, 3], { per_page: "100", page: "5" })).toHaveLength(0);
  });

  test("labels.list paginates over the wire", async () => {
    const h = await start(
      scenario({
        live_state: { labels: { generate: { count: 100, prefix: "gen", color: "ededed" } } },
      }),
    );
    const first = await jsonArray(await call(h, "GET", `${labelsPath}?per_page=100&page=1`));
    const second = await jsonArray(await call(h, "GET", `${labelsPath}?per_page=100&page=2`));
    expect(first).toHaveLength(100);
    expect(second).toHaveLength(0);
    expect(h.requests.map((r) => r.query)).toEqual(["per_page=100&page=1", "per_page=100&page=2"]);
  });
});

describe("permission gate grades", () => {
  test("a read is allowed under a read mask, a write is denied and logged", async () => {
    // labels needs "issues"; grant it read only.
    const h = await start(scenario({ token_permissions: { issues: "read" } }));
    const read = await call(h, "GET", labelsPath);
    expect(read.status).toBe(200);

    const write = await call(h, "POST", labelsPath, { body: { name: "new" } });
    expect(write.status).toBe(403); // fine_grained denied write
    const denied = h.requests.find((r) => r.method === "POST");
    expect(denied?.deniedBy).toBe("issues");
  });

  test("a denied read answers 404 under fine_grained and logs deniedBy", async () => {
    const h = await start(scenario({ token_permissions: { issues: "none" } }));
    const read = await call(h, "GET", labelsPath);
    expect(read.status).toBe(404);
    expect(h.requests[0]?.deniedBy).toBe("issues");
  });

  test("org: members gates the teams probe on org_members read", async () => {
    // teams needs administration (repo) AND org_members (org), so denying org_members alone denies
    // the team probe.
    const h = await start(
      scenario({
        owner_kind: "org",
        token_permissions: { administration: "write", org_members: "none" },
      }),
    );
    const probe = await call(h, "GET", `/orgs/${OWNER}/teams/reviewers/repos/${OWNER}/${REPO}`);
    expect(probe.status).toBe(404);
    expect(h.requests[0]?.deniedBy).toBe("org_members");
  });

  test("the org endpoint needs no permission (permission: none)", async () => {
    const h = await start(scenario({ token_permissions: { administration: "none" } }));
    const org = await call(h, "GET", `/orgs/${OWNER}`);
    expect(org.status).toBe(200);
  });
});

describe("permission mask semantics", () => {
  const codeScanningPath = `/repos/${OWNER}/${REPO}/code-scanning/default-setup`;

  // code_scanning declares repo: ["administration", "code_scanning_alerts"];
  // ANY one at the needed grade suffices, so the truth table has three rows.
  test.each([
    {
      name: "granted by administration alone",
      administration: "read",
      alerts: "none",
      status: 200,
      deniedBy: undefined,
    },
    {
      name: "granted by code_scanning_alerts alone",
      administration: "none",
      alerts: "read",
      status: 200,
      deniedBy: undefined,
    },
    // The denying resource is the FIRST listed repo resource (deterministic).
    {
      name: "denied only when BOTH are insufficient",
      administration: "none",
      alerts: "none",
      status: 404,
      deniedBy: "administration",
    },
  ] as const)(
    "ANY-of-resources: code_scanning read is $name",
    async ({ administration, alerts, status, deniedBy }) => {
      const h = await start(
        scenario({ token_permissions: { administration, code_scanning_alerts: alerts } }),
      );
      expect((await call(h, "GET", codeScanningPath)).status).toBe(status);
      expect(h.requests[0]?.deniedBy).toBe(deniedBy);
    },
  );

  test("unlisted resources default to write grade", async () => {
    const h = await start(scenario({ token_permissions: { administration: "read" } }));
    const created = await call(h, "POST", labelsPath, { body: { name: "x" } });
    expect(created.status).toBe(201);
    expect(h.violations).toHaveLength(0);
  });

  test("every section endpoint's requirement resolves from the registry, not a hand list", () => {
    const sectionByKey = new Map(SECTIONS.map((s) => [s.key, s]));
    const offenders: string[] = [];
    for (const [key, endpoint] of Object.entries(allEndpoints())) {
      const section = sectionByKey.get(endpoint.section);
      if (!section) {
        offenders.push(`${key}: section "${endpoint.section}" is not registered in SECTIONS`);
        continue;
      }
      const permission = endpointPermission(section, endpoint);
      if (permission === "none") {
        continue;
      }
      if (permission.repo.length === 0) {
        offenders.push(`${key}: resolved permission names no repo resource`);
      }
    }
    expect(
      offenders,
      `endpoint(s) whose permission resolves to no gate:\n  ${offenders.join("\n  ")}`,
    ).toEqual([]);
  });
});

describe("denial style bodies", () => {
  test("fine_grained: a denied read answers 404 Not Found", async () => {
    const h = await start(scenario({ token_permissions: { issues: "none" } }));
    const read = await json(await call(h, "GET", labelsPath));
    expect(read.message).toBe("Not Found");
  });

  test("fine_grained: a denied write answers 403 not accessible", async () => {
    const h = await start(scenario({ token_permissions: { environments: "none" } }));
    const put = await call(h, "PUT", `/repos/${OWNER}/${REPO}/environments/prod`, { body: {} });
    expect(put.status).toBe(403);
    expect((await json(put)).message).toBe("Resource not accessible by personal access token");
  });

  test.each([
    { style: 403, op: "read" },
    { style: 403, op: "write" },
    { style: 404, op: "read" },
    { style: 404, op: "write" },
  ] as const)("style $style: a denied $op answers $style", async ({ style, op }) => {
    if (op === "read") {
      const h = await start(
        scenario({ denial_style: style, token_permissions: { issues: "none" } }),
      );
      expect((await call(h, "GET", labelsPath)).status).toBe(style);
      return;
    }
    const h = await start(
      scenario({ denial_style: style, token_permissions: { environments: "none" } }),
    );
    const write = await call(h, "PUT", `/repos/${OWNER}/${REPO}/environments/prod`, { body: {} });
    expect(write.status).toBe(style);
  });

  test("no denial body ever mentions rate limit", async () => {
    for (const style of [403, 404, "fine_grained"] as const) {
      const h = await start(
        scenario({ denial_style: style, token_permissions: { issues: "none" } }),
      );
      const body = await (await call(h, "GET", labelsPath)).text();
      expect(body.toLowerCase()).not.toContain("rate limit");
    }
  });
});

describe("denial barrier", () => {
  test("a read-grade mask + fail policy + denied write is NOT a violation (preflight only proves reads)", async () => {
    // issues:read passes the list READ, so preflight (fail policy) succeeds: it proves only reads.
    // The engine then legitimately sends the create, which the barrier must not read as broken sequencing.
    const h = await start(scenario({ token_permissions: { issues: "read" } }));
    const read = await call(h, "GET", labelsPath);
    expect(read.status).toBe(200);
    const write = await call(h, "POST", labelsPath, { body: { name: "x" } });
    expect(write.status).toBe(403);
    expect(h.violations).toHaveLength(0);
  });

  test("a denied write to an 'absent'-semantics section under fine_grained is NOT a violation", async () => {
    const h = await start(scenario({ token_permissions: { environments: "none" } }));
    await call(h, "PUT", `/repos/${OWNER}/${REPO}/environments/prod`, { body: {} });
    expect(h.violations).toHaveLength(0);
  });

  test("a denied write to a 'denied'-semantics section under the WARN policy is NOT a violation", async () => {
    // Under warn there is no preflight (orchestrate gates it on fail), so a "denied"-semantics
    // section whose first apply op is a write legitimately sends it and takes the 403.
    const h = await start(
      scenario({
        inputs: { on_missing_permission: "warn" },
        token_permissions: { administration: "none" },
      }),
    );
    const res = await call(h, "PATCH", `/repos/${OWNER}/${REPO}`, { body: { description: "x" } });
    expect(res.status).toBe(403); // fine_grained denied write
    const log = h.requests.find((r) => r.method === "PATCH");
    expect(log?.deniedBy).toBe("administration");
    expect(h.violations).toHaveLength(0);
  });

  test("a denied write AFTER a denied read in the same section IS a violation (fail policy)", async () => {
    // Under fail, preflight reads first; a none grade denies it (fatal), so an apply write afterwards proves broken sequencing.
    const h = await start(
      scenario({
        inputs: { on_missing_permission: "fail" },
        token_permissions: { issues: "none" },
      }),
    );
    await call(h, "GET", labelsPath); // labels.list denied, fatal
    await call(h, "POST", labelsPath, { body: { name: "x" } });
    expect(h.violations.some((v) => v.includes("should have aborted"))).toBe(true);
  });

  test("a denied ADVISORY read (branches.branchProbe) does NOT arm the barrier", async () => {
    // branches.ts treats the branch probe as advisory (only a definitive 404 matters) and PUTs
    // regardless, so a denied probe must NOT arm: the PUT is the engine's legitimate write. Fuzz
    // seed 610725843 false-flagged this.
    const branch = "main-0";
    const h = await start(
      scenario({
        inputs: { on_missing_permission: "warn" },
        token_permissions: { contents: "none", administration: "read" },
      }),
    );
    await call(h, "GET", `/repos/${OWNER}/${REPO}/branches/${branch}/protection`);
    await call(h, "GET", `/repos/${OWNER}/${REPO}/branches/${branch}`); // advisory, denied
    await call(h, "PUT", `/repos/${OWNER}/${REPO}/branches/${branch}/protection`, { body: {} });
    expect(h.violations).toHaveLength(0);
  });

  test("the visibility probe (expected, first repository.get) does NOT arm the barrier", async () => {
    // In a redact multi-repo run an EXPLICIT target's first repository.get is the visibility probe,
    // issued before the target loop, so a denied probe is not a section read.
    const target = "e2e-owner/svc-probe";
    const h = await start(
      scenario({
        inputs: { on_missing_permission: "fail", private_repos: "redact" },
        repos: {
          [target]: {
            settings: { repository: { has_issues: true } },
            permissions: { administration: "none" },
          },
        },
      }),
    );
    await call(h, "GET", `/repos/${target}`); // probe (expected), exempt
    await call(h, "PATCH", `/repos/${target}`, { body: { description: "x" } });
    expect(h.violations).toHaveLength(0);
  });

  test("a LATER denied repository.get (the section's own read) DOES arm the barrier", async () => {
    // The exemption is probe-only: once the probe is served, the next denied repository.get IS the
    // repository section's check-mode read.
    const target = "e2e-owner/svc-probe";
    const h = await start(
      scenario({
        inputs: { on_missing_permission: "fail", private_repos: "redact" },
        repos: {
          [target]: {
            settings: { repository: { has_issues: true } },
            permissions: { administration: "none" },
          },
        },
      }),
    );
    await call(h, "GET", `/repos/${target}`); // probe (expected), exempt
    await call(h, "GET", `/repos/${target}`); // section read, arms
    await call(h, "PATCH", `/repos/${target}`, { body: { description: "x" } });
    expect(h.violations.some((v) => v.includes("should have aborted"))).toBe(true);
  });

  test("NO probe under private-repos: show - the first repository.get arms the barrier", async () => {
    // show never probes, so a blanket first-repository.get exemption would hide this regression.
    const target = "e2e-owner/svc-show";
    const h = await start(
      scenario({
        inputs: { on_missing_permission: "fail", private_repos: "show" },
        repos: {
          [target]: {
            settings: { repository: { has_issues: true } },
            permissions: { administration: "none" },
          },
        },
      }),
    );
    await call(h, "GET", `/repos/${target}`); // section read (no probe), arms
    await call(h, "PATCH", `/repos/${target}`, { body: { description: "x" } });
    expect(h.violations.some((v) => v.includes("should have aborted"))).toBe(true);
  });

  test("NO probe for the admin repo (self carve-out) - the first repository.get arms", async () => {
    // The self carve-out never probes GITHUB_REPOSITORY, even in a redact multi-run.
    const h = await start(
      scenario({
        inputs: { on_missing_permission: "fail", private_repos: "redact" },
        repos: {
          [`${OWNER}/${REPO}`]: {
            settings: { repository: { has_issues: true } },
            permissions: { administration: "none" },
          },
        },
      }),
    );
    await call(h, "GET", `/repos/${OWNER}/${REPO}`); // section read (self, no probe), arms
    await call(h, "PATCH", `/repos/${OWNER}/${REPO}`, { body: { description: "x" } });
    expect(h.violations.some((v) => v.includes("should have aborted"))).toBe(true);
  });

  test("NO probe for a discovery-supplied slug - the first repository.get arms", async () => {
    // A slug whose visibility came from /user/repos discovery is never probed, even in a redact run.
    const target = "e2e-owner/disc-x";
    const h = await start(
      scenario({
        inputs: { on_missing_permission: "fail", private_repos: "redact" },
        discovery: { pool: [{ slug: target, visibility: "private" }], inputs: {} },
        repos: {
          [target]: {
            settings: { repository: { has_issues: true } },
            permissions: { administration: "none" },
          },
        },
      }),
    );
    await call(h, "GET", `/repos/${target}`); // section read (discovered, no probe), arms
    await call(h, "PATCH", `/repos/${target}`, { body: { description: "x" } });
    expect(h.violations.some((v) => v.includes("should have aborted"))).toBe(true);
  });

  test("a faulted probe retry is still the probe (exempt), not a section read", async () => {
    // A faulted probe is not delivered, so the slug is not marked seen and the retry is still the
    // probe; marking seen before the fault barrier would misread the retry as the section read.
    const target = "e2e-owner/svc-fault";
    const h = await start(
      scenario({
        inputs: { on_missing_permission: "fail", private_repos: "redact" },
        repos: {
          [target]: {
            settings: { repository: { has_issues: true } },
            permissions: { administration: "none" },
          },
        },
      }),
      { faults: [{ key: "repository.get", kind: "rate_limit_403", times: 1 }] },
    );
    await call(h, "GET", `/repos/${target}`); // faulted probe (throttle), not delivered
    await call(h, "GET", `/repos/${target}`); // probe retry, still exempt
    await call(h, "PATCH", `/repos/${target}`, { body: { description: "x" } });
    expect(h.violations).toHaveLength(0);
  });

  test("an ALL-faulting probe exhausts its budget; the section read then arms", async () => {
    // The probe gives up after its retry budget (3 wire attempts), and the exemption must expire
    // with it: the 4th repository.get is the section's own denied read.
    const target = "e2e-owner/svc-allfault";
    const h = await start(
      scenario({
        inputs: { on_missing_permission: "fail", private_repos: "redact" },
        repos: {
          [target]: {
            settings: { repository: { has_issues: true } },
            permissions: { administration: "none" },
          },
        },
      }),
      { faults: [{ key: "repository.get", kind: "rate_limit_403", times: 3 }] },
    );
    await call(h, "GET", `/repos/${target}`); // probe attempt 1 (faulted)
    await call(h, "GET", `/repos/${target}`); // probe attempt 2 (faulted)
    await call(h, "GET", `/repos/${target}`); // probe attempt 3 (faulted) - budget spent
    await call(h, "GET", `/repos/${target}`); // section read, delivered + denied, ARMS
    await call(h, "PATCH", `/repos/${target}`, { body: { description: "x" } });
    expect(h.violations.some((v) => v.includes("should have aborted"))).toBe(true);
  });

  test("a first-op denied write under WARN + uniform 403 style is NOT a violation", async () => {
    // Under warn there is no preflight in EITHER denial style. Fuzz seed 2151064002 flagged this.
    const h = await start(
      scenario({
        denial_style: 403,
        inputs: { on_missing_permission: "warn" },
        token_permissions: { administration: "none" },
      }),
    );
    const res = await call(h, "PATCH", `/repos/${OWNER}/${REPO}`, { body: { description: "x" } });
    expect(res.status).toBe(403);
    expect(h.violations).toHaveLength(0);
  });

  test("a denied write AFTER a denied read in the same section is a violation (warn policy too)", async () => {
    // The engine aborts a section at a hard-denied read, so a later write for
    // that section proves broken sequencing even under warn.
    const h = await start(
      scenario({
        denial_style: 403,
        inputs: { on_missing_permission: "warn" },
        token_permissions: { issues: "none" },
      }),
    );
    await call(h, "GET", labelsPath); // denied read, not tolerated (403)
    await call(h, "POST", labelsPath, { body: { name: "x" } });
    expect(h.violations.some((v) => v.includes("should have aborted"))).toBe(true);
  });

  test("a tolerated fine_grained 404 read does not arm the write barrier", async () => {
    // environments' probe tolerates 404, so the engine reads the denial as
    // "absent" and legitimately writes; the barrier must not fire.
    const h = await start(
      scenario({
        inputs: { on_missing_permission: "warn" },
        token_permissions: { environments: "none" },
      }),
    );
    await call(h, "GET", `/repos/${OWNER}/${REPO}/environments/prod`); // 404, tolerated
    await call(h, "PUT", `/repos/${OWNER}/${REPO}/environments/prod`, { body: {} });
    expect(h.violations).toHaveLength(0);
  });

  test("a denied write does not mutate state (invariant holds under warn too)", async () => {
    const h = await start(
      scenario({
        inputs: { on_missing_permission: "warn" },
        token_permissions: { issues: "read" },
      }),
    );
    await call(h, "POST", labelsPath, { body: { name: "x" } });
    expect(singleState(h).labels).toHaveLength(0);
  });
});

describe("check-mode barrier", () => {
  test("any non-GET in check mode is a violation", async () => {
    const h = await start(scenario({ inputs: { mode: "check" } }));
    const res = await call(h, "POST", labelsPath, { body: { name: "x" } });
    expect(res.status).toBe(400);
    expect((await json(res)).message).toContain("write in check mode");
    expect(h.violations.some((v) => v.startsWith("write in check mode"))).toBe(true);
  });

  test("an execution-phase GET in check mode is a violation, and passes in apply", async () => {
    // The branches App lookup is declared execution-phase: only a thunk may
    // issue it, and check mode runs no thunk.
    const appPath = "/apps/deploy-gate";
    const inCheck = await start(scenario({ inputs: { mode: "check" } }));
    const res = await call(inCheck, "GET", appPath);
    expect(res.status).toBe(400);
    expect((await json(res)).message).toContain("execution-phase read in check mode");
    expect(inCheck.violations).toEqual([
      'execution-phase read in check mode: GET /apps/deploy-gate (endpoint "branches.appLookup")',
    ]);
    const inApply = await start(scenario());
    expect((await call(inApply, "GET", appPath)).status).toBe(200);
    expect(inApply.violations).toHaveLength(0);
  });

  test("a faulted write in check mode is STILL a check-mode violation (barrier runs before faults)", async () => {
    // The check-mode barrier runs before the fault barrier, so a synthetic fault
    // cannot mask the write the engine should never have sent in check mode.
    const h = await start(scenario({ inputs: { mode: "check" } }), {
      faults: [{ key: "labels.create", kind: "rate_limit_403" }],
    });
    const res = await call(h, "POST", labelsPath, { body: { name: "x" } });
    expect(res.status).toBe(400); // the check-mode violation, not the 403 fault
    expect(h.violations.some((v) => v.startsWith("write in check mode"))).toBe(true);
  });

  test("a GET in check mode is allowed", async () => {
    const h = await start(scenario({ inputs: { mode: "check" } }));
    const res = await call(h, "GET", labelsPath);
    expect(res.status).toBe(200);
    expect(h.violations).toHaveLength(0);
  });

  test("enterCheckMode() arms the barrier on an apply-mode server (convergence re-run)", async () => {
    // Built apply-mode, so the first write passes; enterCheckMode() is what the runner calls before
    // the convergence re-run.
    const h = await start(scenario());
    const before = await call(h, "POST", labelsPath, { body: { name: "first" } });
    expect(before.status).toBe(201);
    expect(h.violations).toHaveLength(0);

    h.enterCheckMode();
    const after = await call(h, "POST", labelsPath, { body: { name: "second" } });
    expect(after.status).toBe(400);
    expect(h.violations.some((v) => v.startsWith("write in check mode"))).toBe(true);
    expect((await call(h, "GET", labelsPath)).status).toBe(200);
  });
});

describe("route matching and wire contract", () => {
  test("an unhandled route is a violation naming method, path, routes.ts", async () => {
    const h = await start(scenario());
    const res = await call(h, "GET", `/repos/${OWNER}/${REPO}/nonexistent`);
    expect(res.status).toBe(400);
    const message = (await json(res)).message as string;
    expect(message).toContain("E2E MOCK VIOLATION:");
    expect(message).toContain("routes.ts");
    expect(h.violations).toHaveLength(1);
  });

  test("a missing Authorization header is a violation", async () => {
    const h = await start(scenario());
    const res = await fetch(`${h.url}${labelsPath}`, {
      method: "GET",
      headers: { "x-github-api-version": "2022-11-28" },
    });
    expect(res.status).toBe(400);
    expect((await json(res)).message).toContain("Authorization header");
    expect(h.violations.some((v) => v.includes("Authorization"))).toBe(true);
  });

  test("a missing api-version header is a violation", async () => {
    const h = await start(scenario());
    const res = await fetch(`${h.url}${labelsPath}`, {
      method: "GET",
      headers: { authorization: "Bearer t" },
    });
    expect(res.status).toBe(400);
    expect((await json(res)).message).toContain("x-github-api-version");
  });

  test("the repo probe is served by the repository.get section endpoint", async () => {
    const h = await start(scenario());
    const res = await call(h, "GET", `/repos/${OWNER}/${REPO}`);
    expect(res.status).toBe(200);
    expect((await json(res)).name).toBe(REPO);
    expect(h.violations).toHaveLength(0);
  });

  // A name every plain object inherits must be a MISS in a name-keyed state dictionary, not Object.prototype's member.
  //   branch protection  -> served the function as a 200 body
  //   team access        -> 200 with role_name undefined
  //   environment        -> .map on the function, a 500 for a 404
  // Raw wire bodies: the team 404 is documented with NO content, which only the unparsed text can pin.
  test.each([
    [
      "branch",
      `/repos/${OWNER}/${REPO}/branches/toString/protection`,
      '{"message":"Branch not protected"}',
    ],
    ["team", `/orgs/${OWNER}/teams/constructor/repos/${OWNER}/${REPO}`, ""],
    ["environment", `/repos/${OWNER}/${REPO}/environments/toString`, '{"message":"Not Found"}'],
  ] as const)("an inherited name is an absent %s", async (_kind, path, body) => {
    const h = await start(scenario());
    const res = await call(h, "GET", path);
    expect([res.status, await res.text(), h.violations]).toEqual([404, body, []]);
  });

  test("the contents core path answers a not-implemented violation", async () => {
    const h = await start(scenario());
    // The contents match is prefix-based, so the real nested {path} (.github/settings.yml) routes.
    const res = await call(h, "GET", `/repos/${OWNER}/${REPO}/contents/.github/settings.yml`);
    expect(res.status).toBe(400);
    expect(h.violations.some((v) => v.includes("not implemented"))).toBe(true);
  });
});

describe("GHES base prefix", () => {
  test("the handle url carries the prefix, and a prefixed request matches", async () => {
    const h = await start(scenario(), { basePrefix: "/api/v3" });
    // The prefix is baked into h.url, so the client appends nothing extra.
    expect(h.url.endsWith("/api/v3")).toBe(true);
    const res = await call(h, "GET", `/repos/${OWNER}/${REPO}/labels`);
    expect(res.status).toBe(200);
    expect(h.violations).toHaveLength(0);
    expect(h.requests[0]?.pathname).toBe(labelsPath);
  });

  test("a request missing the required prefix is a violation", async () => {
    const h = await start(scenario(), { basePrefix: "/api/v3" });
    const rawBase = h.url.replace("/api/v3", "");
    const res = await fetch(`${rawBase}${labelsPath}`, { method: "GET", headers: AUTH });
    expect(res.status).toBe(400);
    expect(h.violations.some((v) => v.includes("base prefix"))).toBe(true);
  });
});

describe("workflows envelope", () => {
  test("the list wraps in {total_count, workflows}", async () => {
    const h = await start(
      scenario({
        live_state: {
          workflows: [{ id: 1, name: "CI", path: ".github/workflows/ci.yml", state: "active" }],
        },
      }),
    );
    const body = await json(await call(h, "GET", `/repos/${OWNER}/${REPO}/actions/workflows`));
    expect(body.total_count).toBe(1);
    expect(body.workflows).toHaveLength(1);
  });
});

describe("writes mutate state", () => {
  test("a label create then list sees the new label", async () => {
    const h = await start(scenario());
    const created = await call(h, "POST", labelsPath, {
      body: { name: "feature", color: "00ff00" },
    });
    expect(created.status).toBe(201);
    const list = await jsonArray(await call(h, "GET", labelsPath));
    expect(list).toHaveLength(1);
    expect(list[0]?.name).toBe("feature");
    expect(singleState(h).labels).toHaveLength(1);
  });

  test("label create and update preserve passthrough fields the section diffs", async () => {
    // The labels section sends unknown passthrough fields verbatim and subsetDiffs them on the
    // next read; a mock that dropped them would make a converged second apply read as drift and
    // re-PATCH, falsely failing the idempotence proof's zero-write rule.
    const h = await start(scenario());
    const created = await call(h, "POST", labelsPath, {
      body: { name: "feature", color: "00ff00", tone: "warm" },
    });
    expect(created.status).toBe(201);
    let list = await jsonArray(await call(h, "GET", labelsPath));
    expect(list[0]?.tone).toBe("warm");
    // Known fields stay normalized over the spread payload.
    expect(list[0]?.default).toBe(false);
    const patched = await call(h, "PATCH", `${labelsPath}/feature`, {
      body: {
        new_name: "feature",
        name: "spoofed",
        tone: "cool",
        id: 999,
        node_id: "FAKE",
        url: "u",
        default: true,
      },
    });
    expect(patched.status).toBe(200);
    list = await jsonArray(await call(h, "GET", labelsPath));
    expect(list[0]?.tone).toBe("cool");
    expect(list[0]?.name).toBe("feature");
    expect(list[0]?.id).not.toBe(999);
    expect(list[0]?.node_id).not.toBe("FAKE");
    expect(list[0]?.url).not.toBe("u");
    expect(list[0]?.default).toBe(false);
  });

  test("a branch protection PUT stores the flattened GET shape; DELETE clears it; a missing branch answers GitHub's 404", async () => {
    const h = await start(scenario({ live_state: { branches: ["main"] } }));
    const branch = `/repos/${OWNER}/${REPO}/branches/main/protection`;
    await call(h, "PUT", branch, { body: { enforce_admins: true, restrictions: null } });
    const get = await json(await call(h, "GET", branch));
    expect(get.enforce_admins).toEqual({ enabled: true });
    await call(h, "DELETE", branch);
    const after = await call(h, "GET", branch);
    expect(after.status).toBe(404);
    const missing = await call(h, "PUT", `/repos/${OWNER}/${REPO}/branches/gone/protection`, {
      body: { enforce_admins: true, restrictions: null },
    });
    expect(missing.status).toBe(404);
    expect(await json(missing)).toEqual({ message: "Branch not found" });
  });

  test("a label update renames the stored key", async () => {
    const h = await start(
      scenario({ live_state: { labels: [{ id: 1, name: "old", color: "ccc" }] } }),
    );
    await call(h, "PATCH", `${labelsPath}/old`, { body: { new_name: "new" } });
    const list = await jsonArray(await call(h, "GET", labelsPath));
    expect(list[0]?.name).toBe("new");
    expect(list[0]?.url).toBe(`https://api.github.com/repos/${OWNER}/${REPO}/labels/new`);
  });
});

describe("actions selected-actions 409", () => {
  test("GET selected-actions answers 409 when the policy is not 'selected'", async () => {
    const h = await start(
      scenario({ live_state: { actions_permissions: { allowed_actions: "all" } } }),
    );
    const res = await call(
      h,
      "GET",
      `/repos/${OWNER}/${REPO}/actions/permissions/selected-actions`,
    );
    expect(res.status).toBe(409);
  });

  test("GET selected-actions answers 200 when the policy is 'selected'", async () => {
    const h = await start(
      scenario({
        live_state: {
          actions_permissions: { allowed_actions: "selected" },
          selected_actions: { github_owned_allowed: true },
        },
      }),
    );
    const res = await call(
      h,
      "GET",
      `/repos/${OWNER}/${REPO}/actions/permissions/selected-actions`,
    );
    expect(res.status).toBe(200);
  });
});

describe("code-scanning 200-vs-202 rule", () => {
  test("a payload changing languages answers 202 with run_id; else 200 with an empty body", async () => {
    const h = await start(
      scenario({ live_state: { code_scanning: { state: "configured", languages: ["python"] } } }),
    );
    const path = `/repos/${OWNER}/${REPO}/code-scanning/default-setup`;
    const changed = await call(h, "PATCH", path, { body: { languages: ["javascript"] } });
    expect(changed.status).toBe(202);
    const body = (await json(changed)) as { run_id: number; run_url: string };
    expect(body).toEqual({
      run_id: expect.any(Number),
      run_url: `https://api.github.com${path}/runs/${body.run_id}`,
    });

    const same = await call(h, "PATCH", path, { body: { state: "configured" } });
    expect(same.status).toBe(200);
    // The spec's 200 body is an empty object (additionalProperties: false), NOT the stored config.
    expect(await json(same)).toEqual({});
  });
});

describe("logged response bodies are snapshots, not live-state aliases", () => {
  test("a later mutation does not retroactively rewrite an earlier logged body", async () => {
    // server.ts structuredClones every logged body, so a handler that returned live state could not
    // have its logged body rewritten by a later mutation.
    const h = await start(scenario());
    await call(h, "GET", `/repos/${OWNER}/${REPO}`);
    await call(h, "PATCH", `/repos/${OWNER}/${REPO}`, { body: { description: "changed-after" } });
    const getLog = h.requests.find(
      (r) => r.method === "GET" && r.pathname === `/repos/${OWNER}/${REPO}`,
    );
    expect((getLog?.responseBody as Record<string, unknown>)?.description).not.toBe(
      "changed-after",
    );
  });
});

describe("chaos hook", () => {
  test("invalid_json corrupts the first response only (times defaults to 1)", async () => {
    const h = await start(scenario(), { corrupt: { key: "labels.list", mode: "invalid_json" } });
    const first = await call(h, "GET", labelsPath);
    await expect(first.json()).rejects.toThrow();
    const second = await call(h, "GET", labelsPath);
    expect(await second.json()).toEqual([]);
  });

  test("missing_envelope strips the workflows list wrapper", async () => {
    const h = await start(
      scenario({
        live_state: {
          workflows: [{ id: 1, name: "CI", path: ".github/workflows/ci.yml", state: "active" }],
        },
      }),
      { corrupt: { key: "workflows.list", mode: "missing_envelope" } },
    );
    const body = await json(await call(h, "GET", `/repos/${OWNER}/${REPO}/actions/workflows`));
    expect(body.workflows).toBeUndefined();
    expect(body.total_count).toBe(1);
  });

  test('times: "always" corrupts every response', async () => {
    const h = await start(scenario(), {
      corrupt: { key: "labels.list", mode: "invalid_json", times: "always" },
    });
    for (let i = 0; i < 4; i++) {
      await expect((await call(h, "GET", labelsPath)).json()).rejects.toThrow();
    }
  });

  test("times: N corrupts the first N responses then serves real ones", async () => {
    const h = await start(scenario(), {
      corrupt: { key: "labels.list", mode: "invalid_json", times: 3 },
    });
    for (let i = 0; i < 3; i++) {
      await expect((await call(h, "GET", labelsPath)).json()).rejects.toThrow();
    }
    expect(await jsonArray(await call(h, "GET", labelsPath))).toEqual([]);
  });
});

describe("core-route faults and server_error", () => {
  const RAW_ACCEPT = "application/vnd.github.raw+json";
  const contentsPath = (slug: string) => `/repos/${slug}/contents/.github/settings.yml`;

  // Key validation through both channels over section and core keys; duplicate-fault rejection is
  // covered through startMockServer in the fault-injection suite below.
  const faultKeyCases: Array<{
    name: string;
    channel: "faults" | "corrupt";
    key: string;
    rejects?: RegExp;
  }> = [
    { name: "accepts a registered section key (faults)", channel: "faults", key: "labels.list" },
    { name: "accepts a registered core key (faults)", channel: "faults", key: "core.contentsGet" },
    {
      name: "accepts a registered core key (corrupt)",
      channel: "corrupt",
      key: "core.discoveryList",
    },
    {
      name: "rejects an unknown section-style key",
      channel: "faults",
      key: "bogus",
      rejects: /unknown endpoint/,
    },
    {
      name: "rejects an unknown core-style key",
      channel: "faults",
      key: "core.bogus",
      rejects: /unknown endpoint/,
    },
  ];
  test.each(faultKeyCases)("assertFaultKeys $name", ({ channel, key, rejects }) => {
    const run =
      channel === "faults"
        ? () => assertFaultKeys([{ key, kind: "server_error" }], undefined)
        : () => assertFaultKeys(undefined, { key, mode: "invalid_json" });
    if (rejects) {
      expect(run).toThrow(rejects);
    } else {
      expect(run).not.toThrow();
    }
  });

  test("server_error rotates 500/502/503 on the fire count, then serves the real response", async () => {
    const h = await start(scenario(), {
      faults: [{ key: "labels.list", kind: "server_error", times: 4 }],
    });
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) {
      statuses.push((await call(h, "GET", labelsPath)).status);
    }
    expect(statuses).toEqual([500, 502, 503, 500, 200]);
    expect(h.faultCounts.get("labels.list")).toBe(4);
  });

  test("a core.contentsGet fault hits the settings fetch, then the real body follows", async () => {
    const target = "e2e-owner/svc-a";
    const h = await start(
      scenario({ repos: { [target]: { settings: { labels: [{ name: "x" }] } } } }),
      { faults: [{ key: "core.contentsGet", kind: "server_error" }] },
    );
    const faulted = await call(h, "GET", contentsPath(target), {
      headers: { accept: RAW_ACCEPT },
    });
    expect(faulted.status).toBe(500);
    const real = await call(h, "GET", contentsPath(target), { headers: { accept: RAW_ACCEPT } });
    expect(real.status).toBe(200);
    expect(await real.text()).toContain("labels");
    expect(h.faultCounts.get("core.contentsGet")).toBe(1);
    expect(h.violations).toHaveLength(0);
  });

  test("a contents fault cannot mask the missing-Accept violation", async () => {
    const target = "e2e-owner/svc-a";
    const h = await start(scenario({ repos: { [target]: { settings: {} } } }), {
      faults: [{ key: "core.contentsGet", kind: "server_error" }],
    });
    const res = await call(h, "GET", contentsPath(target));
    expect(res.status).toBe(400);
    expect(h.violations.some((v) => v.includes("Accept"))).toBe(true);
    expect(h.faultCounts.get("core.contentsGet")).toBeUndefined();
  });

  test("an UNKNOWN-target contents request cannot steal a core.contentsGet fault", async () => {
    // Target resolution comes before the fault hook, so an unknown slug keeps its plain 404 and the
    // fault budget stays armed for the legitimate target.
    const target = "e2e-owner/svc-a";
    const h = await start(
      scenario({ repos: { [target]: { settings: { labels: [{ name: "x" }] } } } }),
      { faults: [{ key: "core.contentsGet", kind: "server_error" }] },
    );
    const ghost = await call(h, "GET", contentsPath("e2e-owner/ghost"), {
      headers: { accept: RAW_ACCEPT },
    });
    expect(ghost.status).toBe(404);
    expect(h.faultCounts.get("core.contentsGet")).toBeUndefined();
    const faulted = await call(h, "GET", contentsPath(target), {
      headers: { accept: RAW_ACCEPT },
    });
    expect(faulted.status).toBe(500);
    expect(h.faultCounts.get("core.contentsGet")).toBe(1);
  });

  test("a core.discoveryList fault answers 5xx on /user/repos, then the pool", async () => {
    const h = await start(
      scenario({ discovery: { inputs: {}, pool: [{ slug: "e2e-owner/repo-0" }] } }),
      { faults: [{ key: "core.discoveryList", kind: "server_error", times: 2 }] },
    );
    expect((await call(h, "GET", "/user/repos")).status).toBe(500);
    expect((await call(h, "GET", "/user/repos")).status).toBe(502);
    const real = await call(h, "GET", "/user/repos");
    expect(real.status).toBe(200);
    expect(await jsonArray(real)).toHaveLength(1);
    expect(h.faultCounts.get("core.discoveryList")).toBe(2);
  });

  test("a core.issueCreate fault fires before the create mutates state", async () => {
    const target = "e2e-owner/svc-priv";
    const h = await start(
      scenario({
        inputs: { private_report: "issue" },
        repos: {
          [target]: {
            settings: {},
            live_state: { repo: { private: true, visibility: "private" } },
          },
        },
      }),
      { faults: [{ key: "core.issueCreate", kind: "server_error" }] },
    );
    const faulted = await call(h, "POST", `/repos/${target}/issues`, {
      body: { title: "x", body: "y" },
    });
    expect(faulted.status).toBe(500);
    expect(multiState(h).repos.get(target)?.issues).toHaveLength(0);
    const retried = await call(h, "POST", `/repos/${target}/issues`, {
      body: { title: "x", body: "y" },
    });
    expect(retried.status).toBe(201);
    expect(multiState(h).repos.get(target)?.issues).toHaveLength(1);
    expect(h.violations).toHaveLength(0);
  });

  test("a core-route corruption mangles the discovery listing, honoring times", async () => {
    const h = await start(
      scenario({ discovery: { inputs: {}, pool: [{ slug: "e2e-owner/repo-0" }] } }),
      { corrupt: { key: "core.discoveryList", mode: "invalid_json" } },
    );
    await expect((await call(h, "GET", "/user/repos")).json()).rejects.toThrow();
    expect(await jsonArray(await call(h, "GET", "/user/repos"))).toHaveLength(1);
  });
});

describe("429 fault production parity", () => {
  test("the throttling plugin absorbs the mock's 429 shape", async () => {
    // The retry plugin never retries a 429 (doNotRetry), so a recovery here proves the throttling plugin
    // recognized the mock's secondary-rate shape; retryBaseMs scales only the waits.
    const h = await start(scenario({ live_state: { labels: [{ id: 1, name: "bug" }] } }), {
      faults: [{ key: "labels.list", kind: "429_then_200" }],
    });
    const api = new GithubApi({
      token: "e2e-token",
      io: silentTrace,
      baseUrl: h.url,
      retryBaseMs: 1,
    });
    const result = await api.tryRequest("GET", `/repos/${OWNER}/${REPO}/labels`);
    expect("error" in result).toBe(false);
    expect(h.faultCounts.get("labels.list")).toBe(1);
    const statuses = h.requests.map((r) => r.status);
    expect(statuses).toEqual([429, 200]);
  });
});

describe("handler statuses obey the realism rule", () => {
  test("every handler branch returns an allowed status", async () => {
    const h = await start(
      scenario({
        live_state: {
          labels: [{ id: 1, name: "bug", color: "d73a4a" }],
          rulesets: [{ id: 42, name: "main", source_type: "Repository" }],
          autolinks: [{ id: 5, key_prefix: "T-", url_template: "https://x/<num>" }],
          workflows: [{ id: 9, name: "CI", path: ".github/workflows/ci.yml", state: "active" }],
          collaborators: [{ login: "carol", role_name: "write" }],
          invitations: [{ id: 314, invitee: { login: "erin" }, permissions: "read" }],
          milestones: [{ number: 1, title: "v1", state: "open" }],
          environments: {
            prod: { name: "prod", protection_rules: [] },
            // "gated" enables custom branch policies, so the pattern
            // endpoints serve it; "prod" (flag absent) exercises their 404s.
            gated: {
              name: "gated",
              protection_rules: [],
              deployment_branch_policy: {
                protected_branches: false,
                custom_branch_policies: true,
              },
            },
          },
          environment_branch_policies: {
            gated: [{ id: 77, name: "release/*", type: "branch" }],
          },
          environment_variables: {
            prod: [
              {
                name: "SEEDED",
                value: "x",
                created_at: "2026-06-01T00:00:00Z",
                updated_at: "2026-06-01T00:00:00Z",
              },
            ],
          },
          teams: { reviewers: { role_name: "write" } },
          pages: { url: "u", source: { branch: "main", path: "/" } },
          actions_permissions: { allowed_actions: "selected" },
          selected_actions: { github_owned_allowed: true },
          branch_protection: { main: { enforce_admins: { enabled: true } } },
          branches: ["main"],
          // Security toggles start enabled so the GET/enabled branch is hit;
          // the "absent" GET branch is exercised by a second server below.
          repo: {
            vulnerability_alerts_enabled: true,
            automated_security_fixes_enabled: true,
            private_vulnerability_reporting_enabled: true,
            immutable_releases_enabled: true,
          },
        },
      }),
    );
    // Ordering matters where one call sets up another (a create before the list, a remove last).
    const cases: Array<[string, string, string, unknown?]> = [
      // repository core + all four readable toggles (enabled GET, put, remove)
      ["repository.get", "GET", `/repos/${OWNER}/${REPO}`],
      ["repository.update", "PATCH", `/repos/${OWNER}/${REPO}`, { description: "x" }],
      ["repository.topics", "PUT", `/repos/${OWNER}/${REPO}/topics`, { names: ["a"] }],
      ["repository.vulnerabilityAlertsGet", "GET", `/repos/${OWNER}/${REPO}/vulnerability-alerts`],
      ["repository.vulnerabilityAlertsPut", "PUT", `/repos/${OWNER}/${REPO}/vulnerability-alerts`],
      [
        "repository.vulnerabilityAlertsRemove",
        "DELETE",
        `/repos/${OWNER}/${REPO}/vulnerability-alerts`,
      ],
      [
        "repository.automatedSecurityFixesGet",
        "GET",
        `/repos/${OWNER}/${REPO}/automated-security-fixes`,
      ],
      [
        "repository.automatedSecurityFixesPut",
        "PUT",
        `/repos/${OWNER}/${REPO}/automated-security-fixes`,
      ],
      [
        "repository.automatedSecurityFixesRemove",
        "DELETE",
        `/repos/${OWNER}/${REPO}/automated-security-fixes`,
      ],
      [
        "repository.privateVulnerabilityReportingGet",
        "GET",
        `/repos/${OWNER}/${REPO}/private-vulnerability-reporting`,
      ],
      [
        "repository.privateVulnerabilityReportingPut",
        "PUT",
        `/repos/${OWNER}/${REPO}/private-vulnerability-reporting`,
      ],
      [
        "repository.privateVulnerabilityReportingRemove",
        "DELETE",
        `/repos/${OWNER}/${REPO}/private-vulnerability-reporting`,
      ],
      ["repository.immutableReleasesGet", "GET", `/repos/${OWNER}/${REPO}/immutable-releases`],
      ["repository.immutableReleasesPut", "PUT", `/repos/${OWNER}/${REPO}/immutable-releases`],
      [
        "repository.immutableReleasesRemove",
        "DELETE",
        `/repos/${OWNER}/${REPO}/immutable-releases`,
      ],
      // labels: create, list, update, then the error branches, then remove
      ["labels.create", "POST", labelsPath, { name: "feat" }],
      ["labels.list", "GET", labelsPath],
      ["labels.update", "PATCH", `${labelsPath}/bug`, { color: "fff" }],
      ["labels.update", "PATCH", `${labelsPath}/nonexistent`, { color: "fff" }], // 404 error branch
      ["labels.remove", "DELETE", `${labelsPath}/nonexistent`], // 404 error branch
      ["labels.remove", "DELETE", `${labelsPath}/bug`],
      // rulesets: list, get, update, create, plus get/update 404 branches
      ["rulesets.list", "GET", `/repos/${OWNER}/${REPO}/rulesets`],
      ["rulesets.get", "GET", `/repos/${OWNER}/${REPO}/rulesets/42`],
      ["rulesets.get", "GET", `/repos/${OWNER}/${REPO}/rulesets/999`], // 404 error branch
      ["rulesets.update", "PUT", `/repos/${OWNER}/${REPO}/rulesets/42`, { name: "main" }],
      ["rulesets.update", "PUT", `/repos/${OWNER}/${REPO}/rulesets/999`, { name: "x" }], // 404
      ["rulesets.create", "POST", `/repos/${OWNER}/${REPO}/rulesets`, { name: "new" }],
      // branches: get (protected + unprotected 404), put, remove, probe (both)
      ["branches.getProtection", "GET", `/repos/${OWNER}/${REPO}/branches/main/protection`],
      ["branches.getProtection", "GET", `/repos/${OWNER}/${REPO}/branches/dev/protection`], // 404
      [
        "branches.putProtection",
        "PUT",
        `/repos/${OWNER}/${REPO}/branches/dev/protection`,
        { enforce_admins: true },
      ],
      ["branches.removeProtection", "DELETE", `/repos/${OWNER}/${REPO}/branches/main/protection`],
      ["branches.branchProbe", "GET", `/repos/${OWNER}/${REPO}/branches/main`],
      ["branches.branchProbe", "GET", `/repos/${OWNER}/${REPO}/branches/ghost`], // 404 error branch
      // environments: probe (both), update (create + update)
      ["environments.probe", "GET", `/repos/${OWNER}/${REPO}/environments/prod`],
      ["environments.probe", "GET", `/repos/${OWNER}/${REPO}/environments/absent`], // 404
      ["environments.update", "PUT", `/repos/${OWNER}/${REPO}/environments/staging`, {}], // 200 create
      ["environments.update", "PUT", `/repos/${OWNER}/${REPO}/environments/staging`, {}], // 200 update
      // environment variables: list (200 + missing-environment 404), create,
      // update (both + 404), remove (both + 404)
      ["environments.listVariables", "GET", `/repos/${OWNER}/${REPO}/environments/prod/variables`],
      ["environments.listVariables", "GET", `/repos/${OWNER}/${REPO}/environments/ghost/variables`], // 404
      [
        "environments.createVariable",
        "POST",
        `/repos/${OWNER}/${REPO}/environments/prod/variables`,
        { name: "NEW", value: "v" },
      ],
      [
        "environments.createVariable",
        "POST",
        `/repos/${OWNER}/${REPO}/environments/prod/variables`,
        { name: "new", value: "v" },
      ], // 409 duplicate (case-insensitive)
      [
        "environments.updateVariable",
        "PATCH",
        `/repos/${OWNER}/${REPO}/environments/prod/variables/SEEDED`,
        { value: "y" },
      ],
      [
        "environments.updateVariable",
        "PATCH",
        `/repos/${OWNER}/${REPO}/environments/prod/variables/GHOST`,
        { value: "y" },
      ], // 404
      [
        "environments.removeVariable",
        "DELETE",
        `/repos/${OWNER}/${REPO}/environments/prod/variables/SEEDED`,
      ],
      [
        "environments.removeVariable",
        "DELETE",
        `/repos/${OWNER}/${REPO}/environments/prod/variables/SEEDED`,
      ], // 404 already gone
      // This list is hand-maintained and PARTIAL (secrets, webhooks, and repo-level variables have
      // their own suites), so a completeness sweep against allEndpoints() cannot live here.
      [
        "environments.listPolicies",
        "GET",
        `/repos/${OWNER}/${REPO}/environments/gated/deployment-branch-policies`,
      ],
      [
        "environments.listPolicies",
        "GET",
        `/repos/${OWNER}/${REPO}/environments/prod/deployment-branch-policies`,
      ], // 404 custom_branch_policies off
      [
        "environments.listPolicies",
        "GET",
        `/repos/${OWNER}/${REPO}/environments/ghost/deployment-branch-policies`,
      ], // 404 missing environment
      [
        "environments.createPolicy",
        "POST",
        `/repos/${OWNER}/${REPO}/environments/gated/deployment-branch-policies`,
        { name: "v*", type: "tag" },
      ],
      [
        "environments.createPolicy",
        "POST",
        `/repos/${OWNER}/${REPO}/environments/gated/deployment-branch-policies`,
        { name: "release/*" },
      ], // 303 duplicate name pattern (declared, no body)
      [
        "environments.createPolicy",
        "POST",
        `/repos/${OWNER}/${REPO}/environments/gated/deployment-branch-policies`,
        { name: "bad", type: "wildcard" },
      ], // 422 invalid type (GitHub enforces the enum server-side)
      [
        "environments.createPolicy",
        "POST",
        `/repos/${OWNER}/${REPO}/environments/prod/deployment-branch-policies`,
        { name: "release/*" },
      ], // 404 custom_branch_policies off
      [
        "environments.removePolicy",
        "DELETE",
        `/repos/${OWNER}/${REPO}/environments/gated/deployment-branch-policies/77`,
      ],
      [
        "environments.removePolicy",
        "DELETE",
        `/repos/${OWNER}/${REPO}/environments/gated/deployment-branch-policies/999`,
      ], // 404 unknown id
      // autolinks: list, create, remove (both)
      ["autolinks.list", "GET", `/repos/${OWNER}/${REPO}/autolinks`],
      [
        "autolinks.create",
        "POST",
        `/repos/${OWNER}/${REPO}/autolinks`,
        { key_prefix: "Z-", url_template: "https://z/<num>" },
      ],
      ["autolinks.remove", "DELETE", `/repos/${OWNER}/${REPO}/autolinks/999`], // 404 error branch
      ["autolinks.remove", "DELETE", `/repos/${OWNER}/${REPO}/autolinks/5`],
      // actions: all four get/put pairs (selected GET 200 because policy is selected)
      ["actions.getPermissions", "GET", `/repos/${OWNER}/${REPO}/actions/permissions`],
      [
        "actions.putPermissions",
        "PUT",
        `/repos/${OWNER}/${REPO}/actions/permissions`,
        { enabled: true, allowed_actions: "selected" },
      ],
      [
        "actions.getSelected",
        "GET",
        `/repos/${OWNER}/${REPO}/actions/permissions/selected-actions`,
      ],
      [
        "actions.putSelected",
        "PUT",
        `/repos/${OWNER}/${REPO}/actions/permissions/selected-actions`,
        { github_owned_allowed: true },
      ],
      ["actions.getWorkflow", "GET", `/repos/${OWNER}/${REPO}/actions/permissions/workflow`],
      [
        "actions.putWorkflow",
        "PUT",
        `/repos/${OWNER}/${REPO}/actions/permissions/workflow`,
        { default_workflow_permissions: "read" },
      ],
      ["actions.getAccess", "GET", `/repos/${OWNER}/${REPO}/actions/permissions/access`],
      [
        "actions.putAccess",
        "PUT",
        `/repos/${OWNER}/${REPO}/actions/permissions/access`,
        { access_level: "none" },
      ],
      [
        "actions.getForkPrApproval",
        "GET",
        `/repos/${OWNER}/${REPO}/actions/permissions/fork-pr-contributor-approval`,
      ],
      [
        "actions.putForkPrApproval",
        "PUT",
        `/repos/${OWNER}/${REPO}/actions/permissions/fork-pr-contributor-approval`,
        { approval_policy: "first_time_contributors" },
      ],
      [
        "actions.getForkPrPrivate",
        "GET",
        `/repos/${OWNER}/${REPO}/actions/permissions/fork-pr-workflows-private-repos`,
      ],
      [
        "actions.putForkPrPrivate",
        "PUT",
        `/repos/${OWNER}/${REPO}/actions/permissions/fork-pr-workflows-private-repos`,
        {
          run_workflows_from_fork_pull_requests: true,
          send_write_tokens_to_workflows: false,
          send_secrets_and_variables: false,
          require_approval_for_fork_pr_workflows: true,
        },
      ],
      // workflows: list, enable/disable (both + 404 branches)
      ["workflows.list", "GET", `/repos/${OWNER}/${REPO}/actions/workflows`],
      ["workflows.enable", "PUT", `/repos/${OWNER}/${REPO}/actions/workflows/9/enable`],
      ["workflows.disable", "PUT", `/repos/${OWNER}/${REPO}/actions/workflows/9/disable`],
      ["workflows.enable", "PUT", `/repos/${OWNER}/${REPO}/actions/workflows/999/enable`], // 404
      ["workflows.disable", "PUT", `/repos/${OWNER}/${REPO}/actions/workflows/999/disable`], // 404
      // pages: get, update, then remove (get-after-remove 404 covered elsewhere)
      ["pages.get", "GET", `/repos/${OWNER}/${REPO}/pages`],
      ["pages.update", "PUT", `/repos/${OWNER}/${REPO}/pages`, { cname: "x" }],
      ["pages.remove", "DELETE", `/repos/${OWNER}/${REPO}/pages`],
      // code-scanning: get, update 200 (no language change)
      [
        "code_scanning_default_setup.get",
        "GET",
        `/repos/${OWNER}/${REPO}/code-scanning/default-setup`,
      ],
      [
        "code_scanning_default_setup.update",
        "PATCH",
        `/repos/${OWNER}/${REPO}/code-scanning/default-setup`,
        { state: "configured" },
      ],
      // code-quality: get, update 200 (no language change), update 202
      ["code_quality_setup.get", "GET", `/repos/${OWNER}/${REPO}/code-quality/setup`],
      [
        "code_quality_setup.update",
        "PATCH",
        `/repos/${OWNER}/${REPO}/code-quality/setup`,
        { state: "configured" },
      ],
      [
        "code_quality_setup.update",
        "PATCH",
        `/repos/${OWNER}/${REPO}/code-quality/setup`,
        { state: "configured", languages: ["go"] },
      ], // 202 async configuration run (languages changed)
      // check-suite preferences: the one write-only PATCH (200 echo)
      [
        "check_suite_preferences.update",
        "PATCH",
        `/repos/${OWNER}/${REPO}/check-suites/preferences`,
        { auto_trigger_checks: [{ app_id: 15368, setting: false }] },
      ],
      // collaborators: list, update (invite = 201, refresh = 201, existing =
      // 204), the invitation trio (success + error branches), remove (both)
      ["collaborators.list", "GET", `/repos/${OWNER}/${REPO}/collaborators`],
      [
        "collaborators.update",
        "PUT",
        `/repos/${OWNER}/${REPO}/collaborators/dave`,
        { permission: "push" },
      ],
      [
        "collaborators.update",
        "PUT",
        `/repos/${OWNER}/${REPO}/collaborators/dave`,
        { permission: "pull" },
      ], // pending invitee refreshed, 201 again
      [
        "collaborators.update",
        "PUT",
        `/repos/${OWNER}/${REPO}/collaborators/carol`,
        { permission: "admin" },
      ], // existing collaborator, 204
      ["collaborators.listInvitations", "GET", `/repos/${OWNER}/${REPO}/invitations`],
      [
        "collaborators.updateInvitation",
        "PATCH",
        `/repos/${OWNER}/${REPO}/invitations/314`,
        { permissions: "write" },
      ],
      [
        "collaborators.updateInvitation",
        "PATCH",
        `/repos/${OWNER}/${REPO}/invitations/999999`,
        { permissions: "write" },
      ], // 404 error branch
      ["collaborators.cancelInvitation", "DELETE", `/repos/${OWNER}/${REPO}/invitations/999999`], // no-op 204
      ["collaborators.cancelInvitation", "DELETE", `/repos/${OWNER}/${REPO}/invitations/314`],
      ["collaborators.remove", "DELETE", `/repos/${OWNER}/${REPO}/collaborators/ghost`], // no-op 204
      ["collaborators.remove", "DELETE", `/repos/${OWNER}/${REPO}/collaborators/carol`],
      // teams: org, probe (both), grant
      ["teams.org", "GET", `/orgs/${OWNER}`],
      ["teams.probe", "GET", `/orgs/${OWNER}/teams/reviewers/repos/${OWNER}/${REPO}`],
      ["teams.probe", "GET", `/orgs/${OWNER}/teams/absent/repos/${OWNER}/${REPO}`], // 404
      [
        "teams.grant",
        "PUT",
        `/orgs/${OWNER}/teams/newteam/repos/${OWNER}/${REPO}`,
        { permission: "push" },
      ],
      // milestones: list, create, update (both + 404 branch)
      ["milestones.list", "GET", `/repos/${OWNER}/${REPO}/milestones`],
      ["milestones.create", "POST", `/repos/${OWNER}/${REPO}/milestones`, { title: "v2" }],
      ["milestones.update", "PATCH", `/repos/${OWNER}/${REPO}/milestones/1`, { state: "closed" }],
      ["milestones.update", "PATCH", `/repos/${OWNER}/${REPO}/milestones/999`, { state: "x" }], // 404
      // interaction limits: the base-limit trio (get empty, put, remove), the
      // creation cap (get, patch), and the bypass list (list, add, remove);
      // the 409 org-override and 405 cap-unavailable branches are flag-gated
      // and exercised by their own server below.
      ["interaction_limits.get", "GET", `/repos/${OWNER}/${REPO}/interaction-limits`],
      [
        "interaction_limits.put",
        "PUT",
        `/repos/${OWNER}/${REPO}/interaction-limits`,
        { limit: "collaborators_only" },
      ],
      ["interaction_limits.remove", "DELETE", `/repos/${OWNER}/${REPO}/interaction-limits`],
      [
        "interaction_limits.capGet",
        "GET",
        `/repos/${OWNER}/${REPO}/interaction-limits/pulls/creation-cap`,
      ],
      [
        "interaction_limits.capPatch",
        "PATCH",
        `/repos/${OWNER}/${REPO}/interaction-limits/pulls/creation-cap`,
        { enabled: true, max_open_pull_requests: 5 },
      ],
      [
        "interaction_limits.bypassList",
        "GET",
        `/repos/${OWNER}/${REPO}/interaction-limits/pulls/bypass-list`,
      ],
      [
        "interaction_limits.bypassAdd",
        "PUT",
        `/repos/${OWNER}/${REPO}/interaction-limits/pulls/bypass-list`,
        { users: ["dave"] },
      ],
      [
        "interaction_limits.bypassRemove",
        "DELETE",
        `/repos/${OWNER}/${REPO}/interaction-limits/pulls/bypass-list`,
        { users: ["dave"] },
      ],
    ];
    for (const [key, method, path, body] of cases) {
      const res = await call(h, method, path, body === undefined ? {} : { body });
      if (!statusAllowed(key, res.status)) {
        throw new Error(
          `handler ${key} returned status ${res.status}, which is neither declared [${[...declaredStatuses(key)].join(", ")}] nor a >= 400 error status`,
        );
      }
    }
    expect(h.violations).toHaveLength(0);
  });

  test("security-toggle GET returns an allowed status when the feature is absent", async () => {
    // A second server with the toggles unset exercises the "not enabled" branches; PVR answers 200
    // (enabled: false) where the other three answer 404.
    const h = await start(scenario());
    const branches: Array<[string, string]> = [
      ["repository.vulnerabilityAlertsGet", `/repos/${OWNER}/${REPO}/vulnerability-alerts`],
      ["repository.automatedSecurityFixesGet", `/repos/${OWNER}/${REPO}/automated-security-fixes`],
      [
        "repository.privateVulnerabilityReportingGet",
        `/repos/${OWNER}/${REPO}/private-vulnerability-reporting`,
      ],
      ["repository.immutableReleasesGet", `/repos/${OWNER}/${REPO}/immutable-releases`],
    ];
    for (const [key, path] of branches) {
      const res = await call(h, "GET", path);
      expect(
        statusAllowed(key, res.status),
        `handler ${key} returned status ${res.status}, which is neither declared [${[...declaredStatuses(key)].join(", ")}] nor a >= 400 error status`,
      ).toBe(true);
    }
  });

  test("owner-enforced immutable releases answer 409 on both writes", async () => {
    const h = await start(
      scenario({
        live_state: {
          repo: { immutable_releases_enabled: true, immutable_releases_enforced_by_owner: true },
        },
      }),
    );
    for (const method of ["PUT", "DELETE"] as const) {
      const res = await call(h, method, `/repos/${OWNER}/${REPO}/immutable-releases`);
      expect(res.status).toBe(409);
      const key =
        method === "PUT" ? "repository.immutableReleasesPut" : "repository.immutableReleasesRemove";
      expect(
        statusAllowed(key, res.status),
        `handler ${key} returned status ${res.status}, which is neither declared [${[...declaredStatuses(key)].join(", ")}] nor a >= 400 error status`,
      ).toBe(true);
    }
  });

  test("pages create answers an allowed status when a site already exists", async () => {
    // pages.create declares only 201, so the 422 conflict passes by the >= 400 error allowance.
    const h = await start(scenario({ live_state: { pages: { url: "u" } } }));
    const res = await call(h, "POST", `/repos/${OWNER}/${REPO}/pages`, {
      body: { source: { branch: "main", path: "/" } },
    });
    expect(res.status).toBe(422);
    expect(statusAllowed("pages.create", res.status)).toBe(true);
  });

  test("org-overridden interaction limits and an unavailable cap answer their declared statuses", async () => {
    const h = await start(
      scenario({
        live_state: {
          interaction_limits_org_override: true,
          pull_creation_cap_unavailable: true,
        },
      }),
    );
    const flagged: Array<[string, string, string, number, unknown?]> = [
      [
        "interaction_limits.put",
        "PUT",
        `/repos/${OWNER}/${REPO}/interaction-limits`,
        409,
        { limit: "existing_users" },
      ],
      ["interaction_limits.remove", "DELETE", `/repos/${OWNER}/${REPO}/interaction-limits`, 409],
      [
        "interaction_limits.capGet",
        "GET",
        `/repos/${OWNER}/${REPO}/interaction-limits/pulls/creation-cap`,
        405,
      ],
      [
        "interaction_limits.capPatch",
        "PATCH",
        `/repos/${OWNER}/${REPO}/interaction-limits/pulls/creation-cap`,
        405,
        { enabled: true },
      ],
    ];
    for (const [key, method, path, status, body] of flagged) {
      const res = await call(h, method, path, body === undefined ? {} : { body });
      expect(res.status).toBe(status);
      // Stronger than statusAllowed (any >= 400 passes there): these must stay DECLARED.
      expect(
        declaredStatuses(key).has(res.status),
        `handler ${key} must answer a status its endpoint declares`,
      ).toBe(true);
    }
  });
});

describe("pages create on empty state", () => {
  test("POST /pages creates the site (201) when none exists", async () => {
    const h = await start(scenario({ live_state: { pages: null } }));
    const res = await call(h, "POST", `/repos/${OWNER}/${REPO}/pages`, {
      body: { source: { branch: "main", path: "/" } },
    });
    expect(res.status).toBe(201);
    const site = {
      url: `https://api.github.com/repos/${OWNER}/${REPO}/pages`,
      source: { branch: "main", path: "/" },
    };
    expect(await json(res)).toEqual(site);
    expect(singleState(h).pages).toEqual(site);
  });
});

describe("fault injection", () => {
  test("rate_limit_403 answers 403 with a rate-limit body, then normal", async () => {
    const h = await start(scenario(), {
      faults: [{ key: "labels.list", kind: "rate_limit_403" }],
    });
    const faulted = await call(h, "GET", labelsPath);
    expect(faulted.status).toBe(403);
    // The ONLY 403 whose body may say "rate limit": the client classifies it as throttling, not a
    // permission denial.
    expect((await faulted.text()).toLowerCase()).toContain("rate limit");
    const normal = await call(h, "GET", labelsPath);
    expect(normal.status).toBe(200);
  });

  test("times: N applies the fault to the first N matching requests", async () => {
    const h = await start(scenario(), {
      faults: [{ key: "labels.list", kind: "rate_limit_403", times: 2 }],
    });
    expect((await call(h, "GET", labelsPath)).status).toBe(403);
    expect((await call(h, "GET", labelsPath)).status).toBe(403);
    expect((await call(h, "GET", labelsPath)).status).toBe(200);
  });

  test("429_then_200 answers the secondary-limit wire shape, then serves the handler", async () => {
    const h = await start(scenario(), {
      faults: [{ key: "labels.list", kind: "429_then_200" }],
    });
    const faulted = await call(h, "GET", labelsPath);
    expect(faulted.status).toBe(429);
    // Both details are load-bearing for the throttling plugin: the message must contain "secondary
    // rate", and Retry-After must be POSITIVE (a "0" is falsy and falls back to the plugin's 60s
    // default, which the app's callback would honor as a real 60s wait).
    expect(String((await json(faulted)).message)).toContain("secondary rate limit");
    expect(Number(faulted.headers.get("retry-after"))).toBeGreaterThan(0);
    const retried = await call(h, "GET", labelsPath);
    expect(retried.status).toBe(200);
  });

  test("connection_drop rejects the fetch outright and logs the attempt (status 0)", async () => {
    const h = await start(scenario({ live_state: { labels: [{ id: 1, name: "real" }] } }), {
      faults: [{ key: "labels.list", kind: "connection_drop" }],
    });
    // The socket is destroyed before any response bytes leave, so the fetch itself rejects; the
    // attempt is still logged with status 0.
    await expect(call(h, "GET", labelsPath)).rejects.toThrow();
    expect(h.requests.some((r) => r.status === 0)).toBe(true);
    const normal = await jsonArray(await call(h, "GET", labelsPath));
    expect(normal.map((l) => l.name)).toEqual(["real"]);
  });

  test("echo_422 rejects with the request body quoted back, budgeted like every fault, then serves the handler", async () => {
    const h = await start(scenario(), {
      faults: [{ key: "labels.create", kind: "echo_422" }],
    });
    const payload = { name: "echoed", color: "ff0000", description: "CANARY-in-body" };
    const faulted = await call(h, "POST", labelsPath, { body: payload });
    // A validation rejection is never retried, so the client sees exactly this body: the echo it must withhold
    // for a secret-carrying request lands in errors[].message verbatim.
    expect({ status: faulted.status, body: await json(faulted) }).toEqual({
      status: 422,
      body: {
        message: "Validation Failed",
        errors: [{ code: "custom", message: `rejected value: ${JSON.stringify(payload)}` }],
        documentation_url: "https://docs.github.com/rest",
      },
    });
    expect(singleState(h).labels.map((l) => l.name)).toEqual([]);
    const served = await call(h, "POST", labelsPath, { body: payload });
    expect(served.status).toBe(201);
    expect(singleState(h).labels.map((l) => l.name)).toEqual(["echoed"]);
    expect(h.requests.filter((r) => r.method === "POST").map((r) => r.status)).toEqual([422, 201]);
  });

  test("a fault only fires for its named endpoint", async () => {
    const h = await start(scenario(), {
      faults: [{ key: "labels.list", kind: "rate_limit_403" }],
    });
    expect((await call(h, "GET", `/repos/${OWNER}/${REPO}/milestones`)).status).toBe(200);
  });

  test("a fault/corrupt naming an unknown endpoint throws at construction", async () => {
    await expect(
      startMockServer(scenario(), { faults: [{ key: "labels.nope", kind: "rate_limit_403" }] }),
    ).rejects.toThrow(/unknown endpoint/);
    await expect(
      startMockServer(scenario(), { corrupt: { key: "ghost.list", mode: "invalid_json" } }),
    ).rejects.toThrow(/unknown endpoint/);
  });

  test("duplicate fault entries for one endpoint throw at construction", async () => {
    await expect(
      startMockServer(scenario(), {
        faults: [
          { key: "labels.list", kind: "rate_limit_403" },
          { key: "labels.list", kind: "connection_drop" },
        ],
      }),
    ).rejects.toThrow(/duplicate fault/);
  });
});

describe("state-flag gaps", () => {
  test("code-scanning update answers 409 when a run is in progress", async () => {
    const h = await start(
      scenario({
        live_state: { code_scanning: { state: "configured", configuration_run_in_progress: true } },
      }),
    );
    const res = await call(h, "PATCH", `/repos/${OWNER}/${REPO}/code-scanning/default-setup`, {
      body: { state: "configured", languages: ["javascript"] },
    });
    expect(res.status).toBe(409);
  });

  test("code-scanning update applies (202) without the in-progress flag", async () => {
    const h = await start(scenario({ live_state: { code_scanning: { state: "configured" } } }));
    const applied = await call(h, "PATCH", `/repos/${OWNER}/${REPO}/code-scanning/default-setup`, {
      body: { languages: ["javascript"] },
    });
    expect(applied.status).toBe(202);
  });

  test("private-vulnerability-reporting GET/DELETE answer 404 when not applicable", async () => {
    const h = await start(
      scenario({
        live_state: { repo: { private_vulnerability_reporting_not_applicable: true } },
      }),
    );
    const get = await call(h, "GET", `/repos/${OWNER}/${REPO}/private-vulnerability-reporting`);
    expect(get.status).toBe(404);
    const del = await call(h, "DELETE", `/repos/${OWNER}/${REPO}/private-vulnerability-reporting`);
    expect(del.status).toBe(404);
    expect(h.violations).toHaveLength(0);
  });

  test("PVR GET answers 200 when applicable (flag absent)", async () => {
    const h = await start(scenario());
    const get = await call(h, "GET", `/repos/${OWNER}/${REPO}/private-vulnerability-reporting`);
    expect(get.status).toBe(200);
  });
});
