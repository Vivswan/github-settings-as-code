/**
 * Unit test for the diff-aware section selector. Pins the file-to-section map
 * against SECTION_KEYS so a new section forces a map entry, and checks the
 * cross-cutting and docs-only branches select "all" and "none" respectively.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import {
  ALL_SELECTING_PREFIXES,
  buildSectionsByFile,
  renderSelection,
  SPECIAL_SECTION_FILES,
  sectionsForFiles,
} from "../../.github/scripts/changed-sections.js";
import { SECTION_KEYS, type SectionKey } from "../../src/schema.js";

const SRC_DIR = join(import.meta.dir, "..", "..", "src");
const SECTIONS_DIR = join(SRC_DIR, "sections");

describe("changed-sections file map", () => {
  const byFile = buildSectionsByFile();

  test("every section key is reachable from some section file", () => {
    const reachable = new Set(Object.values(byFile).flat());
    for (const key of SECTION_KEYS) {
      expect(reachable.has(key), `no section file maps to key "${key}"`).toBe(true);
    }
  });

  test("every mapped key is a real SECTION_KEYS member", () => {
    const known = new Set<string>(SECTION_KEYS);
    for (const [file, keys] of Object.entries(byFile)) {
      for (const key of keys) {
        expect(known.has(key), `${file} maps to unknown section key "${key}"`).toBe(true);
      }
    }
  });

  test("every mapped file exists in src/sections", () => {
    // Both directions with the on-disk files below: a renamed or deleted
    // section handler must break this test rather than silently mis-select.
    const onDisk = new Set(readdirSync(SECTIONS_DIR));
    for (const file of Object.keys(byFile)) {
      expect(onDisk.has(file), `map names "${file}", which does not exist in src/sections`).toBe(
        true,
      );
    }
  });

  test("every section handler file on disk is mapped", () => {
    // contract.ts and registry.ts are cross-cutting (they force "all", not a
    // per-file mapping) and roles.ts is a shared helper mapped explicitly; every
    // OTHER .ts in src/sections is a section handler and must be in the map.
    const crossCutting = new Set(["contract.ts", "registry.ts"]);
    const mapped = new Set(Object.keys(byFile));
    for (const file of readdirSync(SECTIONS_DIR)) {
      if (!file.endsWith(".ts") || crossCutting.has(file)) {
        continue;
      }
      expect(
        mapped.has(file),
        `src/sections/${file} exists but the changed-sections map does not name it`,
      ).toBe(true);
    }
  });

  test("every special-named file maps to exactly its declared keys", () => {
    // A literal golden copy of the special mappings: changing one is a
    // two-place edit on purpose, so a dropped or reworded fan-out cannot
    // slip through. The reachability and on-disk tests above police the
    // declaration in the other direction.
    const golden: Record<string, SectionKey[]> = {
      "actions-secrets.ts": ["actions_secrets"],
      "dependabot-secrets.ts": ["dependabot_secrets"],
      "codespaces-secrets.ts": ["codespaces_secrets"],
      "agents-secrets.ts": ["agents_secrets"],
      "code-scanning.ts": ["code_scanning_default_setup"],
      "code-quality.ts": ["code_quality_setup"],
      "check-suite-preferences.ts": ["check_suite_preferences"],
      "interaction-limits.ts": ["interaction_limits"],
      "actions-variables.ts": ["actions_variables"],
      "agents-variables.ts": ["agents_variables"],
      "custom-properties.ts": ["custom_properties"],
      "deploy-keys.ts": ["deploy_keys"],
      "secret-scanning-patterns.ts": ["secret_scanning_custom_patterns"],
      "roles.ts": ["collaborators", "teams"],
      "secrets-engine.ts": [
        "actions_secrets",
        "dependabot_secrets",
        "codespaces_secrets",
        "agents_secrets",
        "environments",
      ],
    };
    expect(Object.keys(SPECIAL_SECTION_FILES).sort()).toEqual(Object.keys(golden).sort());
    for (const [file, keys] of Object.entries(golden)) {
      expect(byFile[file], `special file ${file} lost its mapping`).toEqual(keys);
    }
  });

  test("each 1:1 section file maps to exactly its own key", () => {
    // A key has a <key>.ts entry exactly when that file exists on disk; a
    // kebab-named handler reaches its key through SPECIAL_SECTION_FILES only.
    const onDisk = new Set(readdirSync(SECTIONS_DIR));
    for (const key of SECTION_KEYS) {
      if (onDisk.has(`${key}.ts`)) {
        expect(byFile[`${key}.ts`]).toEqual([key]);
      } else {
        expect(byFile[`${key}.ts`]).toBeUndefined();
      }
    }
  });

  test("every top-level src entry is either sections/ or all-selecting", () => {
    // A new top-level src module the selector does not know about would make
    // PRs touching only it skip the smoke job; force a prefix entry instead.
    // Only directories and .ts files count: stray artifacts like .DS_Store
    // are not selector inputs.
    for (const entry of readdirSync(SRC_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory() && !entry.name.endsWith(".ts")) {
        continue;
      }
      const path = entry.isDirectory() ? `src/${entry.name}/` : `src/${entry.name}`;
      if (path === "src/sections/") {
        continue;
      }
      expect(
        ALL_SELECTING_PREFIXES.includes(path),
        `${path} is not in ALL_SELECTING_PREFIXES, so the selector would ignore changes to it`,
      ).toBe(true);
    }
  });
});

describe("changed-sections selection", () => {
  test("a docs-only change selects none", () => {
    const selection = sectionsForFiles(["README.md", "COVERAGE.md", ".github/workflows/ci.yml"]);
    expect(selection.kind).toBe("none");
    expect(renderSelection(selection)).toBe("none");
  });

  test("the selection machinery selects all: a selector-only or checks.yml-only PR must not skip the smoke job", () => {
    expect(sectionsForFiles([".github/scripts/changed-sections.ts"]).kind).toBe("all");
    expect(sectionsForFiles([".github/workflows/checks.yml"]).kind).toBe("all");
  });

  test("a single section file selects just that section", () => {
    const selection = sectionsForFiles(["src/sections/labels.ts"]);
    expect(renderSelection(selection)).toBe("labels");
  });

  test("code-scanning.ts selects the long key", () => {
    expect(renderSelection(sectionsForFiles(["src/sections/code-scanning.ts"]))).toBe(
      "code_scanning_default_setup",
    );
  });

  test("roles.ts fans out to collaborators and teams, in SECTION_KEYS order", () => {
    expect(renderSelection(sectionsForFiles(["src/sections/roles.ts"]))).toBe(
      "collaborators,teams",
    );
  });

  test("secrets-engine.ts fans out to all five consuming sections", () => {
    expect(renderSelection(sectionsForFiles(["src/sections/secrets-engine.ts"]))).toBe(
      "environments,actions_secrets,dependabot_secrets,codespaces_secrets,agents_secrets",
    );
  });

  test("multiple section files union in SECTION_KEYS order", () => {
    const selection = sectionsForFiles(["src/sections/milestones.ts", "src/sections/labels.ts"]);
    // labels precedes milestones in SECTION_KEYS, so the list is ordered.
    expect(renderSelection(selection)).toBe("labels,milestones");
  });

  test("contract.ts and registry.ts each select all", () => {
    expect(sectionsForFiles(["src/sections/contract.ts"]).kind).toBe("all");
    expect(sectionsForFiles(["src/sections/registry.ts"]).kind).toBe("all");
    expect(renderSelection(sectionsForFiles(["src/sections/registry.ts"]))).toBe("all");
  });

  test("core paths select all", () => {
    for (const file of [
      "src/engine/orchestrate.ts",
      "src/github/api.ts",
      "src/action/inputs.ts",
      "src/discovery/discover.ts",
      "src/report/issue-report.ts",
      "src/io.ts",
      "src/main.ts",
      "src/schema.ts",
      "test/e2e/runner.ts",
    ]) {
      expect(sectionsForFiles([file]).kind, `${file} should select all`).toBe("all");
    }
  });

  test("a section change plus a regenerated schema scopes to the section, not all", () => {
    // lib/settings.schema.json regenerates alongside schema-affecting src
    // changes; the lib file must not force "all" or diff-awareness is dead.
    const selection = sectionsForFiles(["src/sections/labels.ts", "lib/settings.schema.json"]);
    expect(renderSelection(selection)).toBe("labels");
  });

  test("a lib-only diff selects none (the schema-check job gates schema drift)", () => {
    // The only committed file under lib/ is the generated schema, which
    // carries no runnable code; the smoke job has nothing to exercise.
    expect(sectionsForFiles(["lib/settings.schema.json"]).kind).toBe("none");
  });

  test("lib alongside a docs-only change selects none", () => {
    expect(sectionsForFiles(["README.md", "lib/settings.schema.json"]).kind).toBe("none");
  });

  test("a core-path change wins over a section change", () => {
    // Any all-selecting path forces all, regardless of other changed files.
    const selection = sectionsForFiles(["src/sections/labels.ts", "src/engine/diff.ts"]);
    expect(selection.kind).toBe("all");
  });
});

test("a contract-module-only diff selects every section", () => {
  // The barrel split moved the cross-cutting code into src/sections/contract/;
  // a change there must select "all" exactly like the barrel, or a
  // contract-module PR would skip the e2e smoke entirely.
  expect(sectionsForFiles(["src/sections/contract/requests.ts"])).toEqual({ kind: "all" });
});
