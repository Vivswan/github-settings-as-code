/**
 * code_scanning_default_setup section tests: one pinSetupSection() call
 * carrying this section's own lockstep facts; the shared skeleton lives in
 * test/sections/ (code_quality_setup is the declared source mirror).
 */

import { expect, test } from "bun:test";
import { planContext } from "../../../src/sections/contract/plan.js";
import { MockApi } from "../../../test/mock-api.js";
import { REPO } from "../../../test/sections/plan-idempotence.js";
import { pinSetupSection } from "../../../test/sections/setup-section.js";
import { codeScanningDefaultSetupSection } from "./index.js";

pinSetupSection({
  section: codeScanningDefaultSetupSection,
  path: "/repos/o/r/code-scanning/default-setup",
  live: {
    state: "configured",
    query_suite: "default",
    languages: ["javascript-typescript", "python"],
  },
  driftDeclared: { state: "configured", query_suite: "extended" },
  driftLine: 'code_scanning_default_setup.query_suite: "extended" != "default"',
  applyPayload: { state: "configured", query_suite: "extended" },
  changeLine: "applied code scanning default setup",
  denied403: /Advanced Security/,
});

test("code_scanning_default_setup: the read port cannot reach the PATCH or the raw client", () => {
  // Compile-time only, over this section's literal endpoints - the shared
  // skeleton's erased module type cannot spell these.
  const ctx = planContext(codeScanningDefaultSetupSection, new MockApi({}), REPO);
  expect(Object.keys(ctx.read)).toEqual(["get"]);
  // @ts-expect-error a write role is not a read: the port has no `update`
  ctx.read.update;
  // @ts-expect-error nor the raw client
  ctx.api;
  // @ts-expect-error a "denied" primary read offers no 404-tolerant helper
  ctx.read.get.probeAbsent;
});
