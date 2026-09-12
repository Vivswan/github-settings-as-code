/**
 * The row shapes the factory-minted families share: one seed and one expected document per family,
 * parametrized on the facts the families differ in.
 */

import type { LiveState } from "../../e2e/mock/state.js";
import type { Row, SnapshotSection } from "../snapshot-roundtrip.js";

export const STAMPS = { created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" };

/**
 * One secret family's row: the names read back as per-store references (so the same name in two
 * stores never shares a variable), one note each; a reserved-looking name needs no escape.
 */
export function secretsRow(section: SnapshotSection, store: string, family: keyof LiveState): Row {
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
export function variablesRow(section: SnapshotSection, family: keyof LiveState): Row {
  return {
    section,
    live: { [family]: [{ name: "REGION", value: "eu-west-1", ...STAMPS }] },
    expected: {
      value: { _undeclared: "delete", entries: [{ name: "REGION", value: "eu-west-1" }] },
      notes: [],
    },
  };
}
