/**
 * code_quality_setup section tests: one pinSetupSection() call carrying this
 * section's own lockstep facts; the shared skeleton lives in test/sections/
 * (code_scanning_default_setup is the declared source mirror).
 */

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
