/**
 * code_quality_setup section tests: one pinSetupSection() call carrying this
 * section's own lockstep facts; the shared skeleton lives in test/sections/
 * (code_scanning_default_setup is the declared source mirror).
 */

import { expect, test } from "bun:test";
import { planContext } from "../../../src/sections/contract/plan.js";
import { MockApi } from "../../../test/mock-api.js";
import { REPO } from "../../../test/sections/plan-idempotence.js";
import { pinSetupSection } from "../../../test/sections/setup-section.js";
import { codeQualitySetupSection } from "./index.js";

pinSetupSection({
  section: codeQualitySetupSection,
  path: "/repos/o/r/code-quality/setup",
  live: {
    state: "configured",
    languages: ["javascript-typescript", "python"],
    runner_type: "standard",
  },
  driftDeclared: { state: "configured", ai_findings_option: "on_push" },
  driftLine:
    'code_quality_setup.ai_findings_option: declared "on_push" but the API response has no such field (new or write-only field?)',
  applyPayload: { state: "configured", ai_findings_option: "disabled" },
  changeLine: "applied code quality setup",
  denied403: /code quality is unavailable/,
});

test("code_quality_setup: the read port cannot reach the PATCH or the raw client", () => {
  // Compile-time only, over this section's literal endpoints - the shared
  // skeleton's erased module type cannot spell these.
  const ctx = planContext(codeQualitySetupSection, new MockApi({}), REPO);
  expect(Object.keys(ctx.read)).toEqual(["get"]);
  // @ts-expect-error a write role is not a read: the port has no `update`
  ctx.read.update;
  // @ts-expect-error nor the raw client
  ctx.api;
  // @ts-expect-error a "denied" primary read offers no 404-tolerant helper
  ctx.read.get.probeAbsent;
});
