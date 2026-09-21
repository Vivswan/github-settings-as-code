/**
 * Every section with a snapshot(), enrolled in the round-trip proof over the e2e mock's own
 * handlers: the seeded live state reads back as exactly the expected value and notes, and
 * planning that value against the same state converges. One row file per section under
 * ./snapshot-rows/<key>.ts, loaded by section key off the registry, so a section that gains
 * snapshot() without a row fails by name and a row for a section without one fails too.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { ok } from "neverthrow";
import type { GitHubClient } from "../../src/github/api.js";
import type { SectionKey } from "../../src/schema.js";
import { actionsSecretsSection } from "../../src/sections/actions_secrets/index.js";
import { snapshotContext } from "../../src/sections/contract/plan.js";
import { environmentsSection } from "../../src/sections/environments/index.js";
import { interactionLimitsSection } from "../../src/sections/interaction_limits/index.js";
import { labelsSection } from "../../src/sections/labels/index.js";
import { SECTIONS } from "../../src/sections/registry.js";
import { webhooksSection } from "../../src/sections/webhooks/index.js";
import { registryFake } from "./fragment-fake.js";
import { failureOf, REPO, unwrap } from "./section-run.js";
import { proveSnapshotRoundTrip, type Row, type SnapshotSection } from "./snapshot-roundtrip.js";
import { STAMPS } from "./snapshot-rows/families.js";

const ROWS_DIR = join(import.meta.dir, "snapshot-rows");

/** The row file of one section; a missing file rejects naming the key. */
async function loadRow(key: string): Promise<{ row: Row }> {
  return import(`./snapshot-rows/${key}.ts`) as Promise<{ row: Row }>;
}

describe("snapshot round trip", () => {
  const declaring = SECTIONS.filter((section) => section.snapshot !== undefined).map(
    (section) => section.key,
  );

  test("every row file names a section that declares snapshot()", () => {
    // The other direction (a declaring section without a row file) fails the import below by name.
    const files = readdirSync(ROWS_DIR)
      .filter((file) => file.endsWith(".ts") && file !== "families.ts")
      .map((file) => file.slice(0, -".ts".length));
    expect(files.filter((key) => !declaring.includes(key as SectionKey))).toEqual([]);
  });

  test.each(declaring)(
    "%s reads its seeded state back as the expected document and plans it as converged",
    async (key) => {
      const { row } = await loadRow(key);
      expect(row.section.key, `the ${key} row names another section`).toBe(key);
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
      snapshot: async () =>
        ok({
          value: { _undeclared: "delete", entries: [{ name: "bug", color: "000000" }] },
          notes: [],
        }),
    };
    const proof = proveSnapshotRoundTrip(
      drifting,
      registryFake((await loadRow("labels")).row.live),
    );
    await expect(proof).rejects.toThrow(/drifts from the live state/);
    await expect(proof).rejects.toThrow(/labels\[bug\]\.color/);
  });

  test("a snapshot that writes fails the proof before any comparison", async () => {
    const api = registryFake((await loadRow("labels")).row.live);
    const writing: SnapshotSection = {
      ...labelsSection,
      snapshot: async () => {
        const read = unwrap(
          await labelsSection.snapshot(snapshotContext(labelsSection, api, REPO, "fail")),
        );
        await api.tryRequest("DELETE", "/repos/o/r/labels/bug");
        return ok(read);
      },
    };
    await expect(proveSnapshotRoundTrip(writing, api)).rejects.toThrow(
      /snapshot\(\) issued a write/,
    );
  });

  test("a service hook on a managed hook's url is left out with a note, not read as a duplicate", async () => {
    const mixed = registryFake({
      hooks: [
        { id: 1, config: { url: "https://ci.example.com/hook" } },
        { id: 2, name: "slack", config: { url: "https://ci.example.com/hook" } },
      ],
    });
    const read = unwrap(
      await webhooksSection.snapshot(snapshotContext(webhooksSection, mixed, REPO, "fail")),
    );
    expect(read.notes).toEqual([
      'webhooks[https://ci.example.com/hook]: left out of the snapshot - a "slack" service hook is not a web hook this section manages',
    ]);
    expect(read.value).toMatchObject({
      entries: [{ config: { url: "https://ci.example.com/hook" } }],
    });
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

  test("a deployment branch policy without a name fails the environments snapshot as a malformed response, not as a duplicate", async () => {
    // Two nameless rows would otherwise collide under the literal identity "undefined"; plan and snapshot classify the input the same way.
    const nested = registryFake({
      environments: {
        prod: {
          name: "prod",
          protection_rules: [],
          deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
        },
      },
      environment_branch_policies: { prod: [{ id: 1 }, { id: 2 }] },
    });
    expect(
      failureOf(
        await environmentsSection.snapshot(
          snapshotContext(environmentsSection, nested, REPO, "fail"),
        ),
      ).message,
    ).toContain(
      'environments: the deployment branch-policy list for environment "prod" returned a policy without a name, so it cannot be reconciled',
    );
  });

  test.each([
    [
      { enabled: "yes", max_open_pull_requests: 1 },
      "enabled: Invalid input: expected boolean, received string",
    ],
    [
      { enabled: true },
      "max_open_pull_requests: Invalid input: expected number, received undefined",
    ],
    [null, "(body): Invalid input: expected object, received null"],
  ])(
    "a creation-cap body off the shape (%j) fails the snapshot instead of reading as no cap",
    async (body, issue) => {
      const fake = registryFake({});
      const api: GitHubClient = {
        tryRequest: (method, path, payload, options) =>
          method === "GET" && path === "/repos/o/r/interaction-limits/pulls/creation-cap"
            ? Promise.resolve({ data: body })
            : fake.tryRequest(method, path, payload, options),
        tryGraphql: (op, variables, slug) => fake.tryGraphql(op, variables, slug),
      };
      expect(
        failureOf(
          await interactionLimitsSection.snapshot(
            snapshotContext(interactionLimitsSection, api, REPO, "fail"),
          ),
        ).message,
      ).toContain(
        "interaction_limits: GET /repos/{owner}/{repo}/interaction-limits/pulls/creation-cap " +
          `(reading the pull request creation cap) returned a body outside the documented shape - ${issue}. ` +
          'Check the "api-version" input against the GitHub REST docs for this endpoint',
      );
    },
  );

  test("a hook whose config.secret is not a string fails the snapshot instead of minting a reference", async () => {
    const fake = registryFake({});
    const api: GitHubClient = {
      tryRequest: (method, path, payload, options) =>
        method === "GET" && path.startsWith("/repos/o/r/hooks?")
          ? Promise.resolve({
              data: [
                { id: 7, name: "web", config: { url: "https://ci.example.com/hook", secret: 123 } },
              ],
            })
          : fake.tryRequest(method, path, payload, options),
      tryGraphql: (op, variables, slug) => fake.tryGraphql(op, variables, slug),
    };
    expect(
      failureOf(await webhooksSection.snapshot(snapshotContext(webhooksSection, api, REPO, "fail")))
        .message,
    ).toContain(
      "webhooks: GET /repos/{owner}/{repo}/hooks returned a body outside the documented shape - " +
        "[0].config.secret: Invalid input: expected string, received number. Check the " +
        '"api-version" input against the GitHub REST docs for this endpoint',
    );
  });

  test("a hook without a config.url is noted and left out; alone, it leaves nothing to declare", async () => {
    const api = registryFake({ hooks: [{ id: 7, config: {} }] });
    const snapshot = unwrap(
      await webhooksSection.snapshot(snapshotContext(webhooksSection, api, REPO, "fail")),
    );
    expect(snapshot).toEqual({
      value: undefined,
      notes: [
        "webhooks[id 7 (no config.url)]: left out of the snapshot - the hook has no config.url, the natural key this section manages by",
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
      const { section } = (await loadRow(key)).row;
      const snapshot = unwrap(await section.snapshot(snapshotContext(section, api, REPO, "fail")));
      expect({ key, ...snapshot }).toEqual({ key, value: undefined, notes: [] });
    }
    expect(api.writes).toEqual([]);
  });
});
