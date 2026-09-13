/**
 * The standard scenario set, over SECTIONS: each section ships the e2e scenarios its contract implies,
 * under one naming rule, so a section cannot register without its convergence proof, a reading section
 * not without its drift and read-back proofs, and a policy section not without both undeclared
 * postures. The corpus loader pins that a file's `name` is its stem (test/e2e/foundation.test.ts); this
 * file pins that the stems exist.
 *
 *   <slug>-apply-converges       every section
 *   <slug>-check-drift           a section with a planning read (a write-only section has no drift to show)
 *   <slug>-snapshot-roundtrip    a section with snapshot()
 *   <slug>-undeclared-delete     a section under the undeclared policy
 *   <slug>-undeclared-keep-note  a section under the undeclared policy
 *
 * where <slug> is the section key with "_" spelled "-", the corpus's file-name alphabet.
 */

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { UNDECLARED_POLICY_SECTIONS } from "../../src/schema.js";
import { planningReads, type SectionModule } from "../../src/sections/contract/module.js";
import { SECTIONS } from "../../src/sections/registry.js";
import { ROOT } from "../root.js";

const POLICY_SECTIONS: ReadonlySet<string> = new Set(UNDECLARED_POLICY_SECTIONS);

/** The scenario stems a section's contract demands. */
function standardSet(section: SectionModule): string[] {
  const slug = section.key.replaceAll("_", "-");
  return [
    `${slug}-apply-converges`,
    ...(planningReads(section).length > 0 ? [`${slug}-check-drift`] : []),
    ...(section.snapshot === undefined ? [] : [`${slug}-snapshot-roundtrip`]),
    ...(POLICY_SECTIONS.has(section.key)
      ? [`${slug}-undeclared-delete`, `${slug}-undeclared-keep-note`]
      : []),
  ];
}

describe("the standard scenario set", () => {
  test.each(SECTIONS.map((section) => [section.key, section] as const))(
    "%s ships every scenario its contract implies",
    (key, section) => {
      const dir = join(ROOT, "src", "sections", key, "scenarios");
      const missing = standardSet(section).filter((stem) => !existsSync(join(dir, `${stem}.yml`)));
      expect(missing, `missing under ${dir}`).toEqual([]);
    },
  );

  test("the set is derived from the contract, so the write-only section demands no drift or read-back scenario", () => {
    const writeOnly = SECTIONS.filter((section) => planningReads(section).length === 0);
    expect(writeOnly.map((section) => section.key)).toEqual(["check_suite_preferences"]);
    for (const section of writeOnly) {
      expect(standardSet(section)).toEqual([`${section.key.replaceAll("_", "-")}-apply-converges`]);
    }
  });
});
