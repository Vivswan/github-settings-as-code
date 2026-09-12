import { describe, expect, test } from "bun:test";
import type { MockHandle } from "./server.js";
import { call, json, jsonArray, mockServerLifecycle, scenario } from "./server-test-support.js";

const start = mockServerLifecycle();

describe("multi-repo mode", () => {
  const RAW_ACCEPT = "application/vnd.github.raw+json";
  const settingsPath = (slug: string) => `/repos/${slug}/contents/.github/settings.yml`;
  const contentsGet = (h: MockHandle, slug: string) =>
    call(h, "GET", settingsPath(slug), { headers: { accept: RAW_ACCEPT } });

  test("contents serves a configured slug's raw settings, 404s a null-settings slug", async () => {
    const h = await start(
      scenario({
        repos: {
          "e2e-owner/svc-a": { settings: { labels: [{ name: "x" }] } },
          "e2e-owner/svc-b": { settings: null },
        },
      }),
    );
    expect(h.working.mode).toBe("multi");
    const configured = await contentsGet(h, "e2e-owner/svc-a");
    expect(configured.status).toBe(200);
    expect(await configured.text()).toContain("labels");
    const missing = await contentsGet(h, "e2e-owner/svc-b");
    expect(missing.status).toBe(404);
  });

  test("contents rejects a non-GET method with a violation", async () => {
    const h = await start(scenario({ repos: { "e2e-owner/svc-a": { settings: {} } } }));
    const res = await call(h, "PUT", settingsPath("e2e-owner/svc-a"), {
      headers: { accept: RAW_ACCEPT },
      body: {},
    });
    expect(res.status).toBe(400);
    expect(h.violations.some((v) => v.includes("must be GET"))).toBe(true);
  });

  test("contents rejects a missing raw Accept header with a violation", async () => {
    const h = await start(scenario({ repos: { "e2e-owner/svc-a": { settings: {} } } }));
    // call() sends no Accept header at all (server-test-support.ts AUTH), so the raw type is missing.
    const res = await call(h, "GET", settingsPath("e2e-owner/svc-a"));
    expect(res.status).toBe(400);
    expect(h.violations.some((v) => v.includes("Accept"))).toBe(true);
  });

  test("contents is permission-gated: a Contents-denied slug answers a denial", async () => {
    const h = await start(
      scenario({
        repos: { "e2e-owner/locked": { settings: {}, permissions: { contents: "none" } } },
      }),
    );
    // A fine_grained read denial is a 404 (the action disambiguates via the repo probe).
    const res = await contentsGet(h, "e2e-owner/locked");
    expect(res.status).toBe(404);
    const log = h.requests.find((r) => r.pathname === settingsPath("e2e-owner/locked"));
    expect(log?.deniedBy).toBe("contents");
  });

  const refPath = (slug: string, ref: string) => `/repos/${slug}/git/ref/${ref}`;

  test("git ref read: the default branch head answers 200 for a fileless slug, any other ref 404s", async () => {
    const h = await start(scenario({ repos: { "e2e-owner/svc-b": { settings: null } } }));
    const head = await call(h, "GET", refPath("e2e-owner/svc-b", "heads/main"));
    expect(head.status).toBe(200);
    expect(await json(head)).toEqual({
      ref: "refs/heads/main",
      node_id: Buffer.from("MOCKREF:e2e-owner/svc-b:heads/main", "utf8").toString("base64"),
      url: "https://api.github.com/repos/e2e-owner/svc-b/git/refs/heads/main",
      object: {
        type: "commit",
        sha: "0123456789abcdef0123456789abcdef01234567",
        url: "https://api.github.com/repos/e2e-owner/svc-b/git/commits/0123456789abcdef0123456789abcdef01234567",
      },
    });
    const other = await call(h, "GET", refPath("e2e-owner/svc-b", "heads/develop"));
    expect(other.status).toBe(404);
    const unknown = await call(h, "GET", refPath("e2e-owner/nobody", "heads/main"));
    expect(unknown.status).toBe(404);
    expect(h.violations).toEqual([]);
  });

  test("git ref read is Contents-gated like the contents route", async () => {
    const h = await start(
      scenario({
        repos: { "e2e-owner/locked": { settings: null, permissions: { contents: "none" } } },
      }),
    );
    const res = await call(h, "GET", refPath("e2e-owner/locked", "heads/main"));
    expect(res.status).toBe(404);
    const log = h.requests.find((r) => r.pathname === refPath("e2e-owner/locked", "heads/main"));
    expect(log?.deniedBy).toBe("contents");
  });

  test("git ref read rejects a non-GET method with a violation", async () => {
    const h = await start(scenario({ repos: { "e2e-owner/svc-a": { settings: {} } } }));
    const res = await call(h, "POST", refPath("e2e-owner/svc-a", "heads/main"), { body: {} });
    expect(res.status).toBe(400);
    expect(h.violations).toEqual(["git ref read must be GET, got POST"]);
  });

  test("/user/repos enumerates the discovery pool, paginated", async () => {
    const pool = Array.from({ length: 100 }, (_, i) => ({ slug: `e2e-owner/repo-${i}` }));
    const h = await start(scenario({ discovery: { inputs: {}, pool } }));
    const first = await jsonArray(await call(h, "GET", "/user/repos?per_page=100&page=1"));
    const second = await jsonArray(await call(h, "GET", "/user/repos?per_page=100&page=2"));
    expect(first).toHaveLength(100);
    expect(second).toHaveLength(0);
    expect(first[0]?.full_name).toBe("e2e-owner/repo-0");
  });

  test("/user/repos does NOT client-side-filter archived/fork/topics", async () => {
    // Those are the action's job; the mock serves them verbatim so the action's
    // own filtering is what the scenario exercises.
    const h = await start(
      scenario({
        discovery: {
          inputs: {},
          pool: [{ slug: "e2e-owner/arch", archived: true, fork: true, topics: ["x"] }],
        },
      }),
    );
    const repos = await jsonArray(await call(h, "GET", "/user/repos"));
    expect(repos[0]).toMatchObject({
      full_name: "e2e-owner/arch",
      archived: true,
      fork: true,
      topics: ["x"],
    });
  });

  test("/user/repos server-side visibility: private retains internal, public drops it", async () => {
    // GitHub narrows visibility only coarsely, and the ACTION drops internal client-side
    // (discover.test.ts), so the mock must not drop it either.
    //   visibility=private -> private AND internal
    //   visibility=public  -> public only
    //   no param           -> the whole pool
    const h = await start(
      scenario({
        discovery: {
          inputs: {},
          pool: [
            { slug: "e2e-owner/pub", visibility: "public" },
            { slug: "e2e-owner/priv", visibility: "private" },
            { slug: "e2e-owner/int", visibility: "internal" },
          ],
        },
      }),
    );
    const priv = await jsonArray(await call(h, "GET", "/user/repos?visibility=private"));
    expect(priv.map((r) => r.full_name).sort()).toEqual(["e2e-owner/int", "e2e-owner/priv"]);
    const pub = await jsonArray(await call(h, "GET", "/user/repos?visibility=public"));
    expect(pub.map((r) => r.full_name)).toEqual(["e2e-owner/pub"]);
    const all = await jsonArray(await call(h, "GET", "/user/repos"));
    expect(all).toHaveLength(3);
  });

  test("section endpoints dispatch into the addressed slug's state", async () => {
    const h = await start(
      scenario({
        repos: {
          "e2e-owner/svc-a": { settings: {}, live_state: { labels: [{ id: 1, name: "a-only" }] } },
          "e2e-owner/svc-b": { settings: {}, live_state: { labels: [{ id: 2, name: "b-only" }] } },
        },
      }),
    );
    const aLabels = await jsonArray(await call(h, "GET", "/repos/e2e-owner/svc-a/labels"));
    const bLabels = await jsonArray(await call(h, "GET", "/repos/e2e-owner/svc-b/labels"));
    expect(aLabels.map((l) => l.name)).toEqual(["a-only"]);
    expect(bLabels.map((l) => l.name)).toEqual(["b-only"]);
    await call(h, "POST", "/repos/e2e-owner/svc-a/labels", { body: { name: "new-a" } });
    const bAfter = await jsonArray(await call(h, "GET", "/repos/e2e-owner/svc-b/labels"));
    expect(bAfter.map((l) => l.name)).toEqual(["b-only"]);
  });

  test("the disambiguation probe serves the addressed slug's repo object", async () => {
    const h = await start(scenario({ repos: { "e2e-owner/svc-a": { settings: {} } } }));
    const probe = await json(await call(h, "GET", "/repos/e2e-owner/svc-a"));
    expect(probe.full_name).toBe("e2e-owner/svc-a");
    expect(probe.name).toBe("svc-a");
  });

  test("the org probe (GET /orgs/{owner}) is served from the shared org state, not slug-routed", async () => {
    const h = await start(scenario({ repos: { "e2e-owner/svc-a": { settings: {} } } }));
    const org = await call(h, "GET", "/orgs/e2e-owner");
    expect(org.status).toBe(200);
    expect((await json(org)).login).toBe("e2e-owner");
    expect(h.violations).toHaveLength(0);
  });

  test("the org probe 404s under a personal-account owner_kind", async () => {
    const h = await start(
      scenario({ owner_kind: "user", repos: { "e2e-owner/svc-a": { settings: {} } } }),
    );
    expect((await call(h, "GET", "/orgs/e2e-owner")).status).toBe(404);
  });

  test("a team-repo route resolves its {owner}/{repo} tail to the addressed slug's state", async () => {
    const h = await start(
      scenario({
        owner_kind: "org",
        repos: {
          "e2e-owner/svc-a": {
            settings: {},
            live_state: { teams: { reviewers: { role_name: "write" } } },
          },
          "e2e-owner/svc-b": { settings: {} },
        },
      }),
    );
    const res = await call(h, "GET", "/orgs/e2e-owner/teams/reviewers/repos/e2e-owner/svc-a");
    expect(res.status).toBe(200);
    expect((await json(res)).role_name).toBe("write");
    const missing = await call(h, "GET", "/orgs/e2e-owner/teams/reviewers/repos/e2e-owner/svc-b");
    expect(missing.status).toBe(404);
    expect(h.violations).toHaveLength(0);
  });

  test("team-repo grading: org_members always grades against the GLOBAL mask", async () => {
    // org_members is org-wide, so a per-slug org_members:write must NOT loosen a global
    // org_members:none; the per-slug administration half is the two tests below.
    const h = await start(
      scenario({
        owner_kind: "org",
        token_permissions: { org_members: "none" },
        repos: {
          "e2e-owner/svc-a": {
            settings: {},
            permissions: { org_members: "write" },
            live_state: { teams: { reviewers: { role_name: "write" } } },
          },
        },
      }),
    );
    const res = await call(h, "GET", "/orgs/e2e-owner/teams/reviewers/repos/e2e-owner/svc-a");
    expect(res.status).toBe(404); // denied by global org_members: none
    const log = h.requests.find((r) => r.pathname.includes("/teams/reviewers/"));
    expect(log?.deniedBy).toBe("org_members");
  });

  test("team-repo grading: administration grades PER-SLUG (denied on A, allowed on B)", async () => {
    // administration is a repository permission on the ADDRESSED repo, so with global org_members
    // write the team-repo call follows each slug's own grade, matching the oracle's orgMask model.
    const h = await start(
      scenario({
        owner_kind: "org",
        token_permissions: { org_members: "write" },
        repos: {
          "e2e-owner/svc-a": {
            settings: {},
            permissions: { administration: "none" },
            live_state: { teams: { reviewers: { role_name: "write" } } },
          },
          "e2e-owner/svc-b": {
            settings: {},
            permissions: { administration: "write" },
            live_state: { teams: { reviewers: { role_name: "write" } } },
          },
        },
      }),
    );
    const a = await call(h, "GET", "/orgs/e2e-owner/teams/reviewers/repos/e2e-owner/svc-a");
    expect(a.status).toBe(404);
    expect(h.requests.find((r) => r.pathname.endsWith("/repos/e2e-owner/svc-a"))?.deniedBy).toBe(
      "administration",
    );
    const b = await call(h, "GET", "/orgs/e2e-owner/teams/reviewers/repos/e2e-owner/svc-b");
    expect(b.status).toBe(200);
  });

  test("team-repo grading: global org_members:none denies BOTH regardless of per-slug administration", async () => {
    const h = await start(
      scenario({
        owner_kind: "org",
        token_permissions: { org_members: "none" },
        repos: {
          "e2e-owner/svc-a": {
            settings: {},
            permissions: { administration: "write" },
            live_state: { teams: { reviewers: { role_name: "write" } } },
          },
          "e2e-owner/svc-b": {
            settings: {},
            permissions: { administration: "write" },
            live_state: { teams: { reviewers: { role_name: "write" } } },
          },
        },
      }),
    );
    for (const slug of ["svc-a", "svc-b"]) {
      const res = await call(h, "GET", `/orgs/e2e-owner/teams/reviewers/repos/e2e-owner/${slug}`);
      expect(res.status).toBe(404);
      expect(
        h.requests.find((r) => r.pathname.endsWith(`/repos/e2e-owner/${slug}`))?.deniedBy,
      ).toBe("org_members");
    }
  });

  test("per-slug permission mask scopes a denial to one repository", async () => {
    const h = await start(
      scenario({
        repos: {
          "e2e-owner/svc-a": { settings: {}, permissions: { issues: "none" } },
          "e2e-owner/svc-b": { settings: {}, permissions: { issues: "write" } },
        },
      }),
    );
    expect((await call(h, "GET", "/repos/e2e-owner/svc-a/labels")).status).toBe(404);
    expect((await call(h, "GET", "/repos/e2e-owner/svc-b/labels")).status).toBe(200);
  });

  test("the per-slug mask OVERLAYS the global mask (global is not a no-op)", async () => {
    const h = await start(
      scenario({
        token_permissions: { issues: "none" },
        repos: {
          "e2e-owner/svc-a": { settings: {} },
          "e2e-owner/svc-b": { settings: {}, permissions: { issues: "write" } },
        },
      }),
    );
    expect((await call(h, "GET", "/repos/e2e-owner/svc-a/labels")).status).toBe(404);
    expect((await call(h, "GET", "/repos/e2e-owner/svc-b/labels")).status).toBe(200);
  });

  test("a request to an unknown slug is a violation", async () => {
    const h = await start(scenario({ repos: { "e2e-owner/svc-a": { settings: {} } } }));
    const res = await call(h, "GET", "/repos/e2e-owner/ghost/labels");
    expect(res.status).toBe(400);
    expect(h.violations.some((v) => v.includes("no known target slug"))).toBe(true);
  });

  test("the denial barrier does not leak across slugs (per-target keying)", async () => {
    const h = await start(
      scenario({
        denial_style: 403,
        repos: {
          "e2e-owner/svc-a": { settings: {}, permissions: { issues: "none" } },
          "e2e-owner/svc-b": { settings: {}, permissions: { issues: "write" } },
        },
      }),
    );
    expect((await call(h, "GET", "/repos/e2e-owner/svc-a/labels")).status).toBe(403);
    const write = await call(h, "POST", "/repos/e2e-owner/svc-b/labels", { body: { name: "x" } });
    expect(write.status).toBe(201);
    expect(h.violations).toHaveLength(0);
  });

  test("a team-repo route naming an unknown slug is a violation (not an orgState fallback)", async () => {
    // A silent fall-through to orgState would let a buggy write mutate shared org state; only
    // slug-less routes (the bare org probe) use orgState.
    const h = await start(
      scenario({ owner_kind: "org", repos: { "e2e-owner/svc-a": { settings: {} } } }),
    );
    const res = await call(h, "PUT", "/orgs/e2e-owner/teams/reviewers/repos/e2e-owner/ghost", {
      body: { permission: "push" },
    });
    expect(res.status).toBe(400);
    expect(h.violations.some((v) => v.includes("no known target slug"))).toBe(true);
    expect((await call(h, "GET", "/orgs/e2e-owner")).status).toBe(200);
  });

  test("a fault does not mask the unknown-target violation (resolution runs first)", async () => {
    // The unknown-target check is a harness-integrity invariant, so resolution raises it before the
    // fault barrier can consume the budget.
    const h = await start(scenario({ repos: { "e2e-owner/svc-a": { settings: {} } } }), {
      faults: [{ key: "labels.list", kind: "rate_limit_403" }],
    });
    const res = await call(h, "GET", "/repos/e2e-owner/ghost/labels");
    expect(res.status).toBe(400); // the unknown-target violation, NOT the 403 fault
    expect(h.violations.some((v) => v.includes("no known target slug"))).toBe(true);
    expect((await call(h, "GET", "/repos/e2e-owner/svc-a/labels")).status).toBe(403);
  });
});

describe("private-report bypass is scoped to redact-and-deliver targets", () => {
  const jsonHeaders = { "content-type": "application/json" };

  test("a marker-label POST in check mode to a PUBLIC target hits the check-mode barrier", async () => {
    // The report-infra bypass writes even in check mode, but ONLY for a report-delivery target; a
    // marker POST to a public slug falls through to labels.create and the check-mode barrier.
    const target = "e2e-owner/svc-pub";
    const h = await start(
      scenario({
        inputs: { mode: "check", private_report: "issue" },
        repos: { [target]: { settings: {}, live_state: { repo: { visibility: "public" } } } },
      }),
    );
    const res = await call(h, "POST", `/repos/${target}/labels`, {
      headers: jsonHeaders,
      body: { name: "settings-as-code-report" },
    });
    expect(res.status).toBe(400);
    expect(h.violations.some((v) => v.startsWith("write in check mode"))).toBe(true);
  });

  test("issue traffic to a PUBLIC (non-delivery) target is a loud no-route violation", async () => {
    // An issue POST to a public slug is accidental delivery: the bypass does not serve it, and no
    // section has an /issues route, so fuzz can reject a stray report write to a public repo.
    const target = "e2e-owner/svc-pub";
    const h = await start(
      scenario({
        inputs: { private_report: "issue" },
        repos: { [target]: { settings: {}, live_state: { repo: { visibility: "public" } } } },
      }),
    );
    const res = await call(h, "POST", `/repos/${target}/issues`, {
      headers: jsonHeaders,
      body: { title: "x", body: "y" },
    });
    expect(res.status).toBe(400);
    expect(h.violations.some((v) => v.includes("no route in routes.ts"))).toBe(true);
  });

  test("the same issue POST to a PRIVATE delivery target IS served (control)", async () => {
    // The scoping gates on proven visibility, not on the path alone.
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
    );
    const res = await call(h, "POST", `/repos/${target}/issues`, {
      headers: jsonHeaders,
      body: { title: "x", body: "y", labels: ["settings-as-code-report"] },
    });
    expect(res.status).toBe(201);
    expect(h.violations).toHaveLength(0);
  });

  test("delivery to a private target whose PROBE is denied is a no-route violation", async () => {
    // The fixture is private, but administration:none denies the visibility probe, so the action
    // resolves "unknown" and must NOT deliver. The mock models provability, not the fixture alone.
    const target = "e2e-owner/svc-unprovable";
    const h = await start(
      scenario({
        inputs: { private_report: "issue" },
        repos: {
          [target]: {
            settings: {},
            live_state: { repo: { private: true, visibility: "private" } },
            permissions: { administration: "none" },
          },
        },
      }),
    );
    const res = await call(h, "POST", `/repos/${target}/issues`, {
      headers: jsonHeaders,
      body: { title: "x", body: "y" },
    });
    expect(res.status).toBe(400);
    expect(h.violations.some((v) => v.includes("no route in routes.ts"))).toBe(true);
  });

  test("delivery to a private target whose probe FAULTS out its budget is a no-route violation", async () => {
    // A probe that faults out its whole retry budget never resolves: the same provability rule as
    // the denied probe, via the fault path.
    const target = "e2e-owner/svc-faulted";
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
      { faults: [{ key: "repository.get", kind: "rate_limit_403", times: 3 }] },
    );
    const res = await call(h, "POST", `/repos/${target}/issues`, {
      headers: jsonHeaders,
      body: { title: "x", body: "y" },
    });
    expect(res.status).toBe(400);
    expect(h.violations.some((v) => v.includes("no route in routes.ts"))).toBe(true);
  });

  test("a DISCOVERY-supplied private target IS a delivery target (visibility needs no probe)", async () => {
    // A repo discovered via /user/repos carries its visibility already, so the action delivers
    // without a probe; the mock seeds the discovered repo's state from the pool, so its gate agrees.
    const target = "e2e-owner/disc-priv";
    const h = await start(
      scenario({
        inputs: { private_report: "issue" },
        discovery: { pool: [{ slug: target, visibility: "private" }], inputs: {} },
      }),
    );
    const res = await call(h, "POST", `/repos/${target}/issues`, {
      headers: jsonHeaders,
      body: { title: "x", body: "y", labels: ["settings-as-code-report"] },
    });
    expect(res.status).toBe(201);
    expect(h.violations).toHaveLength(0);
  });
});
