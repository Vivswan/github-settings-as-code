/**
 * The `secret_scanning_custom_patterns:` section's schema slice; root src/schema.ts composes the SettingsFile property from it.
 * The regex fields are plain strings: their dialect is GitHub's to judge, so its refusal arrives at apply (index.ts).
 * "" cannot mean "clear the delimiter": the PATCH updates provided fields only, so that spelling is refused here.
 */

import { z } from "zod";
import { minLength, open } from "../shared/schema-helpers.js";

const DELIMITER_CLEAR_ERROR =
  "a delimiter cannot be cleared with an empty string; remove the pattern and redeclare it without the field instead";

export const SecretScanningPatternConfig = open({
  name: z.string(),
  pattern: z.string(),
  start_delimiter: z.string().check(minLength(1, DELIMITER_CLEAR_ERROR)).optional(),
  end_delimiter: z.string().check(minLength(1, DELIMITER_CLEAR_ERROR)).optional(),
  must_match: z.array(z.string()).optional(),
  must_not_match: z.array(z.string()).optional(),
}).meta({ id: "SecretScanningPatternConfig" });
export type SecretScanningPatternConfig = z.infer<typeof SecretScanningPatternConfig>;
