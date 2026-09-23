/** The `secret_scanning_custom_patterns:` section's schema slice; root src/schema.ts composes the SettingsFile property from it. */

import { z } from "zod";
import { compileFailure } from "./compilable-form.js";

const DELIMITER_CLEAR_ERROR =
  "a delimiter cannot be cleared with an empty string; remove the pattern and redeclare it without the field instead";

/** The syntax refusal's marker on its issue: the engine's reason, so a reader of the issues can tell it from every other failure. */
const REGEX_SYNTAX = "regexSyntax";

/** A regex field: the syntax check of compilable-form.ts, which refuses only what PCRE syntax refuses too. */
function regexSource(): z.ZodString {
  return z.string().superRefine((source, refineCtx) => {
    const reason = compileFailure(source);
    if (reason !== undefined) {
      refineCtx.addIssue({
        code: "custom",
        message:
          `cannot be compiled as a regular expression (${reason}); fix the expression, or report a documentation issue if ` +
          "Hyperscan accepts it as written - the check translates the PCRE-only forms the field docs list before compiling, " +
          "and GitHub can still refuse at apply what Hyperscan alone refuses",
        params: { [REGEX_SYNTAX]: reason },
      });
    }
  });
}

function syntaxReason(issue: z.core.$ZodIssue): string | undefined {
  const params = "params" in issue ? issue.params : undefined;
  const reason = params?.[REGEX_SYNTAX];
  return typeof reason === "string" ? reason : undefined;
}

/**
 * The regex fields of a live entry the syntax check refuses, as `field (reason)` labels; empty when
 * the entry is valid OR fails for any other reason. The snapshot leaves out what the check cannot
 * verify and keeps a mis-shaped entry for the engine's validation to name as the bug it is.
 */
export function unverifiableRegexFields(entry: unknown): string[] {
  const parsed = SecretScanningPatternConfig.safeParse(entry);
  if (parsed.success) {
    return [];
  }
  const labels: string[] = [];
  for (const issue of parsed.error.issues) {
    const reason = syntaxReason(issue);
    if (reason === undefined) {
      return [];
    }
    labels.push(`${z.core.toDotPath(issue.path)} (${reason})`);
  }
  return labels;
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
