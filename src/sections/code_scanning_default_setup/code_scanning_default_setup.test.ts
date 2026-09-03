/**
 * code_scanning_default_setup section tests: one pinSetupSection() call
 * carrying this section's own lockstep facts; the shared skeleton lives in
 * test/sections/ (code_quality_setup is the declared source mirror).
 */

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
