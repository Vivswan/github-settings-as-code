/**
 * The row shapes the factory-minted families share: one seed and one expected document per family,
 * parametrized on the facts the families differ in. test/engine/snapshot.test.ts reads rows through
 * loadRow() as well, so a family row needs no directory file.
 */

import type { SectionKey } from "../../src/schema.js";
import { actionsSecretsSection } from "../../src/sections/actions_secrets/index.js";
import { actionsVariablesSection } from "../../src/sections/actions_variables/index.js";
import { agentsSecretsSection } from "../../src/sections/agents_secrets/index.js";
import { agentsVariablesSection } from "../../src/sections/agents_variables/index.js";
import { codespacesSecretsSection } from "../../src/sections/codespaces_secrets/index.js";
import { dependabotSecretsSection } from "../../src/sections/dependabot_secrets/index.js";
import type { LiveState } from "../e2e/mock/state.js";
import type { Row, SnapshotSection } from "./snapshot-roundtrip.js";

export const STAMPS = { created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" };

/**
 * One secret family's row: two names, each read back as its own per-store reference (so the same
 * name in two stores never shares a variable), one note each.
 */
function secretsRow(section: SnapshotSection, store: string, family: keyof LiveState): Row {
  const STORE = store.toUpperCase();
  return {
    section,
    live: {
      [family]: [
        { name: "DEPLOY_TOKEN", ...STAMPS },
        { name: "RELEASE_PAT", ...STAMPS },
      ],
    },
    expected: {
      value: {
        _undeclared: "keep",
        entries: [
          { name: "DEPLOY_TOKEN", value: `$SECRET_${STORE}_DEPLOY_TOKEN` },
          { name: "RELEASE_PAT", value: `$SECRET_${STORE}_RELEASE_PAT` },
        ],
      },
      notes: [
        `${section.key}[DEPLOY_TOKEN]: value of DEPLOY_TOKEN is not readable; ` +
          `export it into the environment as SECRET_${STORE}_DEPLOY_TOKEN before apply`,
        `${section.key}[RELEASE_PAT]: value of RELEASE_PAT is not readable; ` +
          `export it into the environment as SECRET_${STORE}_RELEASE_PAT before apply`,
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

type FamilyRowKey = Extract<SectionKey, `${string}_secrets` | `${string}_variables`>;

export const FAMILY_ROWS: Readonly<Record<FamilyRowKey, Row>> = {
  actions_secrets: secretsRow(actionsSecretsSection, "actions", "actions_secrets"),
  dependabot_secrets: secretsRow(dependabotSecretsSection, "dependabot", "dependabot_secrets"),
  codespaces_secrets: secretsRow(codespacesSecretsSection, "codespaces", "codespaces_secrets"),
  agents_secrets: secretsRow(agentsSecretsSection, "agents", "agents_secrets"),
  actions_variables: variablesRow(actionsVariablesSection, "actions_variables"),
  agents_variables: variablesRow(agentsVariablesSection, "agents_variables"),
};

export async function loadRow(key: SectionKey): Promise<{ row: Row }> {
  const sparse: Partial<Record<SectionKey, Row>> = FAMILY_ROWS;
  const row = sparse[key];
  return row ? { row } : (import(`./${key}/snapshot-row.ts`) as Promise<{ row: Row }>);
}
