/**
 * The code_quality_setup section's fuzz generator fragment, aggregated by
 * test/e2e/generators.ts. Imports only the test-tree leaf seams
 * (gen-support.ts, prng.ts) - the src -> test inversion is deliberate; the
 * bundle entry is src/main.ts, so this file never reaches lib/index.js.
 */

import type { Json } from "../../../test/e2e/gen-support.js";
import type { Rng } from "../../../test/e2e/prng.js";

/** The languages the code-quality PATCH accepts (a subset of the GET enum). */
const CODE_QUALITY_LANGUAGES = [
  "csharp",
  "go",
  "java-kotlin",
  "javascript-typescript",
  "python",
  "ruby",
] as const;

export function genCodeQuality(rng: Rng): Json {
  const cfg: Json = { state: rng.pick(["configured", "not-configured"]) };
  if (rng.bool(0.3)) {
    cfg.runner_type = rng.pick(["standard", "labeled"] as const);
    if (cfg.runner_type === "labeled") {
      // runner_label pairs with the labeled runner type (schema.ts).
      cfg.runner_label = "e2e-runner";
    }
  }
  if (rng.bool(0.5)) {
    cfg.languages = Array.from({ length: rng.int(3) + 1 }, () => rng.pick(CODE_QUALITY_LANGUAGES));
  }
  if (rng.bool(0.3)) {
    cfg.ai_findings_option = rng.pick(["disabled", "on_push"]);
  }
  return cfg;
}
