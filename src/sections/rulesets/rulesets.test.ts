import { describe, expect, test } from "bun:test";
import { executePlan } from "../../../src/engine/execute.js";
import type { GitHubClient } from "../../../src/github/api.js";
import {
  type PlannedOp,
  planContext,
  snapshotContext,
} from "../../../src/sections/contract/plan.js";
import { MockApi } from "../../../test/mock-api.js";
import { provePlanIdempotent } from "../../../test/sections/plan-idempotence.js";
import { REPO, unwrap } from "../../../test/sections/section-run.js";
import { validatedInput } from "../../../test/sections/validated-input.js";
import type { SectionFailure } from "../contract/errors.js";
import type { SectionInput } from "../contract/module.js";
import { normalizeRefName, normalizeRuleset, rulesetsSection } from "./index.js";
import type { RulesetConfig } from "./schema.js";

describe("normalizeRefName", () => {
  test.each([
    ["staging", "branch", "refs/heads/staging"],
    ["templates/*", "tag", "refs/tags/templates/*"],
    ["~DEFAULT_BRANCH", "branch", "~DEFAULT_BRANCH"],
    ["refs/heads/main", "branch", "refs/heads/main"],
  ] as const)("%s as a %s ref normalizes to %s", (value, target, expected) => {
    expect(normalizeRefName(value, target)).toBe(expected);
  });
});

describe("normalizeRuleset", () => {
  test("normalizes includes without mutating input", () => {
    const input = {
      name: "build-tags",
      target: "tag" as const,
      enforcement: "active" as const,
      conditions: { ref_name: { include: ["templates/*", "v*"], exclude: [] } },
    };
    const out = normalizeRuleset(input);
    expect(out.conditions?.ref_name?.include).toEqual(["refs/tags/templates/*", "refs/tags/v*"]);
    expect(input.conditions.ref_name.include).toEqual(["templates/*", "v*"]);
  });
});

/** A live ruleset as the list summary and the by-id read return it. */
type LiveRuleset = Record<string, unknown> & { id: number; name: string; source_type?: string };

/** A stateful fake of the rulesets API; `ignoredKeys` are accepted on a write and dropped, as GitHub does with a key it does not know. */
function liveRepo(
  rulesets: LiveRuleset[],
  ignoredKeys: readonly string[] = [],
): GitHubClient & { writes: string[] } {
  let nextId = 1000;
  const stored = (body: unknown): Record<string, unknown> =>
    Object.fromEntries(Object.entries(body ?? {}).filter(([key]) => !ignoredKeys.includes(key)));
  return {
    writes: [],
    async tryRequest(method, path, payload) {
      const byId = path.match(/\/rulesets\/(\d+)$/);
      const target = rulesets.find((r) => String(r.id) === byId?.[1]);
      if (method === "GET") {
        if (byId === null) {
          return { data: rulesets.map(({ id, name, source_type }) => ({ id, name, source_type })) };
        }
        return target === undefined
          ? { error: { status: 404, message: "Not Found", body: "" } }
          : { data: target };
      }
      this.writes.push(`${method} ${path}`);
      const body = stored(payload);
      if (method === "POST") {
        const created = { id: nextId++, source_type: "Repository", ...body } as LiveRuleset;
        rulesets.push(created);
        return { data: created };
      }
      if (target === undefined) {
        return { error: { status: 404, message: "Not Found", body: "" } };
      }
      if (method === "PUT") {
        Object.assign(target, body);
        return { data: target };
      }
      rulesets.splice(rulesets.indexOf(target), 1);
      return { data: null };
    },
    async tryGraphql() {
      throw new Error("the rulesets section issues no GraphQL");
    },
  };
}

describe("rulesets", () => {
  const listRoute = "GET /repos/o/r/rulesets?per_page=100&page=1";
  const plan = async (api: MockApi, desired: SectionInput<"rulesets">) =>
    unwrap(
      await rulesetsSection.plan(
        planContext(rulesetsSection, api, REPO),
        validatedInput("rulesets", desired),
      ),
    );
  /** A mock that would accept every write the section declares. */
  const writable = (routes: ConstructorParameters<typeof MockApi>[0]) =>
    new MockApi(routes).allowMutations(
      "POST /repos/o/r/rulesets",
      "PUT /repos/o/r/rulesets/*",
      "DELETE /repos/o/r/rulesets/*",
    );

  test("a missing ruleset plans a create with normalized refs; undeclared ones are notes", async () => {
    const api = writable({
      [listRoute]: { data: [{ id: 7, name: "legacy", source_type: "Repository" }] },
    });
    const result = await plan(api, [
      {
        name: "build-tags",
        target: "tag",
        enforcement: "active",
        conditions: { ref_name: { include: ["templates/*"], exclude: [] } },
        rules: [{ type: "deletion" }],
      },
    ]);
    expect(result).toEqual({
      ops: [
        {
          role: "create",
          payload: {
            name: "build-tags",
            target: "tag",
            enforcement: "active",
            conditions: { ref_name: { include: ["refs/tags/templates/*"], exclude: [] } },
            rules: [{ type: "deletion" }],
          },
          describe: 'creating ruleset "build-tags"',
          drift: [
            "rulesets[build-tags]: missing - declared in the settings file but not on the repo; apply will create it",
          ],
          change: 'created ruleset "build-tags"',
        },
      ],
      notes: [
        'ruleset "legacy" exists on the repo but is not declared in the settings file; kept under "_undeclared: keep" - add it to the settings file to manage it, or set "_undeclared: delete" to have apply DELETE it',
      ],
      drift: [],
    });
    expect(api.calls.map((c) => `${c.method} ${c.path}`)).toEqual([listRoute]);
  });

  test("a live rule's GitHub-filled parameter defaults under a declaration without a parameters key are not drift, since the PUT leaves them as they are", async () => {
    const api = writable({
      [listRoute]: { data: [{ id: 9, name: "main", source_type: "Repository" }] },
      "GET /repos/o/r/rulesets/9": {
        data: {
          id: 9,
          name: "main",
          target: "branch",
          enforcement: "active",
          conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
          rules: [
            {
              type: "pull_request",
              parameters: {
                required_approving_review_count: 1,
                dismiss_stale_reviews_on_push: false,
                require_code_owner_review: false,
                require_last_push_approval: false,
                required_review_thread_resolution: false,
                allowed_merge_methods: ["merge", "squash", "rebase"],
              },
            },
          ],
          bypass_actors: [],
        },
      },
    });
    const declared = {
      name: "main",
      target: "branch" as const,
      enforcement: "active" as const,
      conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
    };
    // A partial parameters mapping is refused at parse (the spec requires every pull_request parameter), so the
    // one form that leaves GitHub's defaults in place is a rule declared without a parameters key.
    expect(await plan(api, [{ ...declared, rules: [{ type: "pull_request" }] }])).toEqual({
      ops: [],
      notes: [],
      drift: [],
    });
  });

  test("a divergent existing ruleset plans a full-payload update carrying the subset drift and what the PUT would drop", async () => {
    const api = writable({
      [listRoute]: { data: [{ id: 9, name: "main", source_type: "Repository" }] },
      "GET /repos/o/r/rulesets/9": {
        data: {
          id: 9,
          name: "main",
          target: "branch",
          enforcement: "evaluate",
          rules: [{ type: "deletion" }, { type: "non_fast_forward" }],
          bypass_actors: [{ actor_id: 1, actor_type: "Team", bypass_mode: "always" }],
        },
      },
    });
    const result = await plan(api, [
      { name: "main", target: "branch", enforcement: "active", rules: [{ type: "deletion" }] },
    ]);
    expect(result).toEqual({
      ops: [
        {
          role: "update",
          params: { ruleset_id: "9" },
          payload: {
            name: "main",
            target: "branch",
            enforcement: "active",
            rules: [{ type: "deletion" }],
          },
          // The omitted line makes the op refuse itself in apply mode; the test below runs that hook.
          before: expect.any(Function),
          describe: 'updating ruleset "main"',
          drift: [
            'rulesets[main].enforcement: declared "active" != live "evaluate"; apply will set the declared value',
            "rulesets[main].rules[non_fast_forward]: present live but not declared",
            'rulesets[main].bypass_actors: live has [{"actor_id":1,"actor_type":"Team","bypass_mode":"always"}] but the settings file omits it, so apply would REMOVE it; declare bypass_actors to keep it, or bypass_actors: [] to remove it on purpose',
          ],
          change: 'updated ruleset "main"',
        },
      ],
      notes: [],
      drift: [],
    });
    expect(api.mutations()).toEqual([]);
  });

  test("apply refuses the update that would remove what the file omits: the PUT is never sent, and the failure carries the omitted line", async () => {
    const api = writable({
      [listRoute]: { data: [{ id: 9, name: "main", source_type: "Repository" }] },
      "GET /repos/o/r/rulesets/9": {
        data: {
          id: 9,
          name: "main",
          target: "branch",
          enforcement: "evaluate",
          rules: [{ type: "deletion" }],
          bypass_actors: [{ actor_id: 1, actor_type: "Team", bypass_mode: "always" }],
        },
      },
    });
    const planned = await plan(api, [
      { name: "main", target: "branch", enforcement: "active", rules: [{ type: "deletion" }] },
    ]);
    const execution = await executePlan(planned, rulesetsSection, api, REPO, {
      resolveSecret() {
        throw new Error("no secrets");
      },
    });
    expect(execution.status).toBe("failed");
    expect(execution.landed).toBe(0);
    expect((execution as { failure: SectionFailure }).failure.message).toBe(
      "rulesets[main]: not applied - the update would remove a live value the settings file omits. " +
        'rulesets[main].bypass_actors: live has [{"actor_id":1,"actor_type":"Team","bypass_mode":"always"}] but the settings file omits it, ' +
        "so apply would REMOVE it; declare bypass_actors to keep it, or bypass_actors: [] to remove it on purpose",
    );
    expect(api.mutations()).toEqual([]);
  });

  test("a key GitHub drops re-plans the identical update and note on every pass: documented non-convergence", async () => {
    // One read cannot tell a typo from a field GitHub omits until set, so the write is never withheld.
    const api = liveRepo(
      [{ id: 9, name: "main", source_type: "Repository", target: "branch", enforcement: "active" }],
      ["enforcemant"],
    );
    const misspelled = {
      name: "main",
      target: "branch" as const,
      enforcement: "active" as const,
      enforcemant: "evaluate",
    };
    const pass = async () =>
      unwrap(
        await rulesetsSection.plan(
          planContext(rulesetsSection, api, REPO),
          validatedInput("rulesets", [misspelled]),
        ),
      );
    const first = await pass();
    const execution = await executePlan(first, rulesetsSection, api, REPO, {
      resolveSecret() {
        throw new Error("no secrets");
      },
    });
    expect(execution).toEqual({
      status: "applied",
      changes: ['updated ruleset "main"'],
      notes: [],
      landed: 1,
    });
    const second = await pass();
    expect(first).toEqual({
      ops: [
        {
          role: "update",
          params: { ruleset_id: "9" },
          payload: misspelled,
          describe: 'updating ruleset "main"',
          drift: [
            'rulesets[main].enforcemant: declared "evaluate" but the API response has no such field (new or write-only field?)',
          ],
          change: 'updated ruleset "main"',
        },
      ],
      notes: [
        'rulesets[main]: declared key "enforcemant" does not exist on the live ruleset, so if GitHub ignores it this update will re-run on every apply without converging. Fix the key name, or remove it from the settings file',
      ],
      drift: [],
    });
    expect(second).toEqual(first);
    expect(api.writes).toEqual(["PUT /repos/o/r/rulesets/9"]);
  });

  describe("bypass_actors visibility", () => {
    // GitHub answers a non-admin GET without the bypass_actors key (never `[]`), so the declared list cannot be judged.
    const BASE = { id: 9, name: "main", target: "branch", enforcement: "active" };
    const HIDDEN_NOTE =
      "rulesets[main]: bypass_actors is not visible to this token (GitHub returns it only to a token with write access to the ruleset), so drift on it cannot be judged here; grant Administration write to check it";
    const team = { actor_id: 1, actor_type: "Team", bypass_mode: "always" } as const;
    const cases: Array<{
      name: string;
      declared: NonNullable<RulesetConfig["bypass_actors"]>;
      live: Record<string, unknown>;
      expected: Awaited<ReturnType<typeof plan>>;
    }> = [
      {
        name: "key absent live, declared []: converged with the visibility note",
        declared: [],
        live: BASE,
        expected: { ops: [], notes: [HIDDEN_NOTE], drift: [] },
      },
      {
        name: "key absent live, declared non-empty: converged with the visibility note",
        declared: [team],
        live: BASE,
        expected: { ops: [], notes: [HIDDEN_NOTE], drift: [] },
      },
      {
        name: "key present and different: real drift, no note",
        declared: [team],
        live: { ...BASE, bypass_actors: [] },
        expected: {
          ops: [
            {
              role: "update",
              params: { ruleset_id: "9" },
              payload: {
                name: "main",
                target: "branch",
                enforcement: "active",
                bypass_actors: [team],
              },
              describe: 'updating ruleset "main"',
              drift: ["rulesets[main].bypass_actors[Team 1]: missing live"],
              change: 'updated ruleset "main"',
            },
          ],
          notes: [],
          drift: [],
        },
      },
      {
        name: "key present and equal: converged, no note",
        declared: [team],
        live: { ...BASE, bypass_actors: [team] },
        expected: { ops: [], notes: [], drift: [] },
      },
      {
        name: "a live mode other than the default under a declaration that omits the mode is ONE line on that actor, since the PUT would reset it to always",
        declared: [{ actor_id: 1, actor_type: "Team" }],
        live: { ...BASE, bypass_actors: [{ ...team, bypass_mode: "pull_request" }] },
        expected: {
          ops: [
            {
              role: "update",
              params: { ruleset_id: "9" },
              payload: {
                name: "main",
                target: "branch",
                enforcement: "active",
                bypass_actors: [team],
              },
              describe: 'updating ruleset "main"',
              drift: [
                'rulesets[main].bypass_actors[Team 1].bypass_mode: "always" != "pull_request"',
              ],
              change: 'updated ruleset "main"',
            },
          ],
          notes: [],
          drift: [],
        },
      },
      {
        name: "GitHub's default fill on a live actor (bypass_mode always, a DeployKey's null id, the null an OrganizationAdmin's id can read back as) is not drift under a declaration that omits it",
        declared: [
          { actor_id: 1, actor_type: "Team" },
          { actor_type: "OrganizationAdmin" },
          { actor_type: "DeployKey" },
        ],
        live: {
          ...BASE,
          bypass_actors: [
            { actor_id: null, actor_type: "DeployKey", bypass_mode: "always" },
            { actor_id: null, actor_type: "OrganizationAdmin", bypass_mode: "always" },
            team,
          ],
        },
        expected: { ops: [], notes: [], drift: [] },
      },
      {
        name: "a hidden bypass_actors beside real drift: the note, the drift, and the full declared payload",
        declared: [team],
        live: { ...BASE, enforcement: "evaluate" },
        expected: {
          ops: [
            {
              role: "update",
              params: { ruleset_id: "9" },
              payload: {
                name: "main",
                target: "branch",
                enforcement: "active",
                bypass_actors: [team],
              },
              describe: 'updating ruleset "main"',
              drift: [
                'rulesets[main].enforcement: declared "active" != live "evaluate"; apply will set the declared value',
              ],
              change: 'updated ruleset "main"',
            },
          ],
          notes: [HIDDEN_NOTE],
          drift: [],
        },
      },
    ];
    for (const { name, declared, live, expected } of cases) {
      test(name, async () => {
        const api = writable({
          [listRoute]: { data: [{ id: 9, name: "main", source_type: "Repository" }] },
          "GET /repos/o/r/rulesets/9": { data: live },
        });
        const result = await plan(api, [
          { name: "main", target: "branch", enforcement: "active", bypass_actors: declared },
        ]);
        expect(result).toEqual(expected);
        expect(api.mutations()).toEqual([]);
      });
    }
  });

  test("a converged ruleset plans nothing: rules match by type regardless of order", async () => {
    const api = writable({
      [listRoute]: { data: [{ id: 9, name: "main", source_type: "Repository" }] },
      "GET /repos/o/r/rulesets/9": {
        data: {
          id: 9,
          name: "main",
          target: "branch",
          enforcement: "active",
          conditions: { ref_name: { include: ["refs/heads/main"], exclude: [] } },
          rules: [{ type: "non_fast_forward" }, { type: "deletion" }],
        },
      },
    });
    const result = await plan(api, [
      {
        name: "main",
        target: "branch",
        enforcement: "active",
        conditions: { ref_name: { include: ["main"] } },
        rules: [{ type: "deletion" }, { type: "non_fast_forward" }],
      },
    ]);
    expect(result).toEqual({ ops: [], notes: [], drift: [] });
    expect(api.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      listRoute,
      "GET /repos/o/r/rulesets/9",
    ]);
  });

  test("a repeated rule type is a validate issue at the ruleset's rules, and a live body repeating one fails loudly naming the ruleset", async () => {
    // Rules pair by type, so a repeat has no pairing; the settings-file case names the fix, the live case the defect.
    const bare = { name: "main", target: "branch" as const, enforcement: "active" as const };
    expect(
      rulesetsSection.validate([{ ...bare, rules: [{ type: "deletion" }, { type: "deletion" }] }]),
    ).toEqual([
      {
        path: "[0].rules",
        message:
          'the ruleset "main" lists the rule type "deletion" more than once, and GitHub keeps one rule per type - declare each type once',
      },
    ]);
    expect(
      rulesetsSection.validate([
        {
          ...bare,
          rules: [
            { type: "deletion" },
            { type: "deletion" },
            { type: "creation" },
            { type: "creation" },
          ],
        },
      ]),
    ).toEqual([
      expect.objectContaining({
        message: expect.stringContaining(
          'lists the rule types "deletion", "creation" more than once',
        ),
      }),
    ]);
    const api = writable({
      [listRoute]: { data: [{ id: 9, name: "main", source_type: "Repository" }] },
      "GET /repos/o/r/rulesets/9": {
        data: {
          id: 9,
          name: "main",
          target: "branch",
          enforcement: "active",
          rules: [{ type: "deletion" }, { type: "deletion" }],
        },
      },
    });
    await expect(plan(api, [{ ...bare, rules: [{ type: "deletion" }] }])).rejects.toThrow(
      'rulesets: GitHub returned the ruleset "main" (id 9) with the rule type "deletion" more than once, so its rules cannot be paired by type; delete the repeated rule on GitHub, then re-run',
    );
    expect(api.mutations()).toEqual([]);
  });

  test("_undeclared:delete deletes a repository-owned ruleset, a source_type-less one included, and never an inherited one", async () => {
    // source_type is optional in the API type; a body without it is read as repository-owned, the only kind the repository endpoints can write.
    const api = writable({
      [listRoute]: {
        data: [
          { id: 7, name: "ambiguous" },
          { id: 8, name: "org-owned", source_type: "Organization" },
          { id: 9, name: "enterprise-owned", source_type: "Enterprise" },
          { id: 10, name: "repo-owned", source_type: "Repository" },
        ],
      },
    });
    const undeclared = (name: string, id: number) => ({
      role: "remove" as const,
      params: { ruleset_id: String(id) },
      describe: `deleting undeclared ruleset "${name}"`,
      drift: [
        `rulesets[${name}]: undeclared - not in the settings file and "_undeclared: delete" is set, so apply will DELETE it; add it to the settings file to keep it`,
      ] as const,
      change: `DELETED undeclared ruleset "${name}"`,
    });
    expect(await plan(api, { _undeclared: "delete", entries: [] })).toEqual({
      ops: [undeclared("ambiguous", 7), undeclared("repo-owned", 10)],
      notes: [],
      drift: [],
    });
  });

  test("executing the plan converges: create, update, and delete land once, then the re-plan is empty", async () => {
    const api = liveRepo([
      { id: 7, name: "legacy", source_type: "Repository", enforcement: "active" },
      { id: 9, name: "main", source_type: "Repository", target: "branch", enforcement: "evaluate" },
      { id: 900, name: "org-baseline", source_type: "Organization", enforcement: "active" },
    ]);
    const { first, second, changes } = await provePlanIdempotent(rulesetsSection, api, {
      _undeclared: "delete",
      entries: [
        { name: "main", target: "branch", enforcement: "active", rules: [{ type: "deletion" }] },
        {
          name: "tags",
          target: "tag",
          enforcement: "active",
          conditions: { ref_name: { include: ["v*"] } },
        },
      ],
    });
    expect(changes).toEqual([
      'DELETED undeclared ruleset "legacy"',
      'updated ruleset "main"',
      'created ruleset "tags"',
    ]);
    expect(api.writes).toEqual([
      "DELETE /repos/o/r/rulesets/7",
      "PUT /repos/o/r/rulesets/9",
      "POST /repos/o/r/rulesets",
    ]);
    expect(first.drift).toEqual([]);
    expect(second).toEqual({ ops: [], notes: [], drift: [] });
  });

  test("the read port exposes the list and get roles, the list narrowed to its denied posture", () => {
    const ctx = planContext(rulesetsSection, new MockApi({}), REPO);
    expect(Object.keys(ctx.read)).toEqual(["list", "get"]);
    // @ts-expect-error a write role is not a read: the port has no `create`
    ctx.read.create;
    // @ts-expect-error nor an `update`
    ctx.read.update;
    // @ts-expect-error nor a `remove`
    ctx.read.remove;
    // @ts-expect-error nor the raw client
    ctx.api;
    // @ts-expect-error a "denied" primary read offers no 404-tolerant helper
    ctx.read.list.probeAbsent;
    // @ts-expect-error nor the tolerant tryCall
    ctx.read.list.tryCall;
  });

  test("a planned operation can only name a declared write role, and must justify itself", () => {
    // Compile-time only. Each rejected shape is built first and assigned on one line, so the @ts-expect-error anchors to the assignment whichever
    // property the compiler blames.
    type Op = PlannedOp<typeof rulesetsSection.endpoints>;
    const _create: Op = { role: "create", payload: { name: "x" }, drift: ["missing"], change: "" };
    const read = { role: "get", params: { ruleset_id: "1" }, drift: ["x"], change: "" } as const;
    // @ts-expect-error the get role is a read, not a plannable write
    const _read: Op = read;
    const paramless = { role: "update", payload: {}, drift: ["x"], change: "" } as const;
    // @ts-expect-error the route's ruleset_id path param is required
    const _paramless: Op = paramless;
    const silent = { role: "create", payload: {}, drift: [], change: "" } as const;
    // @ts-expect-error a write on a non-alwaysRewrite endpoint must carry drift
    const _silent: Op = silent;
  });
});

describe("rulesets snapshot", () => {
  const snapshot = async (api: GitHubClient) =>
    unwrap(await rulesetsSection.snapshot(snapshotContext(rulesetsSection, api, REPO, "fail")));

  /** A live ruleset as the by-id GET returns it, server fields included. */
  const served = (
    id: number,
    name: string,
    body: Record<string, unknown>,
  ): Record<string, unknown> & { id: number; name: string } => ({
    id,
    name,
    node_id: `RRS_${id}`,
    source_type: "Repository",
    source: "o/r",
    _links: { self: { href: `https://api.github.com/repos/o/r/rulesets/${id}` } },
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-02T00:00:00Z",
    current_user_can_bypass: "always",
    ...body,
  });

  test("reads repository rulesets back as keep entries, dropping server fields; a hidden bypass list and an inherited ruleset are notes, not entries", async () => {
    const api = liveRepo([
      served(1, "main", {
        target: "branch",
        enforcement: "active",
        conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
        rules: [
          { type: "deletion" },
          { type: "pull_request", parameters: { required_approving_review_count: 1 } },
        ],
        bypass_actors: [{ actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "always" }],
      }),
      // No bypass_actors KEY: what a token without write access is served.
      served(2, "tags", {
        target: "tag",
        enforcement: "evaluate",
        conditions: { ref_name: { include: ["refs/tags/v*"], exclude: [] } },
        rules: [{ type: "update" }],
      }),
      {
        ...served(3, "org-wide", { target: "branch", enforcement: "active" }),
        source_type: "Organization",
      },
    ]);
    expect(await snapshot(api)).toEqual({
      value: {
        _undeclared: "keep",
        entries: [
          {
            name: "main",
            target: "branch",
            enforcement: "active",
            conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
            rules: [
              { type: "deletion" },
              { type: "pull_request", parameters: { required_approving_review_count: 1 } },
            ],
            bypass_actors: [{ actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "always" }],
          },
        ],
      },
      notes: [
        'rulesets[org-wide]: left out of the snapshot - inherited from the organization (source_type "Organization"); manage it where it is defined',
        "rulesets[tags]: left out of the snapshot - bypass_actors is not visible to this token (GitHub returns it only to a token with write access to the ruleset), " +
          "and an entry without it would clear it on the next update; grant Administration write to read it back",
      ],
    });
    expect(api.writes).toEqual([]);
  });

  test("two repository rulesets under one name fail the snapshot naming both, since plan() upserts by name", async () => {
    const api = liveRepo([
      served(1, "main", { target: "branch", enforcement: "active" }),
      served(2, "main", { target: "tag", enforcement: "active" }),
    ]);
    await expect(snapshot(api)).rejects.toThrow(
      'rulesets: GitHub holds rulesets that resolve to one identity: "main (ruleset id 1)" and "main (ruleset id 2)". This section manages one ruleset per identity, so it cannot tell them apart; delete all but one of each on GitHub, then run again',
    );
  });

  test("an owned ruleset left out for its hidden bypass list leaves an empty keep wrapper, which plans as a no-op", async () => {
    const api = liveRepo([served(2, "tags", { target: "tag", enforcement: "evaluate" })]);
    const read = await snapshot(api);
    expect(read).toEqual({
      value: { _undeclared: "keep", entries: [] },
      notes: [
        "rulesets[tags]: left out of the snapshot - bypass_actors is not visible to this token (GitHub returns it only to a token with write access to the ruleset), " +
          "and an entry without it would clear it on the next update; grant Administration write to read it back",
      ],
    });
    const planned = unwrap(
      await rulesetsSection.plan(
        planContext(rulesetsSection, api, REPO),
        validatedInput("rulesets", read.value),
      ),
    );
    expect({ ops: planned.ops, drift: planned.drift }).toEqual({ ops: [], drift: [] });
    expect(api.writes).toEqual([]);
  });

  test("only inherited rulesets is nothing to declare, with the inherited note", async () => {
    const api = liveRepo([
      {
        ...served(3, "org-wide", { target: "branch", enforcement: "active" }),
        source_type: "Organization",
      },
    ]);
    expect(await snapshot(api)).toEqual({
      value: undefined,
      notes: [
        'rulesets[org-wide]: left out of the snapshot - inherited from the organization (source_type "Organization"); manage it where it is defined',
      ],
    });
  });
});
