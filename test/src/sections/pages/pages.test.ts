import { describe, expect, test } from "bun:test";
import type { GitHubClient } from "../../../../src/github/api.js";
import type { SectionInput } from "../../../../src/sections/contract/module.js";
import { planContext } from "../../../../src/sections/contract/plan.js";
import { pagesSection } from "../../../../src/sections/pages/index.js";
import { MockApi } from "../../../mock-api.js";
import { provePlanIdempotent } from "../../../sections/plan-idempotence.js";
import { REPO, unwrap } from "../../../sections/section-run.js";
import { validatedInput } from "../../../sections/validated-input.js";

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
  const plan = async (api: MockApi, desired: SectionInput<"pages">) =>
    unwrap(
      await pagesSection.plan(
        planContext(pagesSection, api, REPO),
        validatedInput("pages", desired),
      ),
    );

  test.each([
    [
      "github.com reports true and ignores the PUT, so the drift never converges and carries the Enterprise Cloud note",
      true,
      false,
      [
        "pages.public: site visibility is settable only for organizations on GitHub Enterprise Cloud; " +
          "elsewhere GitHub reports public: true and ignores the field on the update, so this drift " +
          "never converges. Remove pages.public unless the repository belongs to an Enterprise Cloud " +
          "organization",
      ],
    ],
    [
      "a live non-public site proves the host sets visibility, so making it public is ordinary drift",
      false,
      true,
      [],
    ],
  ])("public drift: %s", async (_title, live, declared, notes) => {
    const api = new MockApi({ [GET]: { data: { build_type: "workflow", public: live } } });
    expect(await plan(api, { public: declared })).toEqual({
      ops: [
        {
          role: "update",
          payload: { public: declared },
          drift: [`pages.public: ${declared} != ${live}`],
          change: "updated GitHub Pages configuration",
        },
      ],
      notes,
      drift: [],
    });
    // A site that already matches gets no note: the drift, not the key, earns it.
    expect(await plan(api, { public: live })).toEqual({ ops: [], notes: [], drift: [] });
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

  test("a site key the GET omits is plain drift the PUT resolves: no note, one PUT, converged", async () => {
    // GitHub marks https_enforced optional on the site: a site enabled through the create call alone
    // reports without it until the update sets it. The key is in the site shape, so it is not a phantom.
    const api = liveRepo({ build_type: "workflow", source: { branch: "main", path: "/" } });
    const { first, second } = await provePlanIdempotent(pagesSection, api, {
      https_enforced: true,
    });
    expect(first.notes).toEqual([]);
    expect(first.ops.map((op) => [op.role, op.drift])).toEqual([
      [
        "update",
        [
          "pages.https_enforced: declared true but the API response has no such field (new or write-only field?)",
        ],
      ],
    ]);
    expect(api.writes).toEqual(["PUT /repos/o/r/pages"]);
    expect(second).toEqual({ ops: [], notes: [], drift: [] });
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
    } as SectionInput<"pages">);
    expect(result.ops.map((op) => [op.role, op.payload])).toEqual([
      ["create", { source: { branch: "main", path: "/" } }],
      ["update", { source: { branch: "main", path: "/" }, constructor: "rides along" }],
    ]);
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
});
