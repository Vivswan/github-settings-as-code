/**
 * The standard scenario set, over SECTIONS: each section ships the e2e scenarios its contract implies,
 * under one naming rule, so a section cannot register without its convergence proof, a reading section
 * not without its drift and read-back proofs, and a policy section not without both undeclared
 * postures. The corpus loader pins that a file's `name` is its stem (test/e2e/foundation.test.ts).
 *
 *   <slug>-apply-converges       every section; an apply run (inputs.mode unset or apply) declaring expect.fixpoint, or it
 *                                proves nothing about the second run
 *   <slug>-check-drift           a section with a planning read (a write-only section has no drift to show)
 *   <slug>-snapshot-roundtrip    a section with snapshot()
 *   <slug>-undeclared-delete     a section under the undeclared policy
 *   <slug>-undeclared-keep-note  a section under the undeclared policy
 *
 * where <slug> is the section key with "_" spelled "-", the corpus's file-name alphabet.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { INPUT_DECLS } from "../../src/flows/inputs.js";
import { UNDECLARED_POLICY_SECTIONS } from "../../src/schema.js";
import { planningReads, type SectionModule } from "../../src/sections/contract/module.js";
import { SECTIONS } from "../../src/sections/registry.js";
import { parseScenario } from "../e2e/schema.js";
import { ROOT } from "../root.js";
import { withTempDir } from "../temp-dir.js";

const POLICY_SECTIONS: ReadonlySet<string> = new Set(UNDECLARED_POLICY_SECTIONS);

function slugOf(section: SectionModule): string {
  return section.key.replaceAll("_", "-");
}

/** The scenario stems a section's contract demands. */
function standardSet(section: SectionModule): string[] {
  const slug = slugOf(section);
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

/**
 * What keeps the section's apply-converges scenario from proving an apply re-run, through the corpus's own
 * parser; empty is a proof. The mode defaults to the action's own, so an unset inputs.mode is an apply run.
 */
function convergenceDefects(section: SectionModule, dir: string): string[] {
  const file = `${slugOf(section)}-apply-converges.yml`;
  const path = join(dir, file);
  const scenario = parseScenario(parseYaml(readFileSync(path, "utf8")), path);
  const mode = scenario.inputs?.mode ?? INPUT_DECLS.mode.default;
  return [
    ...(mode === "apply"
      ? []
      : [`${file} runs inputs.mode: ${mode}, so its fixpoint re-runs no apply`]),
    ...(scenario.expect.fixpoint === undefined ? [`${file} declares no expect.fixpoint`] : []),
  ];
}

/** The control section: labels reads, snapshots, and carries the knob, so every class of the set is demanded. */
function labelsSection(): SectionModule {
  const labels = SECTIONS.find((section) => section.key === "labels");
  if (labels === undefined) {
    throw new Error("the labels section is registered");
  }
  return labels;
}

describe("the standard scenario set", () => {
  test.each(SECTIONS.map((section) => [section.key, section] as const))(
    "%s ships every scenario its contract implies, and its convergence proof declares the re-run",
    (key, section) => {
      const dir = join(ROOT, "test", "sections", key, "scenarios");
      expect(missingScenarios(section, dir), `missing under ${dir}`).toEqual([]);
      expect(convergenceDefects(section, dir)).toEqual([]);
    },
  );

  test("the negative control: a directory lacking one file of the set fails naming that stem", () =>
    withTempDir("scenario-set-", (dir) => {
      const labels = labelsSection();
      const set = standardSet(labels);
      // The control for the derivation itself: every class is demanded.
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

  test("the negative control: a check-mode file declaring a fixpoint fails naming the file and inputs.mode", () =>
    withTempDir("scenario-set-", (dir) => {
      const labels = labelsSection();
      const scenario = (inputs: string, fixpoint: string): string =>
        `name: labels-apply-converges\nsettings: {}\n${inputs}expect:\n  exit_code: 0\n${fixpoint}`;
      const path = join(dir, "labels-apply-converges.yml");
      // The schema admits this file: a check run twice against unchanged state, proving no apply converges.
      writeFileSync(path, scenario("inputs:\n  mode: check\n", "  fixpoint: converges\n"));
      expect(convergenceDefects(labels, dir)).toEqual([
        "labels-apply-converges.yml runs inputs.mode: check, so its fixpoint re-runs no apply",
      ]);
      writeFileSync(path, scenario("", ""));
      expect(convergenceDefects(labels, dir)).toEqual([
        "labels-apply-converges.yml declares no expect.fixpoint",
      ]);
      // The positive control: an unset mode is the action's default, apply.
      writeFileSync(path, scenario("", "  fixpoint: converges\n"));
      expect(convergenceDefects(labels, dir)).toEqual([]);
    }));
});
