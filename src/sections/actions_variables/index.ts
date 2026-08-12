/**
 * `actions_variables:` section - GitHub Actions repository variables,
 * upserted by case-insensitive name and DELETED loudly when undeclared (the
 * wrapped `undeclared: keep` form softens that to notes) through the shared
 * variables engine (shared/variables-engine.ts). Values are plain text by
 * design: variables are readable configuration, which is what makes
 * check-mode diffing possible; secrets are write-only material and
 * deliberately not this section. GitHub stores variable names uppercased
 * regardless of how they are entered, so matching and duplicate rejection
 * compare uppercased names.
 */

import { variablesSection } from "../shared/repo-variables.js";

export const actionsVariablesSection = variablesSection({
  key: "actions_variables",
  resource: "variables",
  noun: "Actions variable",
});
