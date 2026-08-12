/**
 * The section handler fragments the mock's route pipeline aggregates. Each
 * settings section contributes one REST fragment (and, when it declares
 * GraphQL operations, one GraphQL fragment): a record of "section.role" keys
 * to handlers. During the per-section directory migration the fragments of
 * every not-yet-moved section live in the two UNMOVED_* tables below; a moved
 * section carves its entries out into src/sections/<key>/mock.ts and adds one
 * import plus one FRAGMENTS entry here. A per-section mock.ts deliberately
 * imports the test-tree seams (this file's siblings support.ts and state.ts,
 * never routes.ts); the bundle entry is src/main.ts, so mock fragments never
 * reach lib/index.js. The merge asserts key uniqueness loudly, so two
 * fragments claiming the same endpoint fail at construction, and
 * assertHandlerCompleteness (routes.ts) keeps the merged table in lockstep
 * with the endpoint declarations exactly as before.
 */

import { MAX_PINNED_ENVIRONMENTS } from "../../../src/schema.js";
import { actionsSecretsMockHandlers } from "../../../src/sections/actions_secrets/mock.js";
import { actionsVariablesMockHandlers } from "../../../src/sections/actions_variables/mock.js";
import { agentsSecretsMockHandlers } from "../../../src/sections/agents_secrets/mock.js";
import { agentsVariablesMockHandlers } from "../../../src/sections/agents_variables/mock.js";
import { autolinksMockHandlers } from "../../../src/sections/autolinks/mock.js";
import { checkSuitePreferencesMockHandlers } from "../../../src/sections/check_suite_preferences/mock.js";
import { codeQualitySetupMockHandlers } from "../../../src/sections/code_quality_setup/mock.js";
import { codeScanningDefaultSetupMockHandlers } from "../../../src/sections/code_scanning_default_setup/mock.js";
import { codespacesSecretsMockHandlers } from "../../../src/sections/codespaces_secrets/mock.js";
import { collaboratorsMockHandlers } from "../../../src/sections/collaborators/mock.js";
import { customPropertiesMockHandlers } from "../../../src/sections/custom_properties/mock.js";
import { dependabotSecretsMockHandlers } from "../../../src/sections/dependabot_secrets/mock.js";
import { interactionLimitsMockHandlers } from "../../../src/sections/interaction_limits/mock.js";
import { labelsMockHandlers } from "../../../src/sections/labels/mock.js";
import { milestonesMockHandlers } from "../../../src/sections/milestones/mock.js";
import { pagesMockHandlers } from "../../../src/sections/pages/mock.js";
import { allEndpoints } from "../../../src/sections/registry.js";
import {
  repositoryMockGraphqlHandlers,
  repositoryMockHandlers,
} from "../../../src/sections/repository/mock.js";
import { rulesetsMockHandlers } from "../../../src/sections/rulesets/mock.js";
import { secretScanningCustomPatternsMockHandlers } from "../../../src/sections/secret_scanning_custom_patterns/mock.js";
import { teamsMockHandlers } from "../../../src/sections/teams/mock.js";
import { ADMIN_SLUG } from "../constants.js";
import { MOCK_SECRETS_KEY_ID, MOCK_SECRETS_PUBLIC_KEY } from "./secrets.js";
import {
  allRuleNodes,
  applyRuleInput,
  applyRuleInputToLiteral,
  BYPASS_ACTOR_TEAMS,
  BYPASS_ACTOR_USERS,
  completeHook,
  completeRule,
  decodeNodeId,
  environmentFromPut,
  mintNodeId,
  PROTECTION_RULE_APPS,
  protectionFromPut,
  ruleFromProtection,
  ruleWireNode,
} from "./state.js";
import {
  asObject,
  branchPoliciesEnabled,
  environmentVariableName,
  type GraphqlHandler,
  type GraphqlHandlerResult,
  type Handler,
  HOOK_CANONICAL_KEYS,
  integrationBody,
  type Json,
  maskedConfig,
  maskHookSecret,
  noContent,
  ok,
  pinTargetName,
  repoNodeId,
  sealedSecretPut,
  secretRemove,
  secretsList,
  slicePage,
  storedHookConfig,
  storedKeyMaterial,
} from "./support.js";

// --- Per-endpoint handlers ------------------------------------------------
//
// One entry per "section.role" key in allEndpoints(). Reads serve
// fixture-backed MockState; writes mutate it via the state.ts transformers and
// reply with a body/status drawn ONLY from the endpoint's declared statuses
// (a startup check proves every status a handler can return is declared).

const UNMOVED_SECTION_HANDLERS: Record<string, Handler> = {
  // labels: moved to src/sections/labels/mock.ts

  // repository: moved to src/sections/repository/mock.ts

  // branches ---------------------------------------------------------------
  "branches.getProtection": ({ state, param }) => {
    const branch = param("branch");
    const protection = state.branch_protection[branch];
    if (!protection) {
      return { status: 404, body: { message: "Branch not protected" } };
    }
    return ok(protection);
  },
  "branches.putProtection": ({ state, param, body }) => {
    const branch = param("branch");
    const stored = protectionFromPut(asObject(body));
    // The signed-commit requirement is its own sub-resource and absent from
    // the PUT's request schema (protectionFromPut drops any
    // required_signatures the body smuggles in). Whether GitHub's PUT
    // PRESERVES an existing requirement is not documented; the mock carries
    // it across as the conservative reading, and the user-facing docs tell
    // anyone relying on the requirement to DECLARE the toggle, which pins
    // the state under either upstream behavior.
    const previous = state.branch_protection[branch];
    if (previous && previous.required_signatures !== undefined) {
      stored.required_signatures = previous.required_signatures;
    }
    state.branch_protection[branch] = stored;
    return ok(stored);
  },
  "branches.removeProtection": ({ state, param }) => {
    const branch = param("branch");
    state.branch_protection[branch] = null;
    // GitHub deletes the whole underlying RULE: a later re-protect starts
    // clean, so the GraphQL-only extras must not survive the delete.
    delete state.branch_protection_graphql[branch];
    return noContent();
  },
  "branches.sigPost": ({ state, param }) => {
    const branch = param("branch");
    const protection = state.branch_protection[branch];
    if (!protection) {
      return { status: 404, body: { message: "Branch not protected" } };
    }
    protection.required_signatures = { enabled: true };
    // The documented 200 body carries {url, enabled}; the url stays out of
    // the stored state so the flattener sees the same shape a GET serves.
    return ok({
      url: `https://api.github.com/repos/${ADMIN_SLUG}/branches/${branch}/protection/required_signatures`,
      enabled: true,
    });
  },
  "branches.sigDelete": ({ state, param }) => {
    const branch = param("branch");
    const protection = state.branch_protection[branch];
    if (!protection) {
      return { status: 404, body: { message: "Branch not protected" } };
    }
    // The GET shape OMITS the field when signatures are not required, so a
    // delete removes the key instead of storing {enabled: false}.
    delete protection.required_signatures;
    return noContent();
  },
  "branches.branchProbe": ({ state, param }) => {
    const branch = param("branch");
    if (!state.branches.includes(branch)) {
      return { status: 404, body: { message: "Branch not found" } };
    }
    return ok({ name: branch });
  },
  "branches.appLookup": ({ param }) => {
    const slug = param("app_slug");
    // Slug matching is case-insensitive like GitHub's; the body echoes the
    // canonical roster slug.
    const app = PROTECTION_RULE_APPS.find(
      (entry) => String(entry.slug).toLowerCase() === slug.toLowerCase(),
    );
    if (!app) {
      return { status: 404, body: { message: "Not Found" } };
    }
    // The served node_id is MINTED (never the fixture's realistic-looking
    // one): the section feeds it into bypassForcePushActorIds, and mutation
    // handlers reject any id the codec cannot decode.
    return ok(integrationBody(app));
  },

  // environments -----------------------------------------------------------
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
      variables: slicePage(
        variables,
        query,
        allEndpoints()["environments.listVariables"]?.pageSize,
      ),
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
    if (list.some((v) => environmentVariableName(v) === String(payload.name).toUpperCase())) {
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
      (v) => environmentVariableName(v) === name.toUpperCase(),
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
    const index = list.findIndex((v) => environmentVariableName(v) === name.toUpperCase());
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

  // autolinks: moved to src/sections/autolinks/mock.ts

  // actions ----------------------------------------------------------------
  "actions.getPermissions": ({ state }) => ok(state.actions_permissions),
  "actions.putPermissions": ({ state, body }) => {
    state.actions_permissions = asObject(body);
    return noContent();
  },
  "actions.getSelected": ({ state }) => {
    // The selected-actions allowlist only applies under an allowed_actions
    // policy of "selected"; otherwise the endpoint answers 409 (its declared
    // "policy is not selected" status), never a 200 with a stale body.
    if (state.actions_permissions.allowed_actions !== "selected") {
      return { status: 409, body: { message: "The allowed_actions policy is not 'selected'" } };
    }
    return ok(state.selected_actions);
  },
  "actions.putSelected": ({ state, body }) => {
    state.selected_actions = asObject(body);
    return noContent();
  },
  "actions.getWorkflow": ({ state }) => ok(state.workflow_permissions),
  "actions.putWorkflow": ({ state, body }) => {
    state.workflow_permissions = asObject(body);
    return noContent();
  },
  "actions.getAccess": ({ state }) => ok(state.actions_access),
  "actions.putAccess": ({ state, body }) => {
    state.actions_access = asObject(body);
    return noContent();
  },
  "actions.getRetention": ({ state }) => ok(state.actions_retention),
  "actions.putRetention": ({ state, body }) => {
    // The PUT body is {days}; the GET shape also carries the read-only
    // maximum_allowed_days, so merge instead of replacing.
    state.actions_retention = { ...asObject(state.actions_retention), ...asObject(body) };
    return noContent();
  },
  "actions.getCacheRetention": ({ state }) => ok(state.cache_retention_limit),
  "actions.putCacheRetention": ({ state, body }) => {
    state.cache_retention_limit = asObject(body);
    return noContent();
  },
  "actions.getCacheStorage": ({ state }) => ok(state.cache_storage_limit),
  "actions.putCacheStorage": ({ state, body }) => {
    state.cache_storage_limit = asObject(body);
    return noContent();
  },
  "actions.getOidcSub": ({ state }) => ok(state.oidc_customization_sub),
  "actions.putOidcSub": ({ state, body }) => {
    // Stores the body verbatim and answers 201 with an empty object (the
    // documented success shape). The mock has no organization layer, so an
    // omitted include_claim_keys never resolves to inherited org-template
    // keys the way it does upstream - a deliberate abstraction, safe
    // because the section compares only declared keys (the unit tests pin
    // that semantic).
    state.oidc_customization_sub = asObject(body);
    return { status: 201, body: {} };
  },
  "actions.getForkPrApproval": ({ state }) => ok(state.fork_pr_contributor_approval),
  "actions.putForkPrApproval": ({ state, body }) => {
    // The PUT body is the same required-approval_policy shape the GET
    // returns, so the body replaces the stored policy wholesale.
    state.fork_pr_contributor_approval = asObject(body);
    return noContent();
  },
  // Both fork-pr-workflows-private-repos handlers serve every repository,
  // visibility included, ON PURPOSE. GitHub documents the pair for private
  // repositories but not what a public repository answers (the contract's
  // 403 is bare), so EITHER mock behavior would be a guess - and the engine
  // has no visibility branch on this path (repo visibility feeds only the
  // redaction machinery), so a visibility-gated denial would exercise no
  // engine code the fine_grained denial scenarios do not already cover.
  // The section's denialHint carries the ambiguity for real users, and the
  // curated scenarios pin the private-repo case.
  "actions.getForkPrPrivate": ({ state }) => ok(state.fork_pr_workflows_private_repos),
  "actions.putForkPrPrivate": ({ state, body }) => {
    // Stored verbatim: the section's shape requires the complete four-toggle
    // policy, so the mock never has to model GitHub's UNDOCUMENTED behavior
    // for an omitted toggle (preserve vs reset), and a complete body makes
    // replace and merge identical anyway.
    state.fork_pr_workflows_private_repos = asObject(body);
    return noContent();
  },

  // workflows --------------------------------------------------------------
  "workflows.list": ({ state, query }) => {
    const page = slicePage(state.workflows, query);
    return ok({ total_count: state.workflows.length, workflows: page });
  },
  "workflows.enable": ({ state, param }) => {
    const id = param("workflow_id");
    const workflow = state.workflows.find((w) => String(w.id) === id);
    if (!workflow) {
      return { status: 404, body: { message: "Not Found" } };
    }
    workflow.state = "active";
    return noContent();
  },
  "workflows.disable": ({ state, param }) => {
    const id = param("workflow_id");
    const workflow = state.workflows.find((w) => String(w.id) === id);
    if (!workflow) {
      return { status: 404, body: { message: "Not Found" } };
    }
    workflow.state = "disabled_manually";
    return noContent();
  },

  // pages: moved to src/sections/pages/mock.ts

  // interaction_limits: moved to src/sections/interaction_limits/mock.ts

  // collaborators: moved to src/sections/collaborators/mock.ts

  // teams: moved to src/sections/teams/mock.ts

  // milestones: moved to src/sections/milestones/mock.ts

  // webhooks ------------------------------------------------------------------
  //
  // The stored hook keeps its REAL config.secret (so state comparisons see
  // what was written), but every response echoes it as "********" - GitHub
  // never reveals a webhook secret on any read or write echo.
  "webhooks.list": ({ state, query }) => ok(slicePage(state.hooks.map(maskHookSecret), query)),
  "webhooks.create": ({ state, body }) => {
    const payload = asObject(body);
    const hook = completeHook(
      { ...payload, config: storedHookConfig(asObject(payload.config)) },
      state.nextId++,
    );
    state.hooks.push(hook);
    return { status: 201, body: maskHookSecret(hook) };
  },
  "webhooks.update": ({ state, param, body }) => {
    const id = param("hook_id");
    const hook = state.hooks.find((h) => String(h.id) === id);
    if (!hook) {
      return { status: 404, body: { message: "Not Found" } };
    }
    const payload = asObject(body);
    // GitHub's general PATCH REPLACES the whole config when the body carries
    // one (removing undeclared keys, the secret included) - the exact
    // semantics the section avoids by routing config drift through the
    // config sub-endpoint. Modeled faithfully so a regression that sends
    // config through this route shows up as lost state.
    if (payload.config !== undefined) {
      hook.config = storedHookConfig(asObject(payload.config));
    }
    if (payload.events !== undefined) {
      hook.events = payload.events;
    }
    if (payload.active !== undefined) {
      hook.active = payload.active;
    }
    for (const [key, value] of Object.entries(payload)) {
      if (!HOOK_CANONICAL_KEYS.has(key)) {
        hook[key] = value; // passthrough fields read back verbatim
      }
    }
    return ok(maskHookSecret(hook));
  },
  "webhooks.updateConfig": ({ state, param, body }) => {
    const id = param("hook_id");
    const hook = state.hooks.find((h) => String(h.id) === id);
    if (!hook) {
      return { status: 404, body: { message: "Not Found" } };
    }
    // The config sub-endpoint UPDATES the named fields and leaves the rest
    // alone - it never removes an existing secret the payload omits.
    hook.config = storedHookConfig({ ...asObject(hook.config), ...asObject(body) });
    return ok(maskedConfig(asObject(hook.config)));
  },
  "webhooks.remove": ({ state, param }) => {
    const id = param("hook_id");
    const index = state.hooks.findIndex((h) => String(h.id) === id);
    if (index < 0) {
      return { status: 404, body: { message: "Not Found" } };
    }
    state.hooks.splice(index, 1);
    return noContent();
  },

  // custom_properties: moved to src/sections/custom_properties/mock.ts

  // deploy_keys ---------------------------------------------------------------
  "deploy_keys.list": ({ state, query }) => ok(slicePage(state.deploy_keys, query)),
  "deploy_keys.create": ({ state, body }) => {
    const payload = asObject(body);
    const stored = storedKeyMaterial(String(payload.key ?? ""));
    // One repository per public key, account-wide on GitHub; this state is
    // one repo, so a duplicate stored blob answers GitHub's 422. The section
    // itself rejects duplicate declared material and cross-title conflicts
    // upfront, so no section path reaches this branch anymore; it stays as
    // defensive modeling of GitHub's real answer for any other mock client.
    if (state.deploy_keys.some((k) => storedKeyMaterial(String(k.key)) === stored)) {
      return {
        status: 422,
        body: {
          message: "Validation Failed",
          errors: [
            {
              resource: "PublicKey",
              code: "custom",
              field: "key",
              message: "key is already in use",
            },
          ],
          documentation_url:
            "https://docs.github.com/rest/deploy-keys/deploy-keys#create-a-deploy-key",
        },
      };
    }
    const id = state.nextId++;
    const key: Json = {
      id,
      key: stored,
      url: `https://api.github.com/repos/${ADMIN_SLUG}/keys/${id}`,
      title: String(payload.title ?? ""),
      verified: true,
      // Fixed so a repeat apply leaves the state byte-stable (idempotence).
      created_at: "2026-07-01T00:00:00Z",
      read_only: payload.read_only === true,
    };
    state.deploy_keys.push(key);
    return { status: 201, body: key };
  },
  "deploy_keys.remove": ({ state, param }) => {
    const id = param("key_id");
    const index = state.deploy_keys.findIndex((k) => String(k.id) === id);
    if (index < 0) {
      return { status: 404, body: { message: "Not Found" } };
    }
    state.deploy_keys.splice(index, 1);
    return noContent();
  },
};

// --- GraphQL operations -----------------------------------------------------
//
// The GraphQL sibling of the REST handler table. Dispatch is by operationName
// (the globally-unique wire key allGraphqlOps() asserts), never by parsing the
// query text. A handler answers ONLY the two shapes GitHub's GraphQL endpoint
// can produce for a declared operation: a 200 with a data object, or a 200
// with data:null plus errors[] whose every type the operation DECLARES as a
// tolerated outcome - the status-subset guard's analog, enforced by the
// pipeline after every handler, and deliberately STRICTER than REST's
// undeclared->=400 realism allowance: an undeclared error type would drive
// tolerance semantics the declaration never promised.

/**
 * One entry per "section.role" key in allGraphqlOps(), exactly like HANDLERS.
 * The completeness assertion below keeps it in lockstep with the declarations.
 * The pin family models VERIFIED live GitHub position semantics: a new pin
 * appends at a monotonic counter, unpinning leaves a hole (no renumbering),
 * and only the reorder mutation renormalizes the list to contiguous 1..N.
 */
const UNMOVED_SECTION_GRAPHQL_HANDLERS: Record<string, GraphqlHandler> = {
  // environments (pinned) ----------------------------------------------------
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
  // branches ---------------------------------------------------------------
  "branches.rulesQuery": ({ state }) => ({
    data: {
      repository: {
        branchProtectionRules: {
          nodes: allRuleNodes(state),
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    },
  }),
  "branches.repoLookup": ({ state }) => ({
    data: { repository: { id: repoNodeId(state) } },
  }),
  "branches.actorUser": ({ state, variables }) => {
    const login = String((variables as Json).login ?? "");
    // GitHub logins are case-insensitive; the lookup resolves any spelling
    // and the minted id carries the CANONICAL roster login, so read-backs
    // echo the canonical form exactly like production.
    const canonical = BYPASS_ACTOR_USERS.find(
      (known) => known.toLowerCase() === login.toLowerCase(),
    );
    if (canonical === undefined) {
      return {
        errors: [
          {
            type: "NOT_FOUND",
            message: `Could not resolve to a User with the login of '${login}'.`,
          },
        ],
      };
    }
    const slug = state.slug;
    return {
      data: {
        repository: { id: repoNodeId(state) },
        user: { id: mintNodeId("user", slug, canonical) },
      },
    };
  },
  "branches.actorTeam": ({ state, variables }) => {
    const org = String((variables as Json).org ?? "");
    const team = String((variables as Json).team ?? "");
    const combinedFold = `${org}/${team}`.toLowerCase();
    if (
      !BYPASS_ACTOR_TEAMS.some((entry) => entry.toLowerCase().startsWith(`${org.toLowerCase()}/`))
    ) {
      return {
        errors: [
          {
            type: "NOT_FOUND",
            message: `Could not resolve to an Organization with the login of '${org}'.`,
          },
        ],
      };
    }
    const repository = { id: repoNodeId(state) };
    const canonical = BYPASS_ACTOR_TEAMS.find((entry) => entry.toLowerCase() === combinedFold);
    if (canonical === undefined) {
      // A known org with an unknown team is a NULLABLE-FIELD miss, not an
      // errors[] entry, matching GitHub's Organization.team shape.
      return { data: { repository, organization: { team: null } } };
    }
    const slug = state.slug;
    return {
      data: {
        repository,
        organization: { team: { id: mintNodeId("team", slug, canonical) } },
      },
    };
  },
  "branches.createRule": ({ state, variables }) => {
    const input = asObject((variables as Json).input);
    const pattern = String(input.pattern ?? "");
    if (allRuleNodes(state).some((node) => String(node.pattern) === pattern)) {
      return {
        errors: [
          {
            type: "UNPROCESSABLE",
            message: `A branch protection rule with the pattern '${pattern}' already exists.`,
          },
        ],
      };
    }
    const stored = completeRule({ pattern });
    const applied = applyRuleInput(stored, input, state);
    if ("bad" in applied) {
      return {
        errors: [
          {
            type: "UNPROCESSABLE",
            message: `Could not resolve to a node with the global id of '${applied.bad}'.`,
          },
        ],
      };
    }
    const slug = state.slug;
    stored.id = mintNodeId("rule", slug, String(stored.pattern));
    state.branch_protection_rules.push(stored);
    return {
      data: { createBranchProtectionRule: { branchProtectionRule: ruleWireNode(stored) } },
    };
  },
  "branches.updateRule": ({ state, variables }) => {
    const input = asObject((variables as Json).input);
    const id = String(input.branchProtectionRuleId ?? "");
    const decoded = decodeNodeId(id);
    const notFound: GraphqlHandlerResult = {
      errors: [
        {
          type: "NOT_FOUND",
          message: `Could not resolve to a node with the global id of '${id}'.`,
        },
      ],
    };
    if (!decoded || decoded.family !== "rule") {
      return notFound;
    }
    const pattern = decoded.key;
    const slug = state.slug;
    const wildcard = state.branch_protection_rules.find((rule) => rule.pattern === pattern);
    if (wildcard) {
      const applied = applyRuleInput(wildcard, input, state);
      if ("bad" in applied) {
        return {
          errors: [
            {
              type: "UNPROCESSABLE",
              message: `Could not resolve to a node with the global id of '${applied.bad}'.`,
            },
          ],
        };
      }
      // The id embeds the pattern, so a pattern change re-mints it, exactly
      // like stampNodeIds would.
      wildcard.id = mintNodeId("rule", slug, String(wildcard.pattern));
      return {
        data: { updateBranchProtectionRule: { branchProtectionRule: ruleWireNode(wildcard) } },
      };
    }
    const protection = state.branch_protection[pattern];
    if (!protection) {
      return notFound;
    }
    const applied = applyRuleInputToLiteral(state, pattern, input);
    if ("bad" in applied) {
      return {
        errors: [
          {
            type: "UNPROCESSABLE",
            message: `Could not resolve to a node with the global id of '${applied.bad}'.`,
          },
        ],
      };
    }
    return {
      data: {
        updateBranchProtectionRule: {
          branchProtectionRule: ruleFromProtection(
            pattern,
            protection,
            state.branch_protection_graphql[pattern],
            slug,
          ),
        },
      },
    };
  },
  "branches.deleteRule": ({ state, variables }) => {
    const input = asObject((variables as Json).input);
    const id = String(input.branchProtectionRuleId ?? "");
    const decoded = decodeNodeId(id);
    if (!decoded || decoded.family !== "rule") {
      return {
        errors: [
          {
            type: "NOT_FOUND",
            message: `Could not resolve to a node with the global id of '${id}'.`,
          },
        ],
      };
    }
    const pattern = decoded.key;
    const index = state.branch_protection_rules.findIndex((rule) => rule.pattern === pattern);
    if (index >= 0) {
      state.branch_protection_rules.splice(index, 1);
    } else if (state.branch_protection[pattern]) {
      // Deleting a literal rule through GraphQL removes the protection the
      // REST view serves, GitHub's one underlying rule.
      state.branch_protection[pattern] = null;
      delete state.branch_protection_graphql[pattern];
    } else {
      return {
        errors: [
          {
            type: "NOT_FOUND",
            message: `Could not resolve to a node with the global id of '${id}'.`,
          },
        ],
      };
    }
    return { data: { deleteBranchProtectionRule: { clientMutationId: null } } };
  },
};

/**
 * One section's mock handlers: its REST fragment plus, when the section
 * declares GraphQL operations, its GraphQL fragment - paired structurally so
 * a section registers once and cannot forget one half.
 */
interface SectionMockFragment {
  rest: Record<string, Handler>;
  graphql?: Record<string, GraphqlHandler>;
}

/**
 * The per-section fragments, in registration order: one entry per moved
 * section (imported from its src/sections/<key>/mock.ts) plus the UNMOVED_*
 * tables carrying every section not yet migrated.
 */
const FRAGMENTS: readonly SectionMockFragment[] = [
  { rest: actionsSecretsMockHandlers },
  { rest: actionsVariablesMockHandlers },
  { rest: agentsSecretsMockHandlers },
  { rest: agentsVariablesMockHandlers },
  { rest: autolinksMockHandlers },
  { rest: checkSuitePreferencesMockHandlers },
  { rest: codeQualitySetupMockHandlers },
  { rest: codeScanningDefaultSetupMockHandlers },
  { rest: codespacesSecretsMockHandlers },
  { rest: collaboratorsMockHandlers },
  { rest: customPropertiesMockHandlers },
  { rest: dependabotSecretsMockHandlers },
  { rest: interactionLimitsMockHandlers },
  { rest: labelsMockHandlers },
  { rest: milestonesMockHandlers },
  { rest: pagesMockHandlers },
  { rest: repositoryMockHandlers, graphql: repositoryMockGraphqlHandlers },
  { rest: rulesetsMockHandlers },
  { rest: secretScanningCustomPatternsMockHandlers },
  { rest: teamsMockHandlers },
  { rest: UNMOVED_SECTION_HANDLERS, graphql: UNMOVED_SECTION_GRAPHQL_HANDLERS },
];

/**
 * Merge fragments into one handler table, failing loudly when two fragments
 * register the same "section.role" key: a duplicate would let one section's
 * mock silently shadow another's, so it is a construction-time error naming
 * every offending key.
 */
function mergeFragments<H>(
  kind: "REST" | "GraphQL",
  fragments: ReadonlyArray<Record<string, H>>,
): Record<string, H> {
  const merged: Record<string, H> = {};
  const duplicates: string[] = [];
  for (const fragment of fragments) {
    for (const [key, handler] of Object.entries(fragment)) {
      if (key in merged) {
        duplicates.push(key);
      }
      merged[key] = handler;
    }
  }
  if (duplicates.length > 0) {
    throw new Error(
      `E2E MOCK: duplicate ${kind} handler key(s) across section fragments: [${duplicates.sort().join(", ")}]`,
    );
  }
  return merged;
}

/** Every section's REST handlers, merged with the duplicate-key assert. */
export function sectionHandlerFragments(): Record<string, Handler> {
  return mergeFragments(
    "REST",
    FRAGMENTS.map((fragment) => fragment.rest),
  );
}

/** Every section's GraphQL handlers, merged with the duplicate-key assert. */
export function sectionGraphqlHandlerFragments(): Record<string, GraphqlHandler> {
  return mergeFragments(
    "GraphQL",
    FRAGMENTS.flatMap((fragment) => (fragment.graphql ? [fragment.graphql] : [])),
  );
}
