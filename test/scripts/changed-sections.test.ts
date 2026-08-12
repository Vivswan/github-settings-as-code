/**
 * Unit test for the diff-aware section selector: the golden fan-out map,
 * that every path on disk resolves through some rule, and the cross-cutting,
 * docs-only, and fail-loud branches - including the tripwire that a flat
 * src/sections/ file (registry.ts is the only one allowed) throws instead of
 * silently skipping the smoke job.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import {
  ALL_SELECTING_PREFIXES,
  renderSelection,
  SHARED_FAN_OUT,
  sectionsForFiles,
} from "../../.github/scripts/changed-sections.js";
import { SECTION_KEYS, type SectionKey, UNDECLARED_POLICY_SECTIONS } from "../../src/schema.js";

const SRC_DIR = join(import.meta.dir, "..", "..", "src");
const SECTIONS_DIR = join(SRC_DIR, "sections");

/** Every path under src/sections on disk, repo-relative with forward slashes. */
function sectionsPathsOnDisk(dir = SECTIONS_DIR, prefix = "src/sections"): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      out.push(...sectionsPathsOnDisk(join(dir, entry.name), path));
    } else if (entry.isFile()) {
      out.push(path);
    }
  }
  return out;
}

describe("changed-sections file map", () => {
  test("every mapped key is a real SECTION_KEYS member", () => {
    const known = new Set<string>(SECTION_KEYS);
    for (const [file, keys] of Object.entries(SHARED_FAN_OUT)) {
      for (const key of keys) {
        expect(known.has(key), `${file} maps to unknown section key "${key}"`).toBe(true);
      }
    }
  });

  test("every path on disk under src/sections resolves through some selector rule", () => {
    // sectionsForFiles throws on an unrecognized src/sections/ path, so a
    // stray helper file must either get a mapping or move under a recognized
    // directory - resolving every real path proves nothing on disk is in that
    // state.
    for (const path of sectionsPathsOnDisk()) {
      expect(() => sectionsForFiles([path]), `${path} does not resolve`).not.toThrow();
    }
  });

  test("every shared file maps to exactly its declared keys", () => {
    // A literal golden copy of the shared fan-outs: changing one is a
    // two-place edit on purpose, so a dropped or reworded fan-out cannot
    // slip through.
    const golden: Record<string, SectionKey[]> = {
      "roles.ts": ["collaborators", "teams"],
      "secrets-engine.ts": [
        "actions_secrets",
        "dependabot_secrets",
        "codespaces_secrets",
        "agents_secrets",
        "environments",
      ],
      "repo-secrets.ts": [
        "actions_secrets",
        "dependabot_secrets",
        "codespaces_secrets",
        "agents_secrets",
      ],
      "variables-engine.ts": ["actions_variables", "agents_variables", "environments"],
      "repo-variables.ts": ["actions_variables", "agents_variables"],
      // Derived on purpose, matching the selector's own expression: the
      // helpers shape every knobbed section's wrapped form plus
      // environments' nested lists, so hand-copying the keys here would
      // just let both lists go stale together.
      "schema-helpers.ts": [...UNDECLARED_POLICY_SECTIONS, "environments"],
    };
    expect(SHARED_FAN_OUT).toEqual(golden);
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

  test("a section directory selects its key for every file under it", () => {
    // The post-migration layout: src/sections/<key>/... spells the key
    // verbatim, and everything under it - module, mock, test, scenario -
    // selects exactly that section. Path-based, so the rule holds before any
    // directory exists on disk.
    expect(renderSelection(sectionsForFiles(["src/sections/labels/index.ts"]))).toBe("labels");
    expect(renderSelection(sectionsForFiles(["src/sections/labels/mock.ts"]))).toBe("labels");
    expect(
      renderSelection(
        sectionsForFiles(["src/sections/environments/scenarios/environments-apply.yml"]),
      ),
    ).toBe("environments");
    expect(
      renderSelection(sectionsForFiles(["src/sections/secret_scanning_custom_patterns/schema.ts"])),
    ).toBe("secret_scanning_custom_patterns");
  });

  test("shared files fan out to their consumers", () => {
    expect(renderSelection(sectionsForFiles(["src/sections/shared/roles.ts"]))).toBe(
      "collaborators,teams",
    );
    expect(renderSelection(sectionsForFiles(["src/sections/shared/secrets-engine.ts"]))).toBe(
      "environments,actions_secrets,dependabot_secrets,codespaces_secrets,agents_secrets",
    );
  });

  test("an unrecognized src/sections path throws instead of silently selecting nothing", () => {
    expect(() => sectionsForFiles(["src/sections/stray-helper.ts"])).toThrow(
      /matches no selector rule/,
    );
    expect(() => sectionsForFiles(["src/sections/not_a_key/index.ts"])).toThrow(
      /matches no selector rule/,
    );
    expect(() => sectionsForFiles(["src/sections/shared/unmapped.ts"])).toThrow(
      /matches no selector rule/,
    );
  });

  test("a flat src/sections file besides registry.ts throws", () => {
    // Sections are directories; registry.ts is the only flat file the layout
    // allows. A diff naming any other flat path (whatever its history) must
    // fail loudly, never resolve quietly.
    for (const stale of [
      "src/sections/labels.ts",
      "src/sections/deploy-keys.ts",
      "src/sections/code-scanning.ts",
      "src/sections/roles.ts",
      "src/sections/secrets-engine.ts",
      "src/sections/contract.ts",
    ]) {
      expect(() => sectionsForFiles([stale]), `${stale} must throw`).toThrow(
        /matches no selector rule/,
      );
    }
    // A cross-cutting path in the same diff must not mask the stale path:
    // the selector resolves every src/sections/ path before answering "all".
    expect(() => sectionsForFiles(["src/schema.ts", "src/sections/labels.ts"])).toThrow(
      /matches no selector rule/,
    );
  });

  test("multiple section directories union in SECTION_KEYS order", () => {
    const selection = sectionsForFiles([
      "src/sections/milestones/index.ts",
      "src/sections/labels/index.ts",
    ]);
    // labels precedes milestones in SECTION_KEYS, so the list is ordered.
    expect(renderSelection(selection)).toBe("labels,milestones");
  });

  test("registry.ts selects all", () => {
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
    const selection = sectionsForFiles([
      "src/sections/labels/index.ts",
      "lib/settings.schema.json",
    ]);
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
    const selection = sectionsForFiles(["src/sections/labels/index.ts", "src/engine/diff.ts"]);
    expect(selection.kind).toBe("all");
  });
});

test("a contract-module-only diff selects every section", () => {
  // The barrel split moved the cross-cutting code into src/sections/contract/;
  // a change there must select "all" exactly like the barrel, or a
  // contract-module PR would skip the e2e smoke entirely.
  expect(sectionsForFiles(["src/sections/contract/requests.ts"])).toEqual({ kind: "all" });
});
