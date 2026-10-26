/**
 * The `labels:` section's entry-config declaration (see src/schema.ts). A color is six hex digits because a name or
 * CSS shorthand 422s on create and, on an existing label, drifts and re-PATCHes every run; the lens strips the
 * optional "#" and folds the case. The description cap is counted in code points, GitHub's unit, as JSON Schema's
 * maxLength does.
 */

import { z } from "zod";
import { boundedString, open } from "../shared/schema-helpers.js";

const LabelColor = z
  .string()
  .regex(
    /^#?[0-9a-fA-F]{6}$/,
    'a label color is six hex digits, the leading "#" optional ("#d73a4a" or "d73a4a"); color names and three-digit shorthand are not accepted',
  );

const DESCRIPTION_MAX = 100;

const LabelDescription = boundedString(
  DESCRIPTION_MAX,
  "code points",
  (count) =>
    `a label description is at most ${DESCRIPTION_MAX} characters (GitHub's cap); this one has ${count}`,
);

export const LabelConfig = open({
  name: z.string(),
  color: LabelColor.optional(),
  description: LabelDescription.optional(),
  new_name: z.string().optional(),
}).meta({ id: "LabelConfig" });

export type LabelConfig = z.infer<typeof LabelConfig>;
