/**
 * Hand-written permission prose in permissions.md and check-mode.md, pinned
 * to the section modules' `permission` declarations and endpoint overrides
 * (the generated regions are covered by test/scripts/gen-action-docs.test.ts).
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { overrideAdviceLevel } from "../../src/sections/contract/errors.js";
import { sectionOperations } from "../../src/sections/contract/module.js";
import { RESOURCE_LABEL, type SectionPermission } from "../../src/sections/contract/permissions.js";
import { DOCS } from "../../src/sections/docs-registry.js";
import { allEndpoints, SECTIONS, sectionModule } from "../../src/sections/registry.js";

const ROOT = join(import.meta.dir, "..", "..");
// Flattened for matching: the pages wrap sentences across lines.
const permissions = readFileSync(join(ROOT, "docs", "reference", "permissions.md"), "utf8").replace(
  /\s+/g,
  " ",
);
const checkMode = readFileSync(join(ROOT, "docs", "operate", "check-mode.md"), "utf8").replace(
  /\s+/g,
  " ",
);

/** The token-UI labels of a section permission's Repository resources. */
function repoLabels(permission: SectionPermission): string[] {
  return permission.repo.map((resource) => RESOURCE_LABEL[resource]);
}

describe("write-gated section reads", () => {
  test("the check-mode guide names every section whose reads GitHub gates at write, and only those", () => {
    // The guide must name exactly the sections whose every read (REST or
    // GraphQL, via sectionOperations) carries the accessGrade write override;
    // permissions.md renders the same claim from a generated region.
    const gated = SECTIONS.filter((section) => {
      const readGrades = sectionOperations(section)
        .filter((operation) => operation.wire === "read")
        .map((operation) => operation.grade);
      return readGrades.length > 0 && readGrades.every((grade) => grade === "write");
    });
    expect(gated.length).toBeGreaterThan(0);
    for (const section of gated) {
      const resource = repoLabels(section.permission).join(" or ");
      const phrase = `gates even the ${resource} reads at write`;
      // The key must sit in the SAME clause as the gating phrase (split on
      // the ./;/:/!/? class claims.ts windows bound on), or unrelated prose
      // naming the key elsewhere on the page would satisfy the check.
      const gatingClause = checkMode
        .split(/(?<=[.;:!?])\s+/)
        .find((clause) => clause.includes(phrase));
      expect(gatingClause, `docs/operate/check-mode.md must say GitHub "${phrase}"`).toBeDefined();
      expect(
        gatingClause?.includes(`\`${section.key}\``),
        `docs/operate/check-mode.md's write-gated-reads clause must name \`${section.key}\`, got: ${gatingClause}`,
      ).toBe(true);
    }
    // The claim is exceptional by nature: a "reads at write" sentence about
    // a section whose GETs are NOT write-gated would be wrong the same way.
    const gatedKeys = new Set(gated.map((section) => section.key as string));
    for (const section of SECTIONS) {
      if (gatedKeys.has(section.key)) {
        continue;
      }
      const resource = repoLabels(section.permission).join(" or ");
      expect(
        checkMode.includes(`gates even the ${resource} reads at write`),
        `docs/operate/check-mode.md claims "${resource}" reads are write-gated, but no "${section.key}" GET carries the accessGrade override`,
      ).toBe(false);
    }
  });
});

describe("branches Contents advice", () => {
  test("the branches Notes cell and permissions.md advise the branch probe's override grant", () => {
    // The advisory branch-existence probe carries a Contents permission
    // override (src/sections/branches/index.ts), advised at the level the section
    // needs on that permission - the source both prose mentions restate. The
    // README row renders from the section's authored docs, pinned here at
    // their source.
    const probe = allEndpoints()["branches.branchProbe"];
    const override = probe?.permission;
    expect(override !== undefined && override !== "none").toBe(true);
    const label = repoLabels(override as SectionPermission).join(" or ");
    const level = overrideAdviceLevel(sectionModule("branches"), override as SectionPermission);
    const advice = `${label}: ${level}`;
    const notes = DOCS.branches.readme.notes;
    expect(
      notes.includes(`add ${advice}`),
      `the branches Notes cell (src/sections/branches/docs.ts) must advise "add ${advice}" for the probe`,
    ).toBe(true);
    expect(notes).toContain("missing branch");
    // permissions.md restates the same advice as the Contents grant's second
    // job; the grant name, the section, and what the probe buys must match.
    expect(permissions).toContain(`The ${label} grant earns its keep twice`);
    expect(permissions).toContain(
      "it also lets `branches` tell a missing branch from an unprotected one in check mode",
    );
  });
});
