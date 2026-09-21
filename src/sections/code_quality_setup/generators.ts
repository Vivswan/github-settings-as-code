/**
 * The code_quality_setup fuzz generator fragment, aggregated by test/e2e/generators.ts.
 */

import type { Json } from "../../../test/e2e/gen-support.js";
import type { Rng } from "../../../test/e2e/prng.js";
import { CODE_QUALITY_LANGUAGES } from "./schema.js";

export function genCodeQuality(rng: Rng): Json {
  const cfg: Json = { state: rng.pick(["configured", "not-configured"]) };
  if (rng.bool(0.3)) {
    cfg.runner_type = rng.pick(["standard", "labeled"] as const);
    if (cfg.runner_type === "labeled") {
      cfg.runner_label = "e2e-runner";
    }
  }
  if (rng.bool(0.5)) {
    cfg.languages = Array.from({ length: rng.int(3) + 1 }, () =>
      rng.pick(CODE_QUALITY_LANGUAGES.declarable),
    );
  }
  if (rng.bool(0.3)) {
    cfg.ai_findings_option = rng.pick(["disabled", "on_push"]);
  }
  return cfg;
}
