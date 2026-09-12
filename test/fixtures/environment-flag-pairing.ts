/**
 * The flag-pairing invariant is implemented TWICE (the zod superRefine and the JSON Schema if/then, both in src/sections/environments/schema.ts);
 * these fixtures are the one set both are tested against, and an agreement test asserts the verdicts match per fixture.
 */

export interface FlagPairingFixture {
  /** What the fixture demonstrates, used in test failure messages. */
  name: string;
  /** One environments[] entry, wrapped by each consumer as its input needs. */
  entry: Record<string, unknown>;
  /** Whether BOTH validators must accept the entry. */
  valid: boolean;
}

/** Exported so tests asserting on the refinement's error wording (which embeds the name) derive it instead of restating "prod". */
export const FIXTURE_ENV_NAME = "prod";

export const FLAG_PAIRING_FIXTURES: readonly FlagPairingFixture[] = [
  {
    name: "patterns without the sibling flag object",
    entry: { name: FIXTURE_ENV_NAME, deployment_branch_policies: [{ name: "release/*" }] },
    valid: false,
  },
  {
    name: "patterns with the flag present but false",
    entry: {
      name: FIXTURE_ENV_NAME,
      deployment_branch_policy: { protected_branches: true, custom_branch_policies: false },
      deployment_branch_policies: [{ name: "release/*" }],
    },
    valid: false,
  },
  {
    name: "patterns with the sibling nulled (a clear)",
    entry: {
      name: FIXTURE_ENV_NAME,
      deployment_branch_policy: null,
      deployment_branch_policies: [{ name: "release/*" }],
    },
    valid: false,
  },
  {
    name: "the wrapped form takes the same rule",
    entry: {
      name: FIXTURE_ENV_NAME,
      deployment_branch_policies: { entries: [{ name: "release/*" }] },
    },
    valid: false,
  },
  {
    name: "the paired form (flag true) passes",
    entry: {
      name: FIXTURE_ENV_NAME,
      deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
      deployment_branch_policies: [{ name: "release/*" }, { name: "v*", type: "tag" }],
    },
    valid: true,
  },
  {
    name: "the wrapped paired form passes",
    entry: {
      name: FIXTURE_ENV_NAME,
      deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
      deployment_branch_policies: { _undeclared: "keep", entries: [{ name: "main" }] },
    },
    valid: true,
  },
  {
    name: "an entry without the plural key keeps its freedom (nullable flag)",
    entry: { name: FIXTURE_ENV_NAME, deployment_branch_policy: null },
    valid: true,
  },
];
