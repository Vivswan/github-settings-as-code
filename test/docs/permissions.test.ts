/**
 * Token-permissions prose pins: docs/reference/permissions.md (and the
 * check-mode page, which shares the codespaces caveat) restate grants the
 * section modules declare in `permission`, `grantCaveat`, and per-endpoint
 * overrides. Each claim here is derived from those declarations, so the
 * prose cannot drift from what a denial actually asks for.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { overrideAdviceLevel } from "../../src/sections/contract/errors.js";
import { sectionOperations } from "../../src/sections/contract/module.js";
import { grantFor, type SectionPermission } from "../../src/sections/contract/permissions.js";
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

/**
 * The Repository-permission labels of a section permission, read off the
 * grant prose grantFor renders (RESOURCE_LABEL itself stays private to the
 * contract module, so the public rendering is the derivation surface).
 */
function repoLabels(permission: SectionPermission): string[] {
  // The name capture is a quoted-label chain ("A" or "B"), never a free
  // .+? - on the teams grant a lazy dot would swallow the Organization
  // clause and misread the label list.
  const clause = grantFor(permission).match(
    /"([^"]+(?:" or "[^"]+)*)" \((?:read and write|read)\) under (?:the PAT's|its) Repository permissions/,
  );
  return (clause?.[1] ?? "").split('" or "').filter((label) => label.length > 0);
}

describe("permissions.md manage-everything grant list", () => {
  test("the write list covers every section and names no resource no section declares", () => {
    // The capture is bounded to the sentence ([^.]) so a reworded page
    // cannot silently match a later " at write" and mis-attribute the
    // failure; a missing sentence fails here by name.
    const sentence = permissions.match(/To manage everything in one PAT, grant ([^.]+?) at write/);
    expect(
      sentence,
      'permissions.md lost its "To manage everything in one PAT, grant ... at write" sentence',
    ).not.toBeNull();
    const listed = (sentence?.[1] ?? "")
      .split(/, (?:and )?/)
      .map((label) => label.trim())
      .filter((label) => label.length > 0);
    expect(listed.length, "the manage-everything sentence names no grants").toBeGreaterThan(0);
    // Coverage: every section must be satisfiable from the listed set (a
    // multi-resource permission like code scanning's needs ANY one of its
    // resources listed, not all).
    for (const section of SECTIONS) {
      const labels = repoLabels(section.permission);
      expect(labels.length).toBeGreaterThan(0);
      expect(
        labels.some((label) => listed.includes(label)),
        `the manage-everything list grants none of [${labels.join(", ")}], so the "${section.key}" section is not covered`,
      ).toBe(true);
    }
    // No stale extras: everything listed must be a resource some section
    // declares.
    const union = new Set(SECTIONS.flatMap((section) => repoLabels(section.permission)));
    for (const label of listed) {
      expect(
        union.has(label),
        `the manage-everything list grants "${label}", which no section's permission declares`,
      ).toBe(true);
    }
    // The two cross-cutting reads: Contents (also the branches probe's
    // override) and the teams org grant, each at the level the code needs.
    const branches = sectionModule("branches");
    const probe = allEndpoints()["branches.branchProbe"];
    const contents = probe?.permission;
    expect(contents !== undefined && contents !== "none").toBe(true);
    const contentsLabel = repoLabels(contents as SectionPermission).join(" or ");
    const contentsLevel = overrideAdviceLevel(branches, contents as SectionPermission);
    expect(permissions).toContain(`plus ${contentsLabel} at ${contentsLevel}`);
    const orgLabel = grantFor(sectionModule("teams").permission).match(
      /"([^"]+)" \(read\) under the PAT's Organization permissions/,
    )?.[1];
    expect(orgLabel).toBeDefined();
    expect(permissions).toContain(`the ${orgLabel} organization permission at read`);
  });
});

describe("write-gated section reads", () => {
  test("both pages name every section whose reads GitHub gates at write, and only those", () => {
    // The accessGrade override on the codespaces GETs is the code-side model
    // (pinned in test/sections/registry.test.ts); the docs sentences must
    // name exactly the sections whose every read - REST or GraphQL, via
    // sectionOperations - GitHub gates at write.
    const gated = SECTIONS.filter((section) => {
      const readGrades = sectionOperations(section)
        .filter((operation) => operation.wire === "read")
        .map((operation) => operation.grade);
      return readGrades.length > 0 && readGrades.every((grade) => grade === "write");
    });
    expect(gated.length).toBeGreaterThan(0);
    for (const [label, page] of [
      ["docs/reference/permissions.md", permissions],
      ["docs/operate/check-mode.md", checkMode],
    ] as const) {
      for (const section of gated) {
        const resource = repoLabels(section.permission).join(" or ");
        const phrase = `gates even the ${resource} reads at write`;
        // The section key must sit in the SAME clause as the gating phrase -
        // anywhere-on-the-page matching would let the sentence name a
        // different section while the right key appears in unrelated prose.
        // Clauses split on the delimiter class ./;/:/!/? (the one claims.ts
        // windows bound on), so a "!" or ";" cannot smuggle in an adjacent
        // clause's key.
        const gatingClause = page
          .split(/(?<=[.;:!?])\s+/)
          .find((clause) => clause.includes(phrase));
        expect(gatingClause, `${label} must say GitHub "${phrase}"`).toBeDefined();
        expect(
          gatingClause?.includes(`\`${section.key}\``),
          `${label}'s write-gated-reads clause must name \`${section.key}\`, got: ${gatingClause}`,
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
          page.includes(`gates even the ${resource} reads at write`),
          `${label} claims "${resource}" reads are write-gated, but no "${section.key}" GET carries the accessGrade override`,
        ).toBe(false);
      }
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
