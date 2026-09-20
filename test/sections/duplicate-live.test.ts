/**
 * The duplicate-live spine, over every section: two live items resolving to one identity fail plan()
 * and snapshot() with the one liveByIdentity refusal naming both, and nothing is written. The table
 * is keyed by SectionKey, so a new section compiles only once it is seeded here or listed among the
 * sections that read no live list, with the reason.
 */

import { describe, expect, test } from "bun:test";
import type { GitHubClient } from "../../src/github/api.js";
import type { SectionKey } from "../../src/schema.js";
import type { SectionModule } from "../../src/sections/contract/module.js";
import { planContext, snapshotContext } from "../../src/sections/contract/plan.js";
import { labelsSection } from "../../src/sections/labels/index.js";
import { SECTIONS } from "../../src/sections/registry.js";
import { completeRule, type LiveState, ruleWireNode } from "../e2e/mock/state.js";
import { type FragmentFake, registryFake } from "./fragment-fake.js";
import { REPO } from "./section-run.js";
import { STAMPS } from "./snapshot-rows/families.js";

/** One live list seeded with a pair under one identity. */
interface Seed {
  /** The list the pair sits in (`labels`, `environments[prod].variables`). */
  readonly list: string;
  readonly live: LiveState;
  /**
   * The declared value plan() runs against; absent when plan() has no list read over this identity
   * (branches probes by name; the environment listing is snapshot's alone), so only snapshot() is proven.
   */
  readonly declared?: unknown;
  /** The refusal, as liveByIdentity renders it: the noun, then each pair through liveIdentity. */
  readonly refusal: string;
  /**
   * A response the mock's state cannot hold (a record keyed by the identity itself, node ids minted
   * from the identity): the pair is served in place of the mock's answer to every GET on this path
   * (any page), or to the named GraphQL operations.
   */
  readonly served?:
    | { readonly path: string; readonly body: unknown; readonly ops?: never }
    | {
        readonly ops: readonly string[];
        readonly data: Record<string, unknown>;
        readonly path?: never;
      };
}

/**
 * A section whose plan() and snapshot() read no live list, and why. The claim is checked, not
 * trusted: both handlers run against the fake with `declared`, and a paginated read (a GET carrying
 * `per_page`, a GraphQL connection) fails the section's exemption.
 */
interface NoLiveList {
  readonly noLiveList: string;
  /** The declared value plan() runs against for the check. */
  readonly declared: unknown;
}

function refusal(section: SectionKey, plural: string, one: string, pair: string): string {
  return (
    `${section}: GitHub holds ${plural} that resolve to one identity: ${pair}. This section manages ` +
    `one ${one} per identity, so it cannot tell them apart; delete all but one of each on GitHub, then run again`
  );
}

const ENV = { name: "prod", protection_rules: [], deployment_branch_policy: null };

const ENV_WITH_POLICIES = {
  name: "prod",
  protection_rules: [],
  deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
};

/** A GraphQL rule node as the selection returns it, over the mock's fresh-rule defaults (every twin off), so only the id and pattern matter. */
function ruleNode(id: string, pattern: string): Record<string, unknown> {
  return ruleWireNode(completeRule({ id, pattern }));
}

function secretsSeed(key: SectionKey, family: keyof LiveState, noun: string): Seed[] {
  return [
    {
      list: key,
      live: {
        [family]: [
          { name: "deploy_token", ...STAMPS },
          { name: "DEPLOY_TOKEN", ...STAMPS },
        ],
      },
      declared: [],
      refusal: refusal(key, `${noun}s`, noun, '"deploy_token" and "DEPLOY_TOKEN"'),
    },
  ];
}

function variablesSeed(key: SectionKey, family: keyof LiveState, noun: string): Seed[] {
  return [
    {
      list: key,
      live: {
        [family]: [
          { name: "REGION", value: "eu", ...STAMPS },
          { name: "region", value: "us", ...STAMPS },
        ],
      },
      declared: [],
      refusal: refusal(key, `${noun}s`, noun, '"REGION" and "region"'),
    },
  ];
}

const SEEDS: { readonly [K in SectionKey]: readonly Seed[] | NoLiveList } = {
  repository: { noLiveList: "one repository object and one probe per toggle", declared: {} },
  labels: [
    {
      list: "labels",
      live: {
        labels: [
          { name: "bug", color: "d73a4a" },
          { name: "BUG", color: "ffffff" },
        ],
      },
      declared: [],
      refusal: refusal("labels", "labels", "label", '"bug" and "BUG"'),
    },
  ],
  rulesets: [
    {
      list: "rulesets",
      live: {
        rulesets: [
          {
            id: 1,
            name: "main",
            source_type: "Repository",
            target: "branch",
            enforcement: "active",
          },
          { id: 2, name: "main", source_type: "Repository", target: "tag", enforcement: "active" },
        ],
      },
      declared: [],
      refusal: refusal(
        "rulesets",
        "rulesets",
        "ruleset",
        '"main (ruleset id 1)" and "main (ruleset id 2)"',
      ),
    },
  ],
  environments: [
    {
      list: "environments",
      live: { environments: { Prod: { ...ENV, id: 1, name: "Prod" }, prod: { ...ENV, id: 2 } } },
      refusal: refusal(
        "environments",
        "environments",
        "environment",
        '"Prod (environment id 1)" and "prod (environment id 2)"',
      ),
    },
    {
      list: "environments[prod].variables",
      live: {
        environments: { prod: ENV },
        environment_variables: {
          prod: [
            { name: "REGION", value: "eu", ...STAMPS },
            { name: "region", value: "us", ...STAMPS },
          ],
        },
      },
      declared: [{ name: "prod", variables: [] }],
      refusal: refusal("environments", "variables", "variable", '"REGION" and "region"'),
    },
    {
      list: "environments[prod].secrets",
      live: {
        environments: { prod: ENV },
        environment_secrets: {
          prod: [
            { name: "deploy_token", ...STAMPS },
            { name: "DEPLOY_TOKEN", ...STAMPS },
          ],
        },
      },
      declared: [{ name: "prod", secrets: [] }],
      refusal: refusal(
        "environments",
        "prod environment secrets",
        "prod environment secret",
        '"deploy_token" and "DEPLOY_TOKEN"',
      ),
    },
    {
      list: "environments[prod].deployment_branch_policies",
      live: {
        environments: { prod: ENV_WITH_POLICIES },
        environment_branch_policies: {
          prod: [
            { id: 1, name: "release/*", type: "branch" },
            { id: 2, name: "release/*", type: "tag" },
          ],
        },
      },
      declared: [
        {
          name: "prod",
          deployment_branch_policy: ENV_WITH_POLICIES.deployment_branch_policy,
          deployment_branch_policies: [],
        },
      ],
      refusal: refusal(
        "environments",
        "deployment branch policies",
        "deployment branch policy",
        '"release/* (branch policy id 1)" and "release/* (branch policy id 2)"',
      ),
    },
    {
      list: "environments[prod].deployment_protection_rules",
      live: {
        environments: { prod: ENV },
        environment_protection_rules: {
          prod: [
            { id: 1, node_id: "DPR_1", enabled: true, app: { id: 3516, slug: "region-guard" } },
            { id: 2, node_id: "DPR_2", enabled: true, app: { id: 3516, slug: "region-guard" } },
          ],
        },
      },
      declared: [{ name: "prod", deployment_protection_rules: [] }],
      refusal: refusal(
        "environments",
        "deployment protection rules",
        "deployment protection rule",
        '"region-guard (protection rule id 1)" and "region-guard (protection rule id 2)"',
      ),
    },
    {
      list: "environments (pins)",
      live: {
        environments: { prod: ENV },
        pinned_environments: [
          { name: "prod", position: 1 },
          { name: "prod", position: 2 },
        ],
      },
      declared: [{ name: "prod", pinned: true }],
      refusal: refusal(
        "environments",
        "pinned environments",
        "pinned environment",
        '"prod (position 1)" and "prod (position 2)"',
      ),
    },
  ],
  branches: [
    {
      list: "branches (protected)",
      // Git refnames are unique, and the mock lists them from a set, so the pair is served straight.
      live: { branches: ["main"], branch_protection: { main: {} } },
      served: {
        path: "/repos/o/r/branches?protected=true",
        body: [{ name: "main" }, { name: "main" }],
      },
      refusal: refusal("branches", "protected branches", "protected branch", '"main" and "main"'),
    },
    {
      list: "branches (protection rules)",
      // The mock mints a rule's node id from its pattern, so a pair with two ids is served straight.
      live: {},
      served: {
        ops: ["BranchProtectionRules", "BranchProtectionRulesSnapshot"],
        data: {
          repository: {
            branchProtectionRules: {
              nodes: [ruleNode("BPR_1", "release/*"), ruleNode("BPR_2", "release/*")],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      },
      declared: [{ name: "release/*", protection: { enforce_admins: true } }],
      refusal: refusal(
        "branches",
        "protection rules",
        "protection rule",
        '"release/* (rule id BPR_1)" and "release/* (rule id BPR_2)"',
      ),
    },
  ],
  autolinks: [
    {
      list: "autolinks",
      live: {
        autolinks: [
          { id: 1, key_prefix: "JIRA-", url_template: "https://a.test/<num>" },
          { id: 2, key_prefix: "JIRA-", url_template: "https://b.test/<num>" },
        ],
      },
      declared: [],
      refusal: refusal(
        "autolinks",
        "autolinks",
        "autolink",
        '"JIRA- (autolink id 1)" and "JIRA- (autolink id 2)"',
      ),
    },
  ],
  actions: { noLiveList: "single-resource GETs, one per routed key", declared: {} },
  actions_secrets: secretsSeed("actions_secrets", "actions_secrets", "Actions secret"),
  dependabot_secrets: secretsSeed("dependabot_secrets", "dependabot_secrets", "Dependabot secret"),
  codespaces_secrets: secretsSeed("codespaces_secrets", "codespaces_secrets", "Codespaces secret"),
  agents_secrets: secretsSeed("agents_secrets", "agents_secrets", "Copilot agents secret"),
  workflows: [
    {
      list: "workflows",
      live: {
        workflows: [
          { id: 1, name: "CI", path: ".github/workflows/ci.yml", state: "active" },
          { id: 2, name: "CI", path: ".github/workflows/ci.yml", state: "disabled_manually" },
        ],
      },
      declared: [{ path: "ci.yml", state: "active" }],
      refusal: refusal(
        "workflows",
        "workflows",
        "workflow",
        '".github/workflows/ci.yml (workflow id 1)" and ".github/workflows/ci.yml (workflow id 2)"',
      ),
    },
  ],
  check_suite_preferences: {
    noLiveList: "write-only: GitHub exposes no read endpoint",
    declared: { auto_trigger_checks: [] },
  },
  pages: { noLiveList: "one site probe", declared: null },
  code_scanning_default_setup: { noLiveList: "one setup object", declared: {} },
  code_quality_setup: { noLiveList: "one setup object", declared: {} },
  collaborators: [
    {
      list: "collaborators",
      live: {
        collaborators: [
          { login: "Alice", role_name: "write" },
          { login: "alice", role_name: "read" },
        ],
      },
      declared: [],
      refusal: refusal("collaborators", "collaborators", "collaborator", '"Alice" and "alice"'),
    },
    {
      list: "collaborators (pending invitations)",
      live: {
        invitations: [
          { invitee: { login: "Bob" }, permissions: "read" },
          { invitee: { login: "bob" }, permissions: "write" },
        ],
      },
      declared: [],
      refusal: refusal(
        "collaborators",
        "pending invitations",
        "pending invitation",
        '"Bob (invitation id 90000000)" and "bob (invitation id 90000001)"',
      ),
    },
  ],
  teams: [
    {
      list: "teams",
      // The mock keys teams by the lowercase slug GitHub stores, so a pair with two spellings is served straight.
      live: {},
      served: {
        path: "/repos/o/r/teams",
        body: [
          { id: 7000, slug: "Platform" },
          { id: 7001, slug: "platform" },
        ],
      },
      declared: [],
      refusal: refusal(
        "teams",
        "teams",
        "team",
        '"Platform (team id 7000)" and "platform (team id 7001)"',
      ),
    },
  ],
  milestones: [
    {
      list: "milestones",
      live: {
        milestones: [
          { id: 1, number: 1, title: "v1", state: "open" },
          { id: 2, number: 2, title: "v1", state: "closed" },
        ],
      },
      declared: [],
      refusal: refusal(
        "milestones",
        "milestones",
        "milestone",
        '"v1 (milestone number 1)" and "v1 (milestone number 2)"',
      ),
    },
  ],
  interaction_limits: {
    noLiveList:
      "one limit object and one cap; the bypass list is reconciled as a set of logins, which GitHub holds unique",
    declared: null,
  },
  actions_variables: variablesSeed("actions_variables", "actions_variables", "Actions variable"),
  agents_variables: variablesSeed(
    "agents_variables",
    "agents_variables",
    "Copilot agents variable",
  ),
  webhooks: [
    {
      list: "webhooks",
      live: {
        hooks: [
          { id: 1, config: { url: "https://ci.example.com/hook" } },
          { id: 2, config: { url: "https://ci.example.com/hook" } },
        ],
      },
      declared: [],
      refusal: refusal(
        "webhooks",
        "webhooks",
        "webhook",
        '"https://ci.example.com/hook (hook id 1)" and "https://ci.example.com/hook (hook id 2)"',
      ),
    },
  ],
  custom_properties: [
    {
      list: "custom_properties",
      live: {
        custom_property_values: [
          { property_name: "team", value: "a" },
          { property_name: "team", value: "b" },
        ],
      },
      declared: [],
      refusal: refusal(
        "custom_properties",
        "custom properties",
        "custom property",
        '"team" and "team"',
      ),
    },
  ],
  deploy_keys: [
    {
      list: "deploy_keys",
      live: {
        deploy_keys: [
          { title: "ci", key: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOne" },
          { title: "ci", key: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITwo" },
        ],
      },
      declared: [],
      refusal: refusal(
        "deploy_keys",
        "deploy keys",
        "deploy key",
        '"ci (key id 90000000)" and "ci (key id 90000001)"',
      ),
    },
  ],
  secret_scanning_custom_patterns: [
    {
      list: "secret_scanning_custom_patterns",
      live: {
        secret_scanning_patterns: [
          { id: 1, name: "token", pattern: "a-[0-9]+" },
          { id: 2, name: "token", pattern: "b-[0-9]+" },
        ],
      },
      declared: [],
      refusal: refusal(
        "secret_scanning_custom_patterns",
        "secret scanning custom patterns",
        "secret scanning custom pattern",
        '"token (pattern id 1)" and "token (pattern id 2)"',
      ),
    },
  ],
};

/** The fake, or the fake answering one GET path or the named GraphQL operations with the served pair. */
function clientFor(fake: FragmentFake, seed: Seed): GitHubClient {
  const served = seed.served;
  if (served === undefined) {
    return fake;
  }
  return {
    tryRequest: (method, path, payload, options) =>
      served.path !== undefined && method === "GET" && path.startsWith(served.path)
        ? Promise.resolve({ data: served.body })
        : fake.tryRequest(method, path, payload, options),
    tryGraphql: (op, variables, slug, mark) =>
      served.ops?.includes(op.name)
        ? Promise.resolve({ data: served.data })
        : fake.tryGraphql(op, variables, slug, mark),
  };
}

function isSeeded(entry: readonly Seed[] | NoLiveList): entry is readonly Seed[] {
  return Array.isArray(entry);
}

/**
 * The exemption's check: plan() and snapshot() run against the default state, and neither may issue
 * a paginated read (a GET carrying `per_page`, the page loop's signature, or a GraphQL call carrying
 * the connection loop's `cursor` variable). An unpaginated list read through `call` is the one
 * shape this cannot see; the seed table covers it.
 */
async function proveNoLiveList(section: SectionModule, declared: unknown): Promise<void> {
  const fake = registryFake({});
  const reads: string[] = [];
  const api: GitHubClient = {
    tryRequest: (method, path, payload, options) => {
      if (method === "GET" && path.includes("per_page=")) {
        reads.push(`GET ${path}`);
      }
      return fake.tryRequest(method, path, payload, options);
    },
    tryGraphql: (op, variables, slug, mark) => {
      if (Object.hasOwn(variables, "cursor")) {
        reads.push(`GRAPHQL ${op.name}`);
      }
      return fake.tryGraphql(op, variables, slug, mark);
    },
  };
  await section.plan(planContext(section, api, REPO), declared as never);
  if (section.snapshot !== undefined) {
    await section.snapshot(snapshotContext(section, api, REPO, "fail"));
  }
  expect(reads, `${section.key} claims no live list`).toEqual([]);
}

describe("duplicate live identities", () => {
  test("every section is seeded with a pair or names why it reads no live list", () => {
    expect(Object.keys(SEEDS).sort()).toEqual(SECTIONS.map((section) => section.key).sort());
    for (const section of SECTIONS) {
      const entry = SEEDS[section.key];
      if (!isSeeded(entry)) {
        expect(entry.noLiveList.length, section.key).toBeGreaterThan(0);
        continue;
      }
      expect(entry.length, section.key).toBeGreaterThan(0);
      // A seed proves at least one of the two handlers, and the snapshot arm exists exactly where snapshot() does.
      for (const seed of entry) {
        expect(seed.declared !== undefined || section.snapshot !== undefined, seed.list).toBe(true);
      }
    }
  });

  const exempt = SECTIONS.flatMap((section) => {
    const entry = SEEDS[section.key];
    return isSeeded(entry) ? [] : [{ section, entry }];
  });

  test.each(exempt.map(({ section, entry }) => [section.key, section, entry] as const))(
    "%s claims no live list, and neither handler issues a paginated read",
    (_key, section: SectionModule, entry: NoLiveList) => proveNoLiveList(section, entry.declared),
  );

  test("the negative control: a section that lists fails the exemption's own assertion", async () => {
    await expect(proveNoLiveList(labelsSection, [])).rejects.toThrow(/claims no live list/);
  });

  const seeded = SECTIONS.flatMap((section) => {
    const entry = SEEDS[section.key];
    return isSeeded(entry) ? entry.map((seed) => ({ section, seed })) : [];
  });

  test.each(seeded.map(({ section, seed }) => [seed.list, section, seed] as const))(
    "%s: plan() and snapshot() refuse the pair, naming both, and write nothing",
    (_list, section: SectionModule, seed: Seed) => proveRefused(section, seed),
  );

  test("the negative control: a snapshot that skips the guard fails the proof, and so does a refusal with extra text", async () => {
    const [seed] = SEEDS.labels as readonly Seed[];
    const unguarded = {
      ...labelsSection,
      snapshot: async () => ({ value: undefined, notes: [] }),
    } as SectionModule;
    await expect(proveRefused(unguarded, seed as Seed)).rejects.toThrow();
    const padded = {
      ...labelsSection,
      snapshot: async () => {
        throw new Error(`${(seed as Seed).refusal} (and more)`);
      },
    } as SectionModule;
    await expect(proveRefused(padded, seed as Seed)).rejects.toThrow();
  });
});

/** The proof over one seed: each handler that reads the list refuses the pair and writes nothing. */
async function proveRefused(section: SectionModule, seed: Seed): Promise<void> {
  if (seed.declared !== undefined) {
    const fake = registryFake(seed.live);
    const api = clientFor(fake, seed);
    await expect(
      section.plan(planContext(section, api, REPO), seed.declared as never),
    ).rejects.toThrow(new Error(seed.refusal));
    expect(fake.writes).toEqual([]);
  }
  if (section.snapshot !== undefined) {
    const fake = registryFake(seed.live);
    const api = clientFor(fake, seed);
    await expect(section.snapshot(snapshotContext(section, api, REPO, "fail"))).rejects.toThrow(
      new Error(seed.refusal),
    );
    expect(fake.writes).toEqual([]);
  }
}
