import type { SectionDocs } from "../contract/docs.js";

export const docs: SectionDocs = {
  readme: {
    endpoints:
      "PUT environments + per-environment variables, secrets, deployment branch policies, deployment protection rules, and pins (GraphQL EnvironmentPins + PinEnvironment + ReorderEnvironment)",
    notes:
      "reviewers, wait timer, branch-policy flags; nested `variables`, `secrets`, `deployment_branch_policies`, and `deployment_protection_rules` keys reconcile per environment, each with its own `undeclared:` knob (within a declared key, undeclared variables and branch-policy patterns are deleted; secrets and protection rules are kept); a `pinned` key pins the environment on the home page's deployments sidebar over GraphQL (declaration order sets the pin order, max 10 pins; environments without the key are never unpinned)",
  },
};
