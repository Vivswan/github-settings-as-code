import { describe, expect, test } from "bun:test";
import type { GitHubClient } from "../../../src/github/api.js";
import { type PlannedOp, planContext } from "../../../src/sections/contract/plan.js";
import { MockApi } from "../../../test/mock-api.js";
import { provePlanIdempotent } from "../../../test/sections/plan-idempotence.js";
import { REPO } from "../../../test/sections/section-run.js";
import { pagesSection } from "./index.js";

const GET = "GET /repos/o/r/pages";

/** A stateful fake of the Pages API, so a plan over executed state sees the converged site. */
function liveRepo(site: Record<string, unknown> | null): GitHubClient & { writes: string[] } {
  let live = site;
  return {
    writes: [],
    async tryRequest(method, path, payload) {
      if (method === "GET") {
        return live === null
          ? { error: { status: 404, message: "Not Found", body: "" } }
          : { data: live };
      }
      this.writes.push(`${method} ${path}`);
      if (method === "DELETE") {
        live = null;
      } else {
        live = { ...(live ?? {}), ...(payload as Record<string, unknown>) };
      }
      return { data: null };
    },
    async tryGraphql() {
      throw new Error("the pages section issues no GraphQL");
    },
  };
}

describe("pages shape", () => {
  const parse = (site: Record<string, unknown>) => pagesSection.shape.safeParse(site);

  test("every field only the site GET reports is refused at parse: the PUT has no slot for it, so it would drift on every run", () => {
    // Any JSON value: the GET's type for the key is irrelevant, the update body has no slot for it at all.
    const reported = {
      url: "x",
      status: "built",
      custom_404: true,
      html_url: "x",
      protected_domain_state: "verified",
      pending_domain_unverified_at: null,
      https_certificate: { state: "approved" },
    };
    const result = parse({ cname: "docs.example.com", ...reported });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path).sort()).toEqual(
      Object.keys(reported)
        .map((key) => [key])
        .sort(),
    );
    const custom404 = parse({ custom_404: true });
    expect(custom404.error?.issues.map((issue) => issue.message)).toEqual([
      "GitHub reports this field on the Pages site and the update has no such parameter, so the value " +
        "would be sent, ignored, and reported as drift on every run (it reports whether the published " +
        "site carries a 404.html; add that file to the source instead); remove it",
    ]);
  });

  test("a source.path other than / or /docs is refused at parse instead of a 422 at apply", () => {
    const result = parse({ source: { branch: "main", path: "/src" } });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => [issue.path, issue.message])).toEqual([
      [["source", "path"], 'Invalid option: expected one of "/"|"/docs"'],
    ]);
  });
});

describe("pages", () => {
  const plan = (api: MockApi, desired: Parameters<typeof pagesSection.plan>[1]) =>
    pagesSection.plan(planContext(pagesSection, api, REPO), desired);

  test("public drift carries the Enterprise Cloud note: github.com reports true and ignores the PUT, so it never converges", async () => {
    const api = new MockApi({ [GET]: { data: { build_type: "workflow", public: true } } });
    const result = await plan(api, { public: false });
    expect(result).toEqual({
      ops: [
        {
          role: "update",
          payload: { public: false },
          drift: ["pages.public: false != true"],
          change: "updated GitHub Pages configuration",
        },
      ],
      notes: [
        "pages.public: site visibility is settable only for organizations on GitHub Enterprise Cloud; " +
          "elsewhere GitHub reports public: true and ignores the field on the update, so this drift " +
          "never converges. Remove pages.public unless the repository belongs to an Enterprise Cloud " +
          "organization",
      ],
      drift: [],
    });
    // An Enterprise Cloud site that already matches gets no note: the drift, not the key, earns it.
    expect(await plan(api, { public: true })).toEqual({ ops: [], notes: [], drift: [] });
  });

  test("a live non-public site proves the host sets visibility, so making it public is ordinary drift", async () => {
    const api = new MockApi({ [GET]: { data: { build_type: "workflow", public: false } } });
    expect(await plan(api, { public: true })).toEqual({
      ops: [
        {
          role: "update",
          payload: { public: true },
          drift: ["pages.public: true != false"],
          change: "updated GitHub Pages configuration",
        },
      ],
      notes: [],
      drift: [],
    });
  });

  test("no live site: create carries build_type and source, then the update the rest", async () => {
    const api = new MockApi({}); // GET /pages 404s
    const result = await plan(api, {
      build_type: "legacy",
      source: { branch: "main", path: "/docs" },
      cname: "docs.example.com",
      https_enforced: true,
    });
    expect(result).toEqual({
      ops: [
        {
          role: "create",
          payload: { build_type: "legacy", source: { branch: "main", path: "/docs" } },
          drift: [
            "pages: declared in the settings file but GitHub Pages is not enabled on the repo; apply will enable it",
          ],
          change: "enabled GitHub Pages",
        },
        {
          role: "update",
          payload: {
            build_type: "legacy",
            source: { branch: "main", path: "/docs" },
            cname: "docs.example.com",
            https_enforced: true,
          },
          drift: [
            "pages: the create call takes only build_type and source, so apply will then set the remaining configuration (cname, https_enforced)",
          ],
          change: "applied remaining Pages configuration",
        },
      ],
      notes: [],
      drift: [],
    });
    expect(api.calls.map((c) => `${c.method} ${c.path}`)).toEqual([GET]);
  });

  test("a live site is updated in place only where it diverges", async () => {
    const api = new MockApi({ [GET]: { data: { build_type: "legacy", cname: null } } });
    const result = await plan(api, { build_type: "workflow" });
    expect(result.ops).toEqual([
      {
        role: "update",
        payload: { build_type: "workflow" },
        drift: ['pages.build_type: "workflow" != "legacy"'],
        change: "updated GitHub Pages configuration",
      },
    ]);
    const matching = await plan(api, { build_type: "legacy" });
    expect(matching).toEqual({ ops: [], notes: [], drift: [] });
  });

  test("a source without a path gets the default path everywhere", async () => {
    const api = new MockApi({ [GET]: { data: {} } });
    const result = await plan(api, { source: { branch: "main" } });
    expect(result.ops[0]?.payload).toEqual({ source: { branch: "main", path: "/" } });
  });

  test("an empty pages mapping is a note, not an empty PUT", async () => {
    const api = new MockApi({ [GET]: { data: {} } });
    expect(await plan(api, {})).toEqual({
      ops: [],
      notes: [
        "pages: declared as an empty mapping, which configures nothing (the update endpoint rejects an empty body). Declare at least one field, use pages: null to disable the site, or remove the section",
      ],
      drift: [],
    });
  });

  test("a passthrough key named like a prototype member still reaches the second PUT", async () => {
    // The create body is a plain object, so an `in` check would see Object.prototype's members and drop such a key from the remainder.
    const api = new MockApi({});
    const result = await plan(api, {
      source: { branch: "main" },
      constructor: "rides along",
    } as Parameters<typeof pagesSection.plan>[1]);
    expect(result.ops.map((op) => [op.role, op.payload])).toEqual([
      ["create", { source: { branch: "main", path: "/" } }],
      ["update", { source: { branch: "main", path: "/" }, constructor: "rides along" }],
    ]);
  });

  test("a passthrough value JSON cannot carry is a BUG naming its path, never a wire body", async () => {
    // The loose shape lets an arbitrary passthrough value through; plainData() is where only a JSON-plain one may leave.
    const api = new MockApi({ [GET]: { data: {} } });
    await expect(
      plan(api, { cname: "docs.example.com", hook: () => "x" } as unknown as Parameters<
        typeof pagesSection.plan
      >[1]),
    ).rejects.toThrow(/BUG: a planned payload carries a value JSON cannot carry at hook/);
    expect(api.mutations()).toEqual([]);
  });

  test("pages: null disables a live site and notes the ambiguous absence of one", async () => {
    const api = new MockApi({ [GET]: { data: { build_type: "legacy" } } });
    const result = await plan(api, null);
    expect(result).toEqual({
      ops: [
        {
          role: "remove",
          drift: [
            "pages: enabled live but the settings file declares pages: null; apply will disable GitHub Pages",
          ],
          change: "disabled GitHub Pages",
        },
      ],
      notes: [],
      drift: [],
    });
    expect(await plan(new MockApi({}), null)).toEqual({
      ops: [],
      notes: [
        "pages: declared null and GitHub reports no Pages site, so there is nothing to disable. A fine-grained token missing the Pages permission gets the same answer; if this repo does have a Pages site, grant the token Pages read and write",
      ],
      drift: [],
    });
  });

  test("executing the plan converges: create-then-update, then nothing", async () => {
    const api = liveRepo(null);
    const { second, changes } = await provePlanIdempotent(pagesSection, api, {
      build_type: "workflow",
      source: { branch: "main" },
      cname: "docs.example.com",
    });
    expect(changes).toEqual(["enabled GitHub Pages", "applied remaining Pages configuration"]);
    expect(api.writes).toEqual(["POST /repos/o/r/pages", "PUT /repos/o/r/pages"]);
    expect(second).toEqual({ ops: [], notes: [], drift: [] });
  });

  test("executing pages: null converges: the delete, then the nothing-to-disable note", async () => {
    const api = liveRepo({ build_type: "legacy" });
    const { second, changes } = await provePlanIdempotent(pagesSection, api, null);
    expect(changes).toEqual(["disabled GitHub Pages"]);
    expect(api.writes).toEqual(["DELETE /repos/o/r/pages"]);
    expect(second.ops).toEqual([]);
    expect(second.notes[0]).toStartWith("pages: declared null and GitHub reports no Pages site");
  });

  test("the read port exposes exactly the site probe, narrowed to its absent posture", () => {
    const ctx = planContext(pagesSection, new MockApi({}), REPO);
    expect(Object.keys(ctx.read)).toEqual(["get"]);
    // @ts-expect-error a write role is not a read: the port has no `create`
    ctx.read.create;
    // @ts-expect-error nor an `update`
    ctx.read.update;
    // @ts-expect-error nor a `remove`
    ctx.read.remove;
    // @ts-expect-error nor the raw client
    ctx.api;
    // @ts-expect-error an "absent" primary read offers no throwing helper
    ctx.read.get.call;
  });

  test("a planned operation can only name a declared write role, and must justify itself", () => {
    type Op = PlannedOp<typeof pagesSection.endpoints>;
    const read = { role: "get", drift: ["x"], change: "" } as const;
    // @ts-expect-error the get role is a read, not a plannable write
    const _read: Op = read;
    const silent = { role: "remove", drift: [], change: "" } as const;
    // @ts-expect-error a write on a non-alwaysRewrite endpoint must carry drift
    const _silent: Op = silent;
  });
});
