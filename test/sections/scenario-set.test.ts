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
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { UNDECLARED_POLICY_SECTIONS } from "../../src/schema.js";
import { planningReads, type SectionModule } from "../../src/sections/contract/module.js";
import { SECTIONS } from "../../src/sections/registry.js";
import { ROOT } from "../root.js";
import { withTempDir } from "../temp-dir.js";

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

/** The stems of the set `dir` lacks, so the failure names the files to write. */
function missingScenarios(section: SectionModule, dir: string): string[] {
  return standardSet(section).filter((stem) => !existsSync(join(dir, `${stem}.yml`)));
}

describe("the standard scenario set", () => {
  test.each(SECTIONS.map((section) => [section.key, section] as const))(
    "%s ships every scenario its contract implies",
    (key, section) => {
      const dir = join(ROOT, "src", "sections", key, "scenarios");
      expect(missingScenarios(section, dir), `missing under ${dir}`).toEqual([]);
    },
  );

  test("the set is derived from the contract: a write-only section (no planning read, no snapshot) demands the convergence proof alone", () => {
    const writeOnly = SECTIONS.filter(
      (section) => planningReads(section).length === 0 && section.snapshot === undefined,
    );
    // At least one such section exists, or the branch below is never exercised.
    expect(writeOnly.length).toBeGreaterThan(0);
    for (const section of writeOnly) {
      expect(standardSet(section)).toEqual([`${section.key.replaceAll("_", "-")}-apply-converges`]);
    }
  });

  test("the negative control: a directory lacking one file of the set fails naming that stem", () =>
    withTempDir("scenario-set-", (dir) => {
      const labels = SECTIONS.find((section) => section.key === "labels");
      if (labels === undefined) {
        throw new Error("the labels section is registered");
      }
      const set = standardSet(labels);
      // The control for the derivation itself: labels reads, snapshots, and carries the knob, so every class is demanded.
      expect(set).toEqual([
        "labels-apply-converges",
        "labels-check-drift",
        "labels-snapshot-roundtrip",
        "labels-undeclared-delete",
        "labels-undeclared-keep-note",
      ]);
      for (const stem of set) {
        if (stem !== "labels-undeclared-keep-note") {
          writeFileSync(join(dir, `${stem}.yml`), `name: ${stem}\n`);
        }
      }
      expect(missingScenarios(labels, dir)).toEqual(["labels-undeclared-keep-note"]);
      // A file under the old name does not satisfy the set.
      writeFileSync(join(dir, "labels-undeclared-keep.yml"), "name: labels-undeclared-keep\n");
      expect(missingScenarios(labels, dir)).toEqual(["labels-undeclared-keep-note"]);
    }));
});
