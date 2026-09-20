/** The `secret_scanning_custom_patterns:` section's schema slice; root src/schema.ts composes the SettingsFile property from it. */

import { z } from "zod";

const DELIMITER_CLEAR_ERROR =
  "a delimiter cannot be cleared with an empty string; remove the pattern and redeclare it without the field instead";

/**
 * GitHub compiles these fields with Hyperscan, which this action cannot run, so the parse refuses only what a
 * flagless JS RegExp cannot compile. Flagless on purpose: without the u flag `\A` and `\z` (GitHub's default
 * delimiters) are identity escapes and compile, while `(?i)`, which GitHub documents as unsupported, still fails.
 */
function regexSource(): z.ZodString {
  return z.string().superRefine((source, refineCtx) => {
    try {
      new RegExp(source);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      refineCtx.addIssue({
        code: "custom",
        message:
          `cannot be compiled as a JavaScript regular expression (${reason}); fix the expression - GitHub's own dialect ` +
          "is Hyperscan, a PCRE subset without option modifiers such as (?i), and can still refuse an expression that compiles here",
      });
    }
  });
}

export const SecretScanningPatternConfig = z
  .object({
    name: z.string(),
    pattern: regexSource(),
    // "" cannot mean "clear the delimiter" (the PATCH updates provided fields only), so the spelling
    // fails at document validation, before any repository is touched.
    start_delimiter: regexSource().min(1, DELIMITER_CLEAR_ERROR).optional(),
    end_delimiter: regexSource().min(1, DELIMITER_CLEAR_ERROR).optional(),
    must_match: z.array(regexSource()).optional(),
    must_not_match: z.array(regexSource()).optional(),
  })
  .meta({ id: "SecretScanningPatternConfig" });
export type SecretScanningPatternConfig = z.infer<typeof SecretScanningPatternConfig>;
