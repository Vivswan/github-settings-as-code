/**
 * The environments section's e2e mock fragment, registered in
 * test/e2e/mock/sections.ts. Imports the test-tree seams (mock/support.ts,
 * mock/state.ts, and mock/secrets.ts) on purpose - the bundle entry is
 * src/main.ts, so this fragment never reaches lib/index.js - and never
 * routes.ts or sections.ts.
 *
 * The pin family models VERIFIED live GitHub position semantics: a new pin
 * appends at a monotonic counter, unpinning leaves a hole (no renumbering),
 * and only the reorder mutation renormalizes the list to contiguous 1..N.
 */

import { mintNodeId } from "../../../test/e2e/mock/node-id.js";
import { MOCK_SECRETS_KEY_ID, MOCK_SECRETS_PUBLIC_KEY } from "../../../test/e2e/mock/secrets.js";
import { environmentFromPut, PROTECTION_RULE_APPS } from "../../../test/e2e/mock/state.js";
import {
  asObject,
  branchPoliciesEnabled,
  type Json,
  noContent,
  ok,
  pinTargetName,
  type SectionGraphqlHandlers,
  type SectionRestHandlers,
  sealedSecretPut,
  secretRemove,
  secretsList,
  slicePage,
  variableName,
} from "../../../test/e2e/mock/support.js";
import { variableKey } from "../shared/variables-engine.js";
import { environmentsSection } from "./index.js";
import { MAX_PINNED_ENVIRONMENTS } from "./schema.js";

export const environmentsMockHandlers: SectionRestHandlers<"environments"> = {
  "environments.probe": ({ state, param }) => {
    const name = param("environment_name");
    const environment = state.environments[name];
    if (!environment) {
      return { status: 404, body: { message: "Not Found" } };
    }
    // Enabled custom deployment protection rules surface in the environment
    // GET as the spec's third protection_rules variant ({id, node_id, type};
    // the type names the gating App), like GitHub. Derived at read time so
    // the stored body stays the PUT transformer's output, and appended to a
    // copy so the handler never mutates the state it serves.
    const custom = (state.environment_protection_rules[name] ?? []).map((rule) => ({
      id: rule.id,
      node_id: rule.node_id,
      type: (rule.app as Json | undefined)?.slug ?? "custom",
    }));
    if (custom.length === 0) {
      return ok(environment);
    }
    const rules = Array.isArray(environment.protection_rules) ? environment.protection_rules : [];
    return ok({ ...environment, protection_rules: [...rules, ...custom] });
  },
  "environments.update": ({ state, param, body }) => {
    const name = param("environment_name");
    // GitHub's PUT environment returns 200 on BOTH create and update (never
    // 201), matching the section's declared status and the OpenAPI spec. The
    // node id is minted last so a smuggled node_id in the PUT body can never
    // displace the canonical self-describing one.
    state.environments[name] = {
      name,
      ...environmentFromPut(asObject(body)),
      node_id: mintNodeId("environment", state.slug, name),
    };
    return ok(state.environments[name]);
  },
  // Every variables handler 404s for an environment that does not exist: the
  // variables live under the environment, and the section only calls them
  // after its probe (check) or PUT (apply) proved the environment is there.
  "environments.listVariables": ({ state, param, query }) => {
    const env = param("environment_name");
    if (!state.environments[env]) {
      return { status: 404, body: { message: "Not Found" } };
    }
    const variables = state.environment_variables[env] ?? [];
    // Clamp from the endpoint declaration, exactly like the repository
    // variables list: one source for the client loop, the sweep, and here.
    return ok({
      total_count: variables.length,
      variables: slicePage(variables, query, environmentsSection.endpoints.listVariables.pageSize),
    });
  },
  "environments.createVariable": ({ state, param, body }) => {
    const env = param("environment_name");
    if (!state.environments[env]) {
      return { status: 404, body: { message: "Not Found" } };
    }
    const payload = asObject(body);
    let list = state.environment_variables[env];
    if (!list) {
      list = [];
      state.environment_variables[env] = list;
    }
    // A duplicate (case-insensitive) name conflicts, matching GitHub; the
    // section never POSTs a duplicate (it PATCHes an existing variable).
    if (list.some((v) => variableName(v) === variableName(payload))) {
      return { status: 409, body: { message: "Variable already exists" } };
    }
    // Fixed timestamps keep repeat applies byte-stable for the idempotence
    // proof; the section never reads them.
    list.push({
      name: payload.name,
      value: payload.value,
      created_at: "2026-07-01T00:00:00Z",
      updated_at: "2026-07-01T00:00:00Z",
    });
    return { status: 201, body: {} };
  },
  "environments.updateVariable": ({ state, param, body }) => {
    const env = param("environment_name");
    const name = param("name");
    const variable = (state.environment_variables[env] ?? []).find(
      (v) => variableName(v) === variableKey(name),
    );
    if (!state.environments[env] || !variable) {
      return { status: 404, body: { message: "Not Found" } };
    }
    const payload = asObject(body);
    if (typeof payload.name === "string") {
      variable.name = payload.name;
    }
    if (typeof payload.value === "string") {
      variable.value = payload.value;
    }
    return noContent();
  },
  "environments.removeVariable": ({ state, param }) => {
    const env = param("environment_name");
    const name = param("name");
    const list = state.environment_variables[env] ?? [];
    const index = list.findIndex((v) => variableName(v) === variableKey(name));
    if (!state.environments[env] || index < 0) {
      return { status: 404, body: { message: "Not Found" } };
    }
    list.splice(index, 1);
    return noContent();
  },
  // Every environment-secrets handler 404s for an environment that does not
  // exist, like the variables handlers: the secrets live under the
  // environment, and the section only calls them after its probe (check) or
  // PUT (apply) proved the environment is there. The seal/unseal and
  // timestamp semantics are the shared secret-family helpers'.
  "environments.listSecrets": ({ state, param, query }) => {
    const env = param("environment_name");
    if (!state.environments[env]) {
      return { status: 404, body: { message: "Not Found" } };
    }
    return secretsList(state.environment_secrets[env] ?? [], query);
  },
  "environments.secretsPublicKey": ({ state, param }) => {
    const env = param("environment_name");
    if (!state.environments[env]) {
      return { status: 404, body: { message: "Not Found" } };
    }
    return ok({ key_id: MOCK_SECRETS_KEY_ID, key: MOCK_SECRETS_PUBLIC_KEY });
  },
  "environments.putSecret": ({ state, param, body }) => {
    const env = param("environment_name");
    const name = param("secret_name");
    if (!state.environments[env]) {
      return { status: 404, body: { message: "Not Found" } };
    }
    let list = state.environment_secrets[env];
    if (!list) {
      list = [];
      state.environment_secrets[env] = list;
    }
    let digests = state.environment_secret_digests[env];
    if (!digests) {
      digests = {};
      state.environment_secret_digests[env] = digests;
    }
    return sealedSecretPut(state, list, digests, name, body);
  },
  "environments.removeSecret": ({ state, param }) => {
    const env = param("environment_name");
    const name = param("secret_name");
    if (!state.environments[env]) {
      return { status: 404, body: { message: "Not Found" } };
    }
    return secretRemove(
      state.environment_secrets[env] ?? [],
      state.environment_secret_digests[env] ?? {},
      name,
    );
  },
  // The branch-policy pattern handlers 404 when the environment is missing OR
  // its stored deployment_branch_policy does not enable
  // custom_branch_policies, matching GitHub's documented "Not Found or
  // custom_branch_policies is false" behavior on this endpoint family.
  "environments.listPolicies": ({ state, param, query }) => {
    const env = param("environment_name");
    if (!branchPoliciesEnabled(state, env)) {
      return { status: 404, body: { message: "Not Found" } };
    }
    const policies = state.environment_branch_policies[env] ?? [];
    return ok({
      total_count: policies.length,
      branch_policies: slicePage(policies, query),
    });
  },
  "environments.createPolicy": ({ state, param, body }) => {
    const env = param("environment_name");
    if (!branchPoliciesEnabled(state, env)) {
      return { status: 404, body: { message: "Not Found" } };
    }
    const payload = asObject(body);
    // GitHub enforces the type enum server-side; settings pass through
    // verbatim, so a user typo reaches this POST and must be answered with
    // the real 422, not silently accepted. requestOffSpec exempts only the
    // request-body SCHEMA check (the spec forbids this body by design; the
    // rejection is the behavior under test), like the rulesets rule-type
    // handler.
    if (payload.type !== undefined && payload.type !== "branch" && payload.type !== "tag") {
      return {
        status: 422,
        body: { message: "Validation Failed", errors: [{ field: "type", code: "invalid" }] },
        requestOffSpec: true,
      };
    }
    let list = state.environment_branch_policies[env];
    if (!list) {
      list = [];
      state.environment_branch_policies[env] = list;
    }
    // A duplicate name pattern answers GitHub's documented 303 with NO body
    // (the spec declares no content for it) and no Location header, so the
    // client surfaces the response itself instead of chasing a redirect.
    if (list.some((policy) => policy.name === payload.name)) {
      return { status: 303, body: null };
    }
    const policy: Json = {
      id: state.nextId++,
      name: payload.name,
      type: typeof payload.type === "string" ? payload.type : "branch",
    };
    list.push(policy);
    return ok(policy);
  },
  "environments.removePolicy": ({ state, param }) => {
    const env = param("environment_name");
    const id = param("branch_policy_id");
    const list = state.environment_branch_policies[env] ?? [];
    const index = list.findIndex((policy) => String(policy.id) === id);
    if (!branchPoliciesEnabled(state, env) || index < 0) {
      return { status: 404, body: { message: "Not Found" } };
    }
    list.splice(index, 1);
    return noContent();
  },
  // The protection-rule handlers 404 for an environment that does not exist,
  // like the variables family; there is no flag precondition here.
  "environments.listProtectionRules": ({ state, param }) => {
    const env = param("environment_name");
    if (!state.environments[env]) {
      return { status: 404, body: { message: "Not Found" } };
    }
    const rules = state.environment_protection_rules[env] ?? [];
    // The whole list in one body: this endpoint documents no page/per_page
    // parameters, so there is nothing to slice.
    return ok({ total_count: rules.length, custom_deployment_protection_rules: rules });
  },
  "environments.listProtectionRuleApps": ({ state, param, query }) => {
    const env = param("environment_name");
    if (!state.environments[env]) {
      return { status: 404, body: { message: "Not Found" } };
    }
    return ok({
      total_count: PROTECTION_RULE_APPS.length,
      available_custom_deployment_protection_rule_integrations: slicePage(
        PROTECTION_RULE_APPS,
        query,
      ),
    });
  },
  "environments.createProtectionRule": ({ state, param, body }) => {
    const env = param("environment_name");
    if (!state.environments[env]) {
      return { status: 404, body: { message: "Not Found" } };
    }
    // An integration_id outside the available-Apps fixture answers a 422
    // (the engine resolves ids from that same listing, so only a harness bug
    // or a raced uninstall would reach this).
    const payload = asObject(body);
    const app = PROTECTION_RULE_APPS.find((candidate) => candidate.id === payload.integration_id);
    if (!app) {
      return {
        status: 422,
        body: { message: "Validation Failed", errors: [{ field: "integration_id" }] },
      };
    }
    let list = state.environment_protection_rules[env];
    if (!list) {
      list = [];
      state.environment_protection_rules[env] = list;
    }
    const id = state.nextId++;
    const rule: Json = { id, node_id: `DPR_${id}`, enabled: true, app: { ...app } };
    list.push(rule);
    return { status: 201, body: rule };
  },
  "environments.removeProtectionRule": ({ state, param }) => {
    const env = param("environment_name");
    const id = param("protection_rule_id");
    const list = state.environment_protection_rules[env] ?? [];
    const index = list.findIndex((rule) => String(rule.id) === id);
    if (!state.environments[env] || index < 0) {
      return { status: 404, body: { message: "Not Found" } };
    }
    list.splice(index, 1);
    return noContent();
  },
};

export const environmentsMockGraphqlHandlers: SectionGraphqlHandlers<"environments"> = {
  "environments.pins": ({ state }) => ({
    data: {
      repository: {
        pinnedEnvironments: {
          nodes: state.pinned_environments.map((pin) => ({
            position: pin.position,
            environment: { name: pin.name },
          })),
          // Whole list in one page: GitHub caps pins at
          // MAX_PINNED_ENVIRONMENTS, far under the query's page size.
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    },
  }),
  "environments.pin": ({ state, variables }) => {
    const target = pinTargetName(state, variables);
    if ("errors" in target) {
      return target;
    }
    const list = state.pinned_environments;
    const index = list.findIndex((pin) => pin.name === target.name);
    if (variables.pinned === true) {
      if (index < 0) {
        if (list.length >= MAX_PINNED_ENVIRONMENTS) {
          // The DECLARED outcome type, mirroring GitHub's cap rejection, so
          // the section's full-list error path is reachable on contract.
          return {
            errors: [
              {
                type: "UNPROCESSABLE",
                message: `Repositories may only have ${MAX_PINNED_ENVIRONMENTS} pinned environments`,
              },
            ],
          };
        }
        // Append at the tail via the monotonic counter (verified live
        // behavior); an earlier unpin's hole is never refilled.
        state._pinned_position_counter += 1;
        list.push({ name: target.name, position: state._pinned_position_counter });
      }
      return { data: { pinEnvironment: { environment: { name: target.name, isPinned: true } } } };
    }
    if (index >= 0) {
      // Remove WITHOUT renumbering: the positions of the remaining pins keep
      // their values, leaving a hole (verified live behavior).
      list.splice(index, 1);
    }
    return { data: { pinEnvironment: { environment: { name: target.name, isPinned: false } } } };
  },
  "environments.reorder": ({ state, variables }) => {
    const target = pinTargetName(state, variables);
    if ("errors" in target) {
      return target;
    }
    const list = state.pinned_environments;
    const index = list.findIndex((pin) => pin.name === target.name);
    const position = variables.position;
    if (
      index < 0 ||
      typeof position !== "number" ||
      !Number.isInteger(position) ||
      position < 1 ||
      position > list.length
    ) {
      // The section only reorders names it just proved pinned, to ranks
      // inside the list, so reaching this is a section bug - UNPROCESSABLE
      // is not declared on this operation, and the response guard flags it.
      return {
        errors: [
          {
            type: "UNPROCESSABLE",
            message: "The environment is not pinned or the position is out of range",
          },
        ],
      };
    }
    // Move to the 1-based RANK, then renormalize the WHOLE list to
    // contiguous 1..N - the reorder mutation is the one operation that
    // renumbers (verified live behavior), so the counter rejoins it.
    const [moved] = list.splice(index, 1);
    list.splice(position - 1, 0, moved as { name: string; position: number });
    list.forEach((pin, rank) => {
      pin.position = rank + 1;
    });
    state._pinned_position_counter = list.length;
    return { data: { reorderEnvironment: { environment: { name: target.name } } } };
  },
};
