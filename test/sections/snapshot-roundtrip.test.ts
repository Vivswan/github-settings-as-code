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
import type { GithubClient } from "../../src/github/api.js";
import type { SectionKey } from "../../src/schema.js";
import { actionsSecretsSection } from "../../src/sections/actions_secrets/index.js";
import { planContext } from "../../src/sections/contract/plan.js";
import { deployKeysSection } from "../../src/sections/deploy_keys/index.js";
import { interactionLimitsSection } from "../../src/sections/interaction_limits/index.js";
import { labelsSection } from "../../src/sections/labels/index.js";
import { milestonesSection } from "../../src/sections/milestones/index.js";
import { SECTIONS } from "../../src/sections/registry.js";
import { webhooksSection } from "../../src/sections/webhooks/index.js";
import { registryFake } from "./fragment-fake.js";
import { REPO } from "./section-run.js";
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
      snapshot: async () => ({
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
      'deploy_keys: GitHub holds deploy keys that resolve to one identity: "ci" and "ci". ' +
        "This section manages one deploy key per identity, so the snapshot cannot declare them; " +
        "delete all but one of each on GitHub, then snapshot again",
    );
    const hooks = registryFake({
      hooks: [
        { id: 1, config: { url: "https://ci.example.com/hook" }, events: ["push"] },
        { id: 2, config: { url: "https://ci.example.com/hook" }, events: ["release"] },
      ],
    });
    // A service hook on the same url counts too: the planner matches against every live hook.
    const mixed = registryFake({
      hooks: [
        { id: 1, config: { url: "https://ci.example.com/hook" } },
        { id: 2, name: "slack", config: { url: "https://ci.example.com/hook" } },
      ],
    });
    await expect(
      webhooksSection.snapshot(planContext(webhooksSection, mixed, REPO)),
    ).rejects.toThrow(/webhooks: GitHub holds webhooks that resolve to one identity/);
    await expect(
      webhooksSection.snapshot(planContext(webhooksSection, hooks, REPO)),
    ).rejects.toThrow(
      "webhooks: GitHub holds webhooks that resolve to one identity: " +
        '"https://ci.example.com/hook (id 1)" and "https://ci.example.com/hook (id 2)". ' +
        "This section manages one webhook per identity, so the snapshot cannot declare them; " +
        "delete all but one of each on GitHub, then snapshot again",
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

  test("two live milestones under one title fail the snapshot, naming both", async () => {
    const api = registryFake({
      milestones: [
        { id: 1, number: 1, title: "v1", state: "open" },
        { id: 2, number: 2, title: "v1", state: "closed" },
      ],
    });
    await expect(
      milestonesSection.snapshot(planContext(milestonesSection, api, REPO)),
    ).rejects.toThrow(
      'milestones: GitHub holds milestones that resolve to one identity: "v1 (number 1)" and ' +
        '"v1 (number 2)". This section manages one milestone per identity, so the snapshot ' +
        "cannot declare them; delete all but one of each on GitHub, then snapshot again",
    );
  });

  test.each([
    [{ enabled: "yes" }, "enabled: Invalid input: expected boolean, received string"],
    [null, "(body): Invalid input: expected object, received null"],
  ])(
    "a creation-cap body off the shape (%j) fails the snapshot instead of reading as no cap",
    async (body, issue) => {
      const fake = registryFake({});
      const api: GithubClient = {
        tryRequest: (method, path, payload, options) =>
          method === "GET" && path === "/repos/o/r/interaction-limits/pulls/creation-cap"
            ? Promise.resolve({ data: body })
            : fake.tryRequest(method, path, payload, options),
        tryGraphql: (op, variables, slug) => fake.tryGraphql(op, variables, slug),
      };
      await expect(
        interactionLimitsSection.snapshot(planContext(interactionLimitsSection, api, REPO)),
      ).rejects.toThrow(
        "interaction_limits: GET /repos/{owner}/{repo}/interaction-limits/pulls/creation-cap " +
          `returned a body outside the documented shape - ${issue}. Check the "api-version" ` +
          "input against the GitHub REST docs for this endpoint",
      );
    },
  );

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
      const { section } = (await loadRow(key)).row;
      const snapshot = await section.snapshot(planContext(section, api, REPO));
      expect({ key, ...snapshot }).toEqual({ key, value: undefined, notes: [] });
    }
    expect(api.writes).toEqual([]);
  });
});
