/**
 * The code_scanning_default_setup fuzz generator fragment, aggregated by test/e2e/generators.ts.
 */

import { CODE_SCANNING_LANGUAGES } from "../../../src/sections/code_scanning_default_setup/schema.js";
import type { Json } from "../../e2e/gen-support.js";
import type { Rng } from "../../e2e/prng.js";

export function genCodeScanning(rng: Rng): Json {
  const cfg: Json = { state: rng.pick(["configured", "not-configured"]) };
  if (rng.bool()) {
    cfg.query_suite = rng.pick(["default", "extended"]);
  }
  if (rng.bool()) {
    cfg.threat_model = rng.pick(["remote", "remote_and_local"]);
  }
  // Later fields fork their own stream so recorded seeds keep reproducing.
  const runnerRng = rng.fork("runner");
  if (runnerRng.bool(0.3)) {
    cfg.runner_type = runnerRng.pick(["standard", "labeled"] as const);
    if (cfg.runner_type === "labeled") {
      cfg.runner_label = "e2e-runner";
    }
  }
  if (rng.bool(0.5)) {
    cfg.languages = Array.from({ length: rng.int(3) + 1 }, () =>
      rng.pick(CODE_SCANNING_LANGUAGES.declarable),
    );
  }
  return cfg;
}
