/**
 * Diff-aware section selector for the PR e2e smoke job. Given the files a PR
 * changed, decide which settings sections the smoke job must exercise, so a PR
 * touching one section runs that section's scenarios and fuzz rather than the
 * whole corpus, and a docs-only PR skips the smoke job entirely.
 *
 * The mapping is EXPLICIT, not inferred, and it recognizes both section
 * layouts during the per-section directory migration: the flat
 * src/sections/<file>.ts files map through SECTIONS_BY_FILE (path-based, so
 * a deleted flat file still resolves), and a src/sections/<key>/... directory
 * (the key spelled verbatim) selects that key for every file under it.
 * Shared code fans out to its consumers (SHARED_FAN_OUT, covering both the
 * flat and the shared/ spelling), and the cross-cutting files (the contract,
 * the registry, the engine, the schema, the e2e harness) select every
 * section. A path under src/sections/ that none of the rules recognize
 * throws, so a new file cannot silently skip the smoke job.
 *
 * Usage (CI): `bun .github/scripts/changed-sections.ts [base-ref]` prints one
 * of: a comma-separated section list, the literal `all`, or the literal
 * `none`. The base ref defaults to `origin/main`. The smoke job runs when the
 * output is not `none`.
 */

import { execFileSync } from "node:child_process";
import { SECTION_KEYS, type SectionKey, UNDECLARED_POLICY_SECTIONS } from "../../src/schema.js";

/** The sentinel the CLI prints (and the job branches on) when every section is in play. */
export const ALL = "all";
/** The sentinel printed when nothing settings-related changed. */
export const NONE = "none";

/**
 * Section files whose name does NOT equal their key. Every other
 * src/sections/<key>.ts maps to <key>; the SECTIONS_BY_FILE builder fills
 * those in from SECTION_KEYS. Entries OUTLIVE the files they name: the maps
 * are path-based, so a migration diff that deletes a kebab file (moving the
 * section into src/sections/<key>/) still resolves the deleted path to its
 * section. The whole map retires in one sweep after the last section moves.
 */
export const SPECIAL_SECTION_FILES: Record<string, SectionKey[]> = {
  // Kebab file names for underscore section keys.
  "actions-secrets.ts": ["actions_secrets"],
  "dependabot-secrets.ts": ["dependabot_secrets"],
  "codespaces-secrets.ts": ["codespaces_secrets"],
  "agents-secrets.ts": ["agents_secrets"],
  // The file is code-scanning.ts but the section key is the longer form.
  "code-scanning.ts": ["code_scanning_default_setup"],
  // The file is code-quality.ts but the section key is the longer form.
  "code-quality.ts": ["code_quality_setup"],
  // Kebab file name for the underscore section key, like code-scanning.ts.
  "check-suite-preferences.ts": ["check_suite_preferences"],
  // Kebab file name for the underscore section key, like code-scanning.ts.
  "interaction-limits.ts": ["interaction_limits"],
  // Kebab file name for the underscore section key, like code-scanning.ts.
  "actions-variables.ts": ["actions_variables"],
  // Kebab file name for the underscore section key, like code-scanning.ts.
  "agents-variables.ts": ["agents_variables"],
  // Kebab file name for the underscore section key, like code-scanning.ts.
  "custom-properties.ts": ["custom_properties"],
  // Kebab file name for the underscore section key.
  "deploy-keys.ts": ["deploy_keys"],
  // Kebab file name for the longer underscore section key.
  "secret-scanning-patterns.ts": ["secret_scanning_custom_patterns"],
};

/**
 * Shared section code and the key(s) each file fans out to, by basename.
 * Consulted for BOTH spellings - the flat src/sections/<file> of today and
 * the src/sections/shared/<file> the migration moves it to - so each fan-out
 * is declared exactly once and survives the move. A shared/ file with no
 * entry throws in sectionsForFiles, forcing a fan-out declaration.
 */
export const SHARED_FAN_OUT: Record<string, SectionKey[]> = {
  // roles.ts is the shared permission-vocabulary normalizer for both sections.
  "roles.ts": ["collaborators", "teams"],
  // secrets-engine.ts is the shared sealing/reconciliation engine, consumed
  // by the four repository-level secret sections and by environments (its
  // nested per-environment secrets key).
  "secrets-engine.ts": [
    "actions_secrets",
    "dependabot_secrets",
    "codespaces_secrets",
    "agents_secrets",
    "environments",
  ],
  // repo-secrets.ts is the section factory over the engine: the four
  // repository-level secret families are each one call into it.
  "repo-secrets.ts": [
    "actions_secrets",
    "dependabot_secrets",
    "codespaces_secrets",
    "agents_secrets",
  ],
  // variables-engine.ts is the shared value-based reconciliation engine,
  // consumed by the two repository-level variable sections and by
  // environments (its nested per-environment variables key).
  "variables-engine.ts": ["actions_variables", "agents_variables", "environments"],
  // repo-variables.ts is the section factory over the variables engine: the
  // two repository-level variable families are each one call into it.
  "repo-variables.ts": ["actions_variables", "agents_variables"],
  // schema-helpers.ts holds the leaf zod helpers the per-section schema
  // files and root schema.ts share: knobbed() shapes the wrapped
  // {undeclared, entries} form of every UNDECLARED_POLICY_SECTIONS value
  // (and environments' nested lists), and the sealed-secret doc strings feed
  // the secret families' configs - all inside that same set. Derived from
  // the schema's own list so the fan-out cannot go stale against it.
  "schema-helpers.ts": [...UNDECLARED_POLICY_SECTIONS, "environments"],
};

/**
 * Section files that select EVERY section because they are cross-cutting: the
 * section contract and the registry that wires all handlers together.
 */
const ALL_SELECTING_SECTION_FILES = new Set(["contract.ts", "registry.ts"]);

/** The section keys, as a Set of plain strings for path-segment lookups. */
const SECTION_KEY_SET: ReadonlySet<string> = new Set(SECTION_KEYS);

/**
 * src/sections/<file> -> the section key(s) a change to it can affect.
 * Path-based, never disk-based: <key>.ts maps to [key] whether or not the
 * file exists, so a diff that DELETES a flat file (a section moving into its
 * directory, or a batch reported as delete-plus-add when git's rename
 * heuristic misses) resolves to the same key its replacement selects instead
 * of throwing. Duplicate names across the three sources would let one entry
 * silently shadow another, so the merge asserts uniqueness loudly.
 */
export function buildSectionsByFile(): Record<string, SectionKey[]> {
  const map: Record<string, SectionKey[]> = {};
  const duplicates: string[] = [];
  const sources = [
    Object.entries(SPECIAL_SECTION_FILES),
    Object.entries(SHARED_FAN_OUT),
    SECTION_KEYS.map((key): [string, SectionKey[]] => [`${key}.ts`, [key]]),
  ];
  for (const source of sources) {
    for (const [file, keys] of source) {
      if (file in map) {
        duplicates.push(file);
      }
      map[file] = keys;
    }
  }
  if (duplicates.length > 0) {
    throw new Error(
      `changed-sections: file(s) mapped more than once across SPECIAL_SECTION_FILES, SHARED_FAN_OUT, and the <key>.ts entries: [${duplicates.sort().join(", ")}]`,
    );
  }
  return map;
}

const SECTIONS_BY_FILE = buildSectionsByFile();

/**
 * Path prefixes/files that select every section: the shared engine, transport,
 * action layer, discovery, reporting, the io seam, the entrypoint and schema,
 * and the e2e harness itself (a harness change can change every scenario).
 * `lib/` is deliberately NOT here: the only committed file under it is the
 * generated settings.schema.json, which carries no runnable code and mirrors
 * a `src/schema.ts` change when one exists; the schema-check job gates schema
 * drift on its own. A unit test checks every top-level `src/` entry other
 * than `sections/` is listed, so a new top-level module cannot be silently
 * skipped.
 */
export const ALL_SELECTING_PREFIXES = [
  // The contract barrel's layered modules: every section is written
  // against them, so a change there selects everything, like the barrel.
  "src/sections/contract/",
  "src/engine/",
  "src/github/",
  "src/action/",
  "src/discovery/",
  "src/report/",
  // Cross-cutting: gap files define supplemental route typing across sections.
  "src/upstream-gaps/",
  "src/io.ts",
  "src/main.ts",
  "src/schema.ts",
  "src/types.ts",
  "test/e2e/",
  // The selection machinery itself: a PR touching only this selector, a
  // sibling CI script, or the smoke job's own workflow would otherwise
  // select "none" and skip the very job it configures.
  ".github/scripts/",
  ".github/workflows/checks.yml",
];

/** The decision for one changed-file set: every section, some, or none. */
export type Selection =
  | { kind: "all" }
  | { kind: "some"; sections: SectionKey[] }
  | { kind: "none" };

/**
 * Resolve one src/sections/ path (below the ALL_SELECTING_PREFIXES check, so
 * src/sections/contract/ never reaches here) to the sections it selects, in
 * either layout:
 * - a flat file maps through ALL_SELECTING_SECTION_FILES or SECTIONS_BY_FILE
 *   (which covers deleted files too - the maps are path-based);
 * - src/sections/<key>/... (the section key spelled verbatim) selects <key>,
 *   whatever the file under it is - module, mock, schema, test, or scenario;
 * - src/sections/shared/<file> fans out through SHARED_FAN_OUT.
 * Anything else throws: a silently ignored section path would let a PR skip
 * the very scenarios its change needs, so an unrecognized file must either
 * get a mapping or move under a recognized directory.
 */
function sectionsForSectionsPath(file: string): SectionKey[] | "all" {
  const rest = file.slice("src/sections/".length);
  const slash = rest.indexOf("/");
  if (slash < 0) {
    if (ALL_SELECTING_SECTION_FILES.has(rest)) {
      return "all";
    }
    const keys = SECTIONS_BY_FILE[rest];
    if (keys) {
      return keys;
    }
    throw new Error(
      `changed-sections: ${file} matches no selector rule; map it in SPECIAL_SECTION_FILES or SHARED_FAN_OUT, name it <key>.ts, or move it under a section directory`,
    );
  }
  const dir = rest.slice(0, slash);
  if (SECTION_KEY_SET.has(dir)) {
    return [dir as SectionKey];
  }
  if (dir === "shared") {
    const keys = SHARED_FAN_OUT[rest.slice(slash + 1)];
    if (keys) {
      return keys;
    }
    throw new Error(
      `changed-sections: ${file} matches no selector rule; declare its consumers in SHARED_FAN_OUT`,
    );
  }
  throw new Error(
    `changed-sections: ${file} matches no selector rule; a section directory must spell its SectionKey verbatim (or add the directory to ALL_SELECTING_PREFIXES if it is cross-cutting)`,
  );
}

/**
 * Map a set of changed file paths (repo-relative, forward slashes) to the
 * sections the smoke job must run. Any cross-cutting path forces "all"; section
 * files contribute their key(s) through sectionsForSectionsPath, which throws
 * on an unrecognized src/sections/ path; files that touch nothing
 * settings-related are ignored, so a purely docs/config PR yields "none".
 * `lib/` contributes no section either - the only committed file under it is
 * the generated settings.schema.json, which the schema-check job gates on its
 * own - so a lib-only diff selects "none".
 */
export function sectionsForFiles(files: readonly string[]): Selection {
  const selected = new Set<SectionKey>();
  for (const file of files) {
    if (ALL_SELECTING_PREFIXES.some((prefix) => file.startsWith(prefix))) {
      return { kind: "all" };
    }
    if (!file.startsWith("src/sections/")) {
      // Everything else (README, COVERAGE, lib/, workflows, package.json,
      // tests outside e2e) contributes no section.
      continue;
    }
    const keys = sectionsForSectionsPath(file);
    if (keys === "all") {
      return { kind: "all" };
    }
    for (const key of keys) {
      selected.add(key);
    }
  }
  if (selected.size === 0) {
    return { kind: "none" };
  }
  // Emit in SECTION_KEYS order for a stable, readable list.
  return { kind: "some", sections: SECTION_KEYS.filter((key) => selected.has(key)) };
}

/** Render a Selection as the single token the CLI prints and the job branches on. */
export function renderSelection(selection: Selection): string {
  if (selection.kind === "all") {
    return ALL;
  }
  if (selection.kind === "none") {
    return NONE;
  }
  return selection.sections.join(",");
}

/** The files changed between `baseRef` and HEAD, per `git diff --name-only`. */
export function changedFiles(baseRef: string): string[] {
  const out = execFileSync("git", ["diff", "--name-only", `${baseRef}...HEAD`], {
    encoding: "utf8",
  });
  return out
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

// CLI: print the selection token for the given base ref (default origin/main).
// Kept side-effect-free on import (the unit test imports the pure functions
// above) by gating on import.meta.main.
if (import.meta.main) {
  const baseRef = process.argv[2] ?? "origin/main";
  const selection = sectionsForFiles(changedFiles(baseRef));
  console.log(renderSelection(selection));
}
