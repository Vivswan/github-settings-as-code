/**
 * `actions_variables:` section: Actions repository variables through the shared variables engine
 * (shared/repo-variables.ts). Values are plain text by design: variables are readable
 * configuration, which is what makes check-mode diffing possible; secrets are a different section.
 */

import { repoVariablesSection } from "../shared/repo-variables.js";

export const actionsVariablesSection = repoVariablesSection({
  key: "actions_variables",
  resource: "variables",
  noun: "Actions variable",
});
