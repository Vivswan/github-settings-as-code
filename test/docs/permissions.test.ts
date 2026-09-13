// The generated regions (permissions.md, check-mode.md) are covered by gen-action-docs.test.ts.

import { describe, expect, test } from "bun:test";
import { overrideAdviceLevel } from "../../src/sections/contract/errors.js";
import { RESOURCE_LABEL, type SectionPermission } from "../../src/sections/contract/permissions.js";
import { DOCS } from "../../src/sections/docs-registry.js";
import { allEndpoints, sectionModule } from "../../src/sections/registry.js";

/** The token-UI labels of a section permission's Repository resources. */
function repoLabels(permission: SectionPermission): string[] {
  return permission.repo.map((resource) => RESOURCE_LABEL[resource]);
}

describe("branches Contents advice", () => {
  test("the branches Notes cell advises the branch probe's override grant", () => {
    // The advisory branch-existence probe carries a Contents override (src/sections/branches/endpoints.ts); the Notes cell restates that source.
    const probe = allEndpoints()["branches.branchProbe"];
    const override = probe?.permission;
    expect(override !== undefined && override !== "none").toBe(true);
    const label = repoLabels(override as SectionPermission).join(" or ");
    const level = overrideAdviceLevel(sectionModule("branches"), override as SectionPermission);
    const advice = `${label}: ${level}`;
    const notes = DOCS.branches.sections_table.notes;
    expect(
      notes.includes(`add ${advice}`),
      `the branches Notes cell (src/sections/branches/branches.docs.yml) must advise "add ${advice}" for the probe`,
    ).toBe(true);
  });
});
