/**
 * `agents_variables:` section: Copilot agents repository variables through the shared variables
 * engine (shared/repo-variables.ts). Values are plain text by design: variables are readable
 * configuration, which is what makes check-mode diffing possible; secrets are a different section.
 */

import { repoVariablesSection } from "../shared/repo-variables.js";

export const agentsVariablesSection = repoVariablesSection({
  key: "agents_variables",
  resource: "agent_variables",
  noun: "Copilot agents variable",
});
