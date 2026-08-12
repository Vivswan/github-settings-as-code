/**
 * The code_scanning_default_setup section's fuzz generator fragment,
 * aggregated by test/e2e/generators.ts. Imports only the test-tree leaf seams
 * (gen-support.ts, prng.ts) - the src -> test inversion is deliberate; the
 * bundle entry is src/main.ts, so this file never reaches lib/index.js.
 */

import type { Json } from "../../../test/e2e/gen-support.js";
import type { Rng } from "../../../test/e2e/prng.js";

/**
 * The code-scanning default-setup languages the real API accepts (the enum from
 * GitHub's OpenAPI). The published settings schema is looser, but the mock
 * validates the PATCH request body against the real spec, so the generator must
 * emit only these canonical values.
 */
const CODE_SCANNING_LANGUAGES = [
  "actions",
  "c-cpp",
  "csharp",
  "go",
  "java-kotlin",
  "javascript-typescript",
  "python",
  "ruby",
  "swift",
] as const;

export function genCodeScanning(rng: Rng): Json {
  const cfg: Json = { state: rng.pick(["configured", "not-configured"]) };
  if (rng.bool()) {
    cfg.query_suite = rng.pick(["default", "extended"]);
  }
  // threat_model occupies the draw slots of the duplicated query_suite
  // branch it replaced (same bool threshold, same two-way pick), so every
  // draw after it in this function is byte-identical across the swap.
  if (rng.bool()) {
    cfg.threat_model = rng.pick(["remote", "remote_and_local"]);
  }
  // The runner fields are NEW draws, so they live on a forked stream: the
  // main stream stays stable and recorded seeds keep reproducing.
  const runnerRng = rng.fork("runner");
  if (runnerRng.bool(0.3)) {
    cfg.runner_type = runnerRng.pick(["standard", "labeled"] as const);
    if (cfg.runner_type === "labeled") {
      // runner_label pairs with the labeled runner type (schema.ts).
      cfg.runner_label = "e2e-runner";
    }
  }
  if (rng.bool(0.5)) {
    cfg.languages = Array.from({ length: rng.int(3) + 1 }, () => rng.pick(CODE_SCANNING_LANGUAGES));
  }
  return cfg;
}
