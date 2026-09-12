/**
 * The checks.yml e2e-smoke job compares the selector's printed token as a raw shell string, so its literals are pinned to the constants the selector
 * prints.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ALL, NONE } from "../../.github/scripts/changed-sections.js";

const ROOT = join(import.meta.dir, "..", "..");

describe("checks.yml e2e-smoke section-selection sentinels", () => {
  const workflow = readFileSync(join(ROOT, ".github", "workflows", "checks.yml"), "utf8");

  test("the smoke job is gated on the selector NOT printing the none token", () => {
    expect(workflow).toContain(`steps.select.outputs.sections != '${NONE}'`);
  });

  test("the full-corpus branch compares against the all token", () => {
    expect(workflow).toContain(`if [ "$SECTIONS" = "${ALL}" ]; then`);
  });

  test("non-PR events fall back to the all token (no base to diff against)", () => {
    expect(workflow).toContain(`SECTIONS="${ALL}"`);
  });
});
