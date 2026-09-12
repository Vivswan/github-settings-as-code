/**
 * Every section with a snapshot(), enrolled in the round-trip proof over the e2e mock's own
 * handlers: the seeded live state reads back as exactly the expected value and notes, and
 * planning that value against the same state converges. A section that gains snapshot() without
 * a row here, or loses it while keeping one, fails the enrollment tripwire.
 */

import { describe, expect, test } from "bun:test";
import type { SectionKey } from "../../src/schema.js";
import { actionsSecretsSection } from "../../src/sections/actions_secrets/index.js";
import { actionsVariablesSection } from "../../src/sections/actions_variables/index.js";
import { agentsSecretsSection } from "../../src/sections/agents_secrets/index.js";
import { agentsVariablesSection } from "../../src/sections/agents_variables/index.js";
import { autolinksSection } from "../../src/sections/autolinks/index.js";
import { codeQualitySetupSection } from "../../src/sections/code_quality_setup/index.js";
import { codeScanningDefaultSetupSection } from "../../src/sections/code_scanning_default_setup/index.js";
import { codespacesSecretsSection } from "../../src/sections/codespaces_secrets/index.js";
import { planContext } from "../../src/sections/contract/plan.js";
import { customPropertiesSection } from "../../src/sections/custom_properties/index.js";
import { dependabotSecretsSection } from "../../src/sections/dependabot_secrets/index.js";
import { deployKeysSection } from "../../src/sections/deploy_keys/index.js";
import { interactionLimitsSection } from "../../src/sections/interaction_limits/index.js";
import { labelsSection } from "../../src/sections/labels/index.js";
import { milestonesSection } from "../../src/sections/milestones/index.js";
import { pagesSection } from "../../src/sections/pages/index.js";
import { SECTIONS } from "../../src/sections/registry.js";
import { secretScanningPatternsSection } from "../../src/sections/secret_scanning_custom_patterns/index.js";
import { webhooksSection } from "../../src/sections/webhooks/index.js";
import { workflowsSection } from "../../src/sections/workflows/index.js";
import type { LiveState } from "../e2e/mock/state.js";
import { registryFake } from "./fragment-fake.js";
import { REPO } from "./section-run.js";
import { proveSnapshotRoundTrip, type SnapshotSection } from "./snapshot-roundtrip.js";

/** The sections snapshot reads back today; the tripwire below pins it to the registry. */
type SnapshotKey =
  | "labels"
  | "autolinks"
  | "actions_secrets"
  | "dependabot_secrets"
  | "codespaces_secrets"
  | "agents_secrets"
  | "workflows"
  | "pages"
  | "code_scanning_default_setup"
  | "code_quality_setup"
  | "milestones"
  | "interaction_limits"
  | "actions_variables"
  | "agents_variables"
  | "webhooks"
  | "custom_properties"
  | "deploy_keys"
  | "secret_scanning_custom_patterns";

interface Row {
  readonly section: SnapshotSection;
  /** The live state seeded into the mock; must hold at least one resource of the section's. */
  readonly live: LiveState;
  /** The whole snapshot the seeded state reads back as. */
  readonly expected: { value: unknown; notes: string[] };
}

const STAMPS = { created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" };

/**
 * One secret family's row: the names read back as per-store references (so the same name in two
 * stores never shares a variable), one note each; a reserved-looking name needs no escape.
 */
function secretsRow(section: SnapshotSection, store: string, family: keyof LiveState): Row {
  const STORE = store.toUpperCase();
  return {
    section,
    live: {
      [family]: [
        { name: "DEPLOY_TOKEN", ...STAMPS },
        { name: "GITHUB_PAT", ...STAMPS },
      ],
    },
    expected: {
      value: {
        _undeclared: "keep",
        entries: [
          { name: "DEPLOY_TOKEN", value: `$SECRET_${STORE}_DEPLOY_TOKEN` },
          { name: "GITHUB_PAT", value: `$SECRET_${STORE}_GITHUB_PAT` },
        ],
      },
      notes: [
        `${section.key}[DEPLOY_TOKEN]: value of DEPLOY_TOKEN is not readable; export it into the environment as SECRET_${STORE}_DEPLOY_TOKEN before apply`,
        `${section.key}[GITHUB_PAT]: value of GITHUB_PAT is not readable; export it into the environment as SECRET_${STORE}_GITHUB_PAT before apply`,
      ],
    },
  };
}

/** One variable family's row: name and value, the timestamps dropped. */
function variablesRow(section: SnapshotSection, family: keyof LiveState): Row {
  return {
    section,
    live: { [family]: [{ name: "REGION", value: "eu-west-1", ...STAMPS }] },
    expected: {
      value: { _undeclared: "delete", entries: [{ name: "REGION", value: "eu-west-1" }] },
      notes: [],
    },
  };
}

const ROWS: { readonly [K in SnapshotKey]: Row } = {
  labels: {
    section: labelsSection,
    live: {
      labels: [
        { name: "bug", color: "d73a4a", description: "Something is broken" },
        { name: "docs", color: "0075CA" },
      ],
    },
    expected: {
      value: {
        _undeclared: "delete",
        entries: [
          { name: "bug", color: "d73a4a", description: "Something is broken" },
          // The mock completes the seed with GitHub's null description, which the file spells "".
          { name: "docs", color: "0075ca", description: "" },
        ],
      },
      notes: [],
    },
  },
  autolinks: {
    section: autolinksSection,
    live: { autolinks: [{ key_prefix: "JIRA-", url_template: "https://jira.example.com/<num>" }] },
    expected: {
      value: {
        _undeclared: "delete",
        entries: [
          {
            key_prefix: "JIRA-",
            url_template: "https://jira.example.com/<num>",
            is_alphanumeric: true,
          },
        ],
      },
      notes: [],
    },
  },
  actions_secrets: secretsRow(actionsSecretsSection, "actions", "actions_secrets"),
  dependabot_secrets: secretsRow(dependabotSecretsSection, "dependabot", "dependabot_secrets"),
  codespaces_secrets: secretsRow(codespacesSecretsSection, "codespaces", "codespaces_secrets"),
  agents_secrets: secretsRow(agentsSecretsSection, "agents", "agents_secrets"),
  workflows: {
    section: workflowsSection,
    live: {
      workflows: [
        { id: 1, name: "CI", path: ".github/workflows/ci.yml", state: "active" },
        { id: 2, name: "Old", path: ".github/workflows/old.yml", state: "disabled_manually" },
        { id: 3, name: "Gone", path: ".github/workflows/gone.yml", state: "deleted" },
      ],
    },
    expected: {
      value: [
        { path: ".github/workflows/ci.yml", state: "active" },
        { path: ".github/workflows/old.yml", state: "disabled" },
      ],
      notes: [],
    },
  },
  pages: {
    section: pagesSection,
    // The server fields (url, status, html_url, the certificate) fall away.
    live: {
      pages: {
        url: "https://api.github.com/repos/o/r/pages",
        status: "built",
        cname: "docs.example.com",
        custom_404: false,
        html_url: "https://o.github.io/r/",
        build_type: "workflow",
        source: { branch: "main", path: "/" },
        public: true,
        https_certificate: { state: "approved", description: "ok", domains: ["docs.example.com"] },
        https_enforced: true,
        protected_domain_state: null,
        pending_domain_unverified_at: null,
      },
    },
    expected: {
      value: {
        build_type: "workflow",
        source: { branch: "main", path: "/" },
        cname: "docs.example.com",
        https_enforced: true,
        public: true,
      },
      notes: [],
    },
  },
  code_scanning_default_setup: {
    section: codeScanningDefaultSetupSection,
    live: {
      code_scanning: {
        state: "configured",
        languages: ["javascript-typescript"],
        runner_type: "standard",
        runner_label: null,
        query_suite: "default",
        threat_model: "remote",
        updated_at: "2026-07-01T10:00:00Z",
        schedule: null,
      },
    },
    expected: {
      value: {
        state: "configured",
        query_suite: "default",
        languages: ["javascript-typescript"],
        runner_type: "standard",
        runner_label: null,
        threat_model: "remote",
      },
      notes: [],
    },
  },
  code_quality_setup: {
    section: codeQualitySetupSection,
    // The not-configured default: runner_type is null where the slice takes no null, so it is
    // omitted; runner_label is nullable and stays.
    live: {},
    expected: {
      value: { state: "not-configured", languages: [], runner_label: null },
      notes: [],
    },
  },
  milestones: {
    section: milestonesSection,
    live: {
      milestones: [
        { id: 1, number: 1, title: "v1.0", state: "open", description: "First stable release." },
        { id: 2, number: 2, title: "v2.0", state: "closed", description: null },
      ],
    },
    expected: {
      value: {
        _undeclared: "keep",
        entries: [
          { title: "v1.0", description: "First stable release.", state: "open" },
          { title: "v2.0", state: "closed" },
        ],
      },
      notes: [],
    },
  },
  interaction_limits: {
    section: interactionLimitsSection,
    live: {
      interaction_limits: {
        limit: "collaborators_only",
        origin: "repository",
        expires_at: "2027-01-02T00:00:00Z",
      },
      pull_creation_cap: { enabled: true, max_open_pull_requests: 5 },
      pull_bypass_list: [{ login: "octocat" }],
    },
    expected: {
      value: {
        limit: "collaborators_only",
        pull_request_creation_cap: { enabled: true, max_open_pull_requests: 5 },
        pull_request_creation_bypass: ["octocat"],
      },
      notes: [
        "interaction_limits.expiry: GitHub reports only the computed expires_at, so the declared duration cannot be read back; apply re-arms the limit with GitHub's default (one_day) unless you declare expiry",
      ],
    },
  },
  actions_variables: variablesRow(actionsVariablesSection, "actions_variables"),
  agents_variables: variablesRow(agentsVariablesSection, "agents_variables"),
  webhooks: {
    section: webhooksSection,
    live: {
      hooks: [
        {
          id: 601,
          events: ["push", "pull_request"],
          config: {
            url: "https://ci.example.com/hook",
            content_type: "json",
            insecure_ssl: "0",
            secret: "the-live-secret",
          },
        },
        { id: 602, active: false, config: { url: "https://deploy.example.com/hook" } },
      ],
    },
    expected: {
      value: {
        _undeclared: "keep",
        entries: [
          {
            name: "web",
            config: {
              url: "https://ci.example.com/hook",
              content_type: "json",
              insecure_ssl: "0",
              secret: "$WEBHOOK_SECRET_601",
            },
            events: ["push", "pull_request"],
            active: true,
          },
          {
            name: "web",
            config: { url: "https://deploy.example.com/hook" },
            events: ["push"],
            active: false,
          },
        ],
      },
      notes: [
        'webhooks["https://ci.example.com/hook"].config.secret: the webhook secret is not readable; export a value as WEBHOOK_SECRET_601 into the environment before apply',
      ],
    },
  },
  custom_properties: {
    section: customPropertiesSection,
    live: {
      custom_property_values: [
        { property_name: "tier", value: "gold" },
        // A live duplicate option reads back once: the planner compares lists as sets.
        { property_name: "compliance", value: ["soc2", "hipaa", "soc2"] },
        { property_name: "pilot", value: null },
        // An empty list is unset, like null: the planner refuses a declared []. An empty STRING
        // is a value GitHub stores, so it stays.
        { property_name: "team", value: [] },
        { property_name: "owner", value: "" },
      ],
    },
    expected: {
      value: {
        _undeclared: "keep",
        entries: [
          { property_name: "tier", value: "gold" },
          { property_name: "compliance", value: ["soc2", "hipaa"] },
          { property_name: "owner", value: "" },
        ],
      },
      notes: [],
    },
  },
  deploy_keys: {
    section: deployKeysSection,
    live: {
      deploy_keys: [
        { title: "ci-deploy", key: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample deploy@ci" },
        {
          title: "read-write",
          key: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOther",
          read_only: false,
        },
      ],
    },
    expected: {
      value: {
        _undeclared: "keep",
        entries: [
          {
            title: "ci-deploy",
            key: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample",
            read_only: false,
          },
          {
            title: "read-write",
            key: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOther",
            read_only: false,
          },
        ],
      },
      notes: [],
    },
  },
  secret_scanning_custom_patterns: {
    section: secretScanningPatternsSection,
    live: {
      secret_scanning_patterns: [
        {
          id: 1,
          name: "acme-token",
          slug: "acme-token",
          pattern: "acme_[a-z0-9]{32}",
          start_delimiter: "\\A|[^0-9A-Za-z]",
          must_match: ["[a-z]"],
          must_not_match: null,
          state: "published",
          push_protection_enabled: false,
          custom_pattern_version: "v1",
        },
      ],
    },
    expected: {
      value: {
        _undeclared: "keep",
        entries: [
          {
            name: "acme-token",
            pattern: "acme_[a-z0-9]{32}",
            start_delimiter: "\\A|[^0-9A-Za-z]",
            must_match: ["[a-z]"],
          },
        ],
      },
      notes: [],
    },
  },
};

describe("snapshot round trip", () => {
  test("every section declaring snapshot() is enrolled, and no row names a section without one", () => {
    const declaring = SECTIONS.filter((section) => section.snapshot !== undefined).map(
      (section) => section.key,
    );
    expect(Object.keys(ROWS).sort()).toEqual([...declaring].sort());
    for (const [key, row] of Object.entries(ROWS)) {
      expect(row.section.key, `row ${key} names another section`).toBe(key as SectionKey);
    }
  });

  test.each(Object.entries(ROWS))(
    "%s reads its seeded state back as the expected document and plans it as converged",
    async (_key, row) => {
      const api = registryFake(row.live);
      const { snapshot } = await proveSnapshotRoundTrip(row.section, api);
      const read: unknown = { value: snapshot.value, notes: [...snapshot.notes] };
      expect(read).toEqual(row.expected);
    },
  );

  test("a projection that drifts from the write shape fails the proof naming the field", async () => {
    // Negative control: a snapshot claiming a color the live label does not have.
    const drifting: SnapshotSection = {
      ...labelsSection,
      snapshot: async () => ({
        value: { _undeclared: "delete", entries: [{ name: "bug", color: "000000" }] },
        notes: [],
      }),
    };
    const proof = proveSnapshotRoundTrip(drifting, registryFake(ROWS.labels.live));
    await expect(proof).rejects.toThrow(/drifts from the live state/);
    await expect(proof).rejects.toThrow(/labels\[bug\]\.color/);
  });

  test("a snapshot that writes fails the proof before any comparison", async () => {
    const api = registryFake(ROWS.labels.live);
    const writing: SnapshotSection = {
      ...labelsSection,
      snapshot: async () => {
        const read = await labelsSection.snapshot(planContext(labelsSection, api, REPO));
        await api.tryRequest("DELETE", "/repos/o/r/labels/bug");
        return read;
      },
    };
    await expect(proveSnapshotRoundTrip(writing, api)).rejects.toThrow(
      /snapshot\(\) issued a write/,
    );
  });

  test("live duplicates under one identity fail the snapshot, naming the pairs", async () => {
    const keys = registryFake({
      deploy_keys: [
        { title: "ci", key: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOne" },
        { title: "ci", key: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITwo" },
      ],
    });
    await expect(
      deployKeysSection.snapshot(planContext(deployKeysSection, keys, REPO)),
    ).rejects.toThrow(
      'deploy_keys: GitHub holds deploy keys that resolve to one identity: "ci" and "ci". This section manages one deploy key per identity, so the snapshot cannot declare them; delete all but one of each on GitHub, then snapshot again',
    );
    const hooks = registryFake({
      hooks: [
        { id: 1, config: { url: "https://ci.example.com/hook" }, events: ["push"] },
        { id: 2, config: { url: "https://ci.example.com/hook" }, events: ["release"] },
      ],
    });
    await expect(
      webhooksSection.snapshot(planContext(webhooksSection, hooks, REPO)),
    ).rejects.toThrow(
      'webhooks: GitHub holds webhooks that resolve to one identity: "https://ci.example.com/hook (id 1)" and "https://ci.example.com/hook (id 2)". This section manages one webhook per identity, so the snapshot cannot declare them; delete all but one of each on GitHub, then snapshot again',
    );
  });

  test("a secret listed in lowercase reads back under its uppercase key, so the reference grammar holds and the plan converges", async () => {
    const api = registryFake({ actions_secrets: [{ name: "npm_token", ...STAMPS }] });
    const { snapshot } = await proveSnapshotRoundTrip(actionsSecretsSection, api);
    expect(snapshot).toEqual({
      value: {
        _undeclared: "keep",
        entries: [{ name: "NPM_TOKEN", value: "$SECRET_ACTIONS_NPM_TOKEN" }],
      },
      notes: [
        "actions_secrets[NPM_TOKEN]: value of NPM_TOKEN is not readable; export it into the environment as SECRET_ACTIONS_NPM_TOKEN before apply",
      ],
    });
  });

  test("a hook without a config.url is noted and left out; alone, it leaves nothing to declare", async () => {
    const api = registryFake({ hooks: [{ id: 7, config: {} }] });
    const snapshot = await webhooksSection.snapshot(planContext(webhooksSection, api, REPO));
    expect(snapshot).toEqual({
      value: undefined,
      notes: [
        "webhooks[id 7 (no config.url)]: the hook has no config.url, the natural key this section manages by, so it is left out of the snapshot",
      ],
    });
  });

  test("sections without live state read back as nothing to declare", async () => {
    // The mock's defaults: no Pages site, no limit with the cap disabled and nobody bypassing it,
    // no custom property values, every list empty.
    const api = registryFake({});
    for (const key of [
      "labels",
      "autolinks",
      "actions_secrets",
      "workflows",
      "pages",
      "milestones",
      "interaction_limits",
      "actions_variables",
      "webhooks",
      "custom_properties",
      "deploy_keys",
      "secret_scanning_custom_patterns",
    ] as const) {
      const { section } = ROWS[key];
      const snapshot = await section.snapshot(planContext(section, api, REPO));
      expect({ key, ...snapshot }).toEqual({ key, value: undefined, notes: [] });
    }
    expect(api.writes).toEqual([]);
  });
});
