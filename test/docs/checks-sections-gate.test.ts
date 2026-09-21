/**
 * The checks.yml e2e-smoke job compares the selector's printed token as a raw shell string, so its literals are pinned to the constants the selector
 * prints.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ALL, NONE } from "../../.github/scripts/changed-sections.js";
import { ROOT } from "../root.js";

describe("checks.yml e2e-smoke section-selection sentinels", () => {
  const workflow = readFileSync(join(ROOT, ".github", "workflows", "checks.yml"), "utf8");

  test.each<[string, string]>([
    [
      "the smoke job is gated on the selector NOT printing the none token",
      `steps.select.outputs.sections != '${NONE}'`,
    ],
    [
      "the full-corpus branch compares against the all token",
      `if [ "$SECTIONS" = "${ALL}" ]; then`,
    ],
    ["non-PR events fall back to the all token (no base to diff against)", `SECTIONS="${ALL}"`],
  ])("%s", (_case, literal) => {
    expect(workflow).toContain(literal);
  });
});
