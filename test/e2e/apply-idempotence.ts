import { allEndpoints, type TaggedEndpoint } from "../../src/sections/registry.js";
import type { MockState } from "./mock/state.js";

export type Recurrence = "always" | "may" | "never";

export function recurrence(endpoint: TaggedEndpoint): Recurrence {
  if (endpoint.alwaysRewrite === true) {
    return "always";
  }
  return endpoint.unverifiable === true ? "may" : "never";
}

export function recurringEndpointKeys(rule: Exclude<Recurrence, "never">): string[] {
  return Object.entries(allEndpoints())
    .filter(([, endpoint]) => recurrence(endpoint) === rule)
    .map(([key]) => key)
    .sort();
}

/**
 * Each alwaysRewrite endpoint's mock state family, whose updated_at moves between applies, or null
 * when nothing stored moves (Git LFS stores nothing; check suite preferences carry no timestamp).
 * The lockstep test pins the KEY SET against the flags.
 */
export const ALWAYS_REWRITE_ENDPOINT_FAMILIES: Readonly<Record<string, keyof MockState | null>> = {
  "actions_secrets.put": "actions_secrets",
  "dependabot_secrets.put": "dependabot_secrets",
  "codespaces_secrets.put": "codespaces_secrets",
  "agents_secrets.put": "agents_secrets",
  "environments.putSecret": "environment_secrets",
  "interaction_limits.put": "interaction_limits",
  "repository.lfsPut": null,
  "repository.lfsRemove": null,
  "check_suite_preferences.update": null,
};

export const ALWAYS_REWRITE_STATE_FAMILIES: ReadonlySet<string> = new Set<string>(
  Object.values(ALWAYS_REWRITE_ENDPOINT_FAMILIES).filter((family) => family !== null),
);
