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
import { autolinksMockHandlers } from "../../../src/sections/autolinks/mock.js";
import { customPropertiesMockHandlers } from "../../../src/sections/custom_properties/mock.js";
import { labelsMockHandlers } from "../../../src/sections/labels/mock.js";
import { milestonesMockHandlers } from "../../../src/sections/milestones/mock.js";
import { pagesMockHandlers } from "../../../src/sections/pages/mock.js";
import { allEndpoints } from "../../../src/sections/registry.js";
import { ADMIN_SLUG } from "../constants.js";
import { MOCK_SECRETS_KEY_ID, MOCK_SECRETS_PUBLIC_KEY } from "./secrets.js";
import {
  allRuleNodes,
  applyRuleInput,
  applyRuleInputToLiteral,
  BYPASS_ACTOR_TEAMS,
  BYPASS_ACTOR_USERS,
  bypassUser,
  collaboratorFromPut,
  completeHook,
  completeRule,
  decodeNodeId,
  environmentFromPut,
  invitationFromPut,
  invitationPermissionFromPut,
  mintNodeId,
  PROTECTION_RULE_APPS,
  protectionFromPut,
  restRepoSurface,
  ruleFromProtection,
  ruleWireNode,
  teamRepoFromPut,
} from "./state.js";
import {
  asObject,
  booleanToggleGet,
  branchPoliciesEnabled,
  bypassLogins,
  CAP_UNAVAILABLE_405,
  environmentVariableName,
  type GraphqlHandler,
  type GraphqlHandlerResult,
  type Handler,
  HOOK_CANONICAL_KEYS,
  IMMUTABLE_OWNER_CONFLICT,
  INTERACTION_EXPIRES,
  INTERACTION_ORG_CONFLICT,
  INTERACTION_ORG_LIMIT,
  integrationBody,
  invalidRuleTypeResponse,
  type Json,
  maskedConfig,
  maskHookSecret,
  mintSecretScanningVersion,
  noContent,
  ok,
  orgProbeHandler,
  pinTargetName,
  repoFeatureFields,
  repoNodeId,
  SECRET_SCANNING_STALE_VERSION,
  SECRET_SCANNING_UPDATABLE_KEYS,
  sameLogin,
  sealedSecretPut,
  secretRemove,
  secretScanningPatternFromCreate,
  secretsList,
  slicePage,
  storedHookConfig,
  storedKeyMaterial,
  VARIABLE_CANONICAL_KEYS,
  variableName,
} from "./support.js";

// --- Per-endpoint handlers ------------------------------------------------
//
// One entry per "section.role" key in allEndpoints(). Reads serve
// fixture-backed MockState; writes mutate it via the state.ts transformers and
// reply with a body/status drawn ONLY from the endpoint's declared statuses
// (a startup check proves every status a handler can return is declared).

const UNMOVED_SECTION_HANDLERS: Record<string, Handler> = {
  // repository -------------------------------------------------------------
  // Every repo body a REST handler serves - and the PATCH body it accepts -
  // goes through restRepoSurface, which strips the GraphQL-only fields
  // (state.ts), so the REST paths stay as blind to them as real GitHub's.
  "repository.get": ({ state }) => ok(restRepoSurface(state.repo)),
  "repository.update": ({ state, body }) => {
    Object.assign(state.repo, restRepoSurface(asObject(body)));
    return ok(restRepoSurface(state.repo));
  },
  "repository.topics": ({ state, body }) => {
    const names = asObject(body).names;
    state.repo.topics = Array.isArray(names) ? names : [];
    return ok({ names: state.repo.topics });
  },
  "repository.vulnerabilityAlertsGet": ({ state }) =>
    booleanToggleGet(state.repo.vulnerability_alerts_enabled === true),
  "repository.vulnerabilityAlertsPut": ({ state }) => {
    state.repo.vulnerability_alerts_enabled = true;
    return noContent();
  },
  "repository.vulnerabilityAlertsRemove": ({ state }) => {
    state.repo.vulnerability_alerts_enabled = false;
    return noContent();
  },
  "repository.automatedSecurityFixesGet": ({ state }) => {
    if (state.repo.automated_security_fixes_enabled === undefined) {
      // The spec documents this 404 (feature not enabled) with NO content.
      return { status: 404, body: null };
    }
    return ok({ enabled: state.repo.automated_security_fixes_enabled === true, paused: false });
  },
  "repository.automatedSecurityFixesPut": ({ state }) => {
    state.repo.automated_security_fixes_enabled = true;
    return noContent();
  },
  "repository.automatedSecurityFixesRemove": ({ state }) => {
    state.repo.automated_security_fixes_enabled = false;
    return noContent();
  },
  "repository.privateVulnerabilityReportingGet": ({ state }) => {
    // When the feature is not applicable to this repository (observed on
    // private repos), the GET answers 404 - one of its declared statuses. The
    // section reads that as "not enabled". Flag set via live_state.repo.
    if (state.repo.private_vulnerability_reporting_not_applicable === true) {
      return { status: 404, body: { message: "Not Found" } };
    }
    return ok({ enabled: state.repo.private_vulnerability_reporting_enabled === true });
  },
  "repository.privateVulnerabilityReportingPut": ({ state }) => {
    state.repo.private_vulnerability_reporting_enabled = true;
    return noContent();
  },
  "repository.privateVulnerabilityReportingRemove": ({ state }) => {
    // Disabling where the feature does not apply is already the declared state;
    // the DELETE answers 404 (a declared "already off / not applicable" status)
    // rather than 204, which the section tolerates.
    if (state.repo.private_vulnerability_reporting_not_applicable === true) {
      return { status: 404, body: { message: "Not Found" } };
    }
    state.repo.private_vulnerability_reporting_enabled = false;
    return noContent();
  },
  "repository.immutableReleasesGet": ({ state }) => {
    const enforced = state.repo.immutable_releases_enforced_by_owner === true;
    if (state.repo.immutable_releases_enabled !== true && !enforced) {
      // The spec documents this 404 (feature not enabled) with NO content.
      return { status: 404, body: null };
    }
    return ok({ enabled: true, enforced_by_owner: enforced });
  },
  "repository.immutableReleasesPut": ({ state }) => {
    if (state.repo.immutable_releases_enforced_by_owner === true) {
      return IMMUTABLE_OWNER_CONFLICT;
    }
    state.repo.immutable_releases_enabled = true;
    return noContent();
  },
  "repository.immutableReleasesRemove": ({ state }) => {
    if (state.repo.immutable_releases_enforced_by_owner === true) {
      return IMMUTABLE_OWNER_CONFLICT;
    }
    state.repo.immutable_releases_enabled = false;
    return noContent();
  },
  "repository.lfsPut": () => ({ status: 202, body: null }),
  "repository.lfsRemove": () => noContent(),

  // labels: moved to src/sections/labels/mock.ts

  // rulesets ---------------------------------------------------------------
  "rulesets.list": ({ state, query }) => ok(slicePage(state.rulesets, query)),
  "rulesets.create": ({ state, body }) => {
    const invalid = invalidRuleTypeResponse(body, "create-a-repository-ruleset");
    if (invalid) {
      return invalid;
    }
    const ruleset: Json = { id: state.nextId++, source_type: "Repository", ...asObject(body) };
    state.rulesets.push(ruleset);
    return { status: 201, body: ruleset };
  },
  "rulesets.get": ({ state, param }) => {
    const id = param("ruleset_id");
    const ruleset = state.rulesets.find((r) => String(r.id) === id);
    if (!ruleset) {
      return { status: 404, body: { message: "Not Found" } };
    }
    return ok(ruleset);
  },
  "rulesets.update": ({ state, param, body }) => {
    const id = param("ruleset_id");
    const index = state.rulesets.findIndex((r) => String(r.id) === id);
    if (index < 0) {
      // Existence first, like GitHub: an unknown ruleset 404s even when the
      // payload also carries an invalid rule type.
      return { status: 404, body: { message: "Not Found" } };
    }
    const invalid = invalidRuleTypeResponse(body, "update-a-repository-ruleset");
    if (invalid) {
      return invalid;
    }
    const updated: Json = { id: Number(id), source_type: "Repository", ...asObject(body) };
    state.rulesets[index] = updated;
    return ok(updated);
  },
  "rulesets.remove": ({ state, param }) => {
    const id = param("ruleset_id");
    const index = state.rulesets.findIndex((r) => String(r.id) === id);
    if (index < 0) {
      return { status: 404, body: { message: "Not Found" } };
    }
    state.rulesets.splice(index, 1);
    return noContent();
  },

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

  // dependabot_secrets / codespaces_secrets / agents_secrets
  //
  // The repository-level secret families share one handler shape (see
  // the sealedSecretPut/secretsList/secretRemove helpers): the list serves
  // names and timestamps only (values are never part of the GET shape), and
  // the PUT is the crypto proof - it UNSEALS the uploaded ciphertext with the
  // fixed test keypair, verifying the client's key decode, sealed-box
  // construction, and base64 round-trip in one step, and stores the name plus
  // a deterministic digest of the unsealed value, never the plaintext. Every
  // PUT bumps updated_at (as GitHub does), so the idempotence snapshot's
  // volatile-field exclusion is exercised for real.
  "dependabot_secrets.list": ({ state, query }) => secretsList(state.dependabot_secrets, query),
  "dependabot_secrets.publicKey": () =>
    ok({ key_id: MOCK_SECRETS_KEY_ID, key: MOCK_SECRETS_PUBLIC_KEY }),
  "dependabot_secrets.put": ({ state, param, body }) =>
    sealedSecretPut(
      state,
      state.dependabot_secrets,
      state.dependabot_secret_digests,
      param("secret_name"),
      body,
    ),
  "dependabot_secrets.remove": ({ state, param }) =>
    secretRemove(state.dependabot_secrets, state.dependabot_secret_digests, param("secret_name")),

  "codespaces_secrets.list": ({ state, query }) => secretsList(state.codespaces_secrets, query),
  "codespaces_secrets.publicKey": () =>
    ok({ key_id: MOCK_SECRETS_KEY_ID, key: MOCK_SECRETS_PUBLIC_KEY }),
  "codespaces_secrets.put": ({ state, param, body }) =>
    sealedSecretPut(
      state,
      state.codespaces_secrets,
      state.codespaces_secret_digests,
      param("secret_name"),
      body,
    ),
  "codespaces_secrets.remove": ({ state, param }) =>
    secretRemove(state.codespaces_secrets, state.codespaces_secret_digests, param("secret_name")),

  "agents_secrets.list": ({ state, query }) => secretsList(state.agents_secrets, query),
  "agents_secrets.publicKey": () =>
    ok({ key_id: MOCK_SECRETS_KEY_ID, key: MOCK_SECRETS_PUBLIC_KEY }),
  "agents_secrets.put": ({ state, param, body }) =>
    sealedSecretPut(
      state,
      state.agents_secrets,
      state.agents_secret_digests,
      param("secret_name"),
      body,
    ),
  "agents_secrets.remove": ({ state, param }) =>
    secretRemove(state.agents_secrets, state.agents_secret_digests, param("secret_name")),

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

  // code_scanning_default_setup -------------------------------------------
  "code_scanning_default_setup.get": ({ state }) => ok(state.code_scanning),
  "code_scanning_default_setup.update": ({ state, body }) => {
    // A configuration validation run already in progress: the PATCH answers 409
    // (a declared status the section tolerates and gives its own advice for),
    // and no change is applied. Flag set via live_state.code_scanning. This is
    // checked before the language/200-vs-202 rule so it can be triggered
    // independently.
    if (state.code_scanning.configuration_run_in_progress === true) {
      return { status: 409, body: { message: "A configuration run is already in progress" } };
    }
    // The PATCH answers 200 (synchronous) or 202 (async run started). Rule,
    // deterministic: when the payload changes `languages`, GitHub kicks off an
    // async configuration run and answers 202 with a run_id; otherwise it
    // applies synchronously and answers 200. This mirrors the real endpoint's
    // behavior (language changes trigger a rebuild) without nondeterminism.
    const payload = asObject(body);
    const changesLanguages =
      "languages" in payload &&
      JSON.stringify(payload.languages) !== JSON.stringify(state.code_scanning.languages);
    Object.assign(state.code_scanning, payload);
    if (changesLanguages) {
      return {
        status: 202,
        body: {
          run_id: state.nextId++,
          run_url: `https://api.github.com/repos/${ADMIN_SLUG}/code-scanning/default-setup/runs/1`,
        },
      };
    }
    // The spec's 200 response is an EMPTY object (additionalProperties: false):
    // a synchronous apply returns no body content. The 202 path (below) carries
    // {run_id, run_url}. State is still updated above; only the wire body is {}.
    return ok({});
  },

  // code_quality_setup ------------------------------------------------------
  "code_quality_setup.get": ({ state }) => ok(state.code_quality),
  "code_quality_setup.update": ({ state, body }) => {
    // Mirrors code_scanning_default_setup.update: the in-progress 409 flag
    // (set via live_state.code_quality) is checked first so a scenario can
    // trigger it independently, then the deterministic 200-vs-202 rule - a
    // `languages` change starts an async configuration run.
    if (state.code_quality.configuration_run_in_progress === true) {
      return { status: 409, body: { message: "A configuration run is already in progress" } };
    }
    const payload = asObject(body);
    const changesLanguages =
      "languages" in payload &&
      JSON.stringify(payload.languages) !== JSON.stringify(state.code_quality.languages);
    Object.assign(state.code_quality, payload);
    if (changesLanguages) {
      return {
        status: 202,
        body: {
          run_id: state.nextId++,
          run_url: `https://api.github.com/repos/${ADMIN_SLUG}/code-quality/setup/runs/1`,
        },
      };
    }
    // Like code-scanning's, the spec's 200 response is an EMPTY object
    // (additionalProperties: false); state is still updated above.
    return ok({});
  },

  // check_suite_preferences --------------------------------------------------
  "check_suite_preferences.update": ({ state, body }) => {
    // The one write-only endpoint: no GET exists, so the stored preferences
    // are visible only through this PATCH's echo ({preferences, repository}
    // per the spec's check-suite-preference schema).
    Object.assign(state.check_suite_preferences, asObject(body));
    return ok({
      preferences: state.check_suite_preferences,
      repository: restRepoSurface(state.repo),
    });
  },

  // collaborators ----------------------------------------------------------
  "collaborators.list": ({ state, query }) => ok(slicePage(state.collaborators, query)),
  "collaborators.update": ({ state, param, body }) => {
    const username = param("username");
    const existing = state.collaborators.find(
      (c) => String(c.login).toLowerCase() === username.toLowerCase(),
    );
    if (existing) {
      Object.assign(existing, collaboratorFromPut(username, asObject(body)));
      return noContent(); // 204: already a collaborator, access updated
    }
    // Matching real GitHub, a PUT for a non-collaborator does NOT grant
    // access: it creates (or refreshes) a pending invitation and answers 201
    // with the repository-invitation body, whose `permissions` is a STRING
    // (read/write/admin/...), not the collaborator role object. The user
    // joins state.collaborators only in a scenario that seeds them there.
    const pending = state.invitations.find(
      (i) =>
        String((i.invitee as Json | undefined)?.login).toLowerCase() === username.toLowerCase(),
    );
    if (pending) {
      pending.permissions = invitationPermissionFromPut(asObject(body));
      pending.expired = false; // a re-PUT refreshes the invitation
      return { status: 201, body: pending };
    }
    const stored = invitationFromPut(
      username,
      asObject(body),
      state.nextId++,
      state.repo,
      state.slug,
    );
    state.invitations.push(stored);
    return { status: 201, body: stored };
  },
  "collaborators.remove": ({ state, param }) => {
    const username = param("username");
    const index = state.collaborators.findIndex(
      (c) => String(c.login).toLowerCase() === username.toLowerCase(),
    );
    if (index >= 0) {
      state.collaborators.splice(index, 1);
    }
    return noContent();
  },
  "collaborators.listInvitations": ({ state, query }) => ok(slicePage(state.invitations, query)),
  "collaborators.updateInvitation": ({ state, param, body }) => {
    const id = param("invitation_id");
    const invitation = state.invitations.find((i) => String(i.id) === id);
    if (!invitation) {
      return { status: 404, body: { message: "Not Found" } };
    }
    // The PATCH speaks the invitation's own read vocabulary (read/write/...),
    // so the body's `permissions` is stored verbatim.
    const permissions = asObject(body).permissions;
    if (permissions !== undefined) {
      invitation.permissions = permissions;
    }
    return ok(invitation);
  },
  "collaborators.cancelInvitation": ({ state, param }) => {
    const id = param("invitation_id");
    const index = state.invitations.findIndex((i) => String(i.id) === id);
    if (index >= 0) {
      state.invitations.splice(index, 1);
    }
    return noContent();
  },

  // teams ------------------------------------------------------------------
  "teams.org": orgProbeHandler,
  "teams.probe": ({ state, param }) => {
    const slug = param("team_slug");
    const access = state.teams[slug];
    if (!access) {
      // The spec documents this 404 ("team does not have permission for the
      // repository") with NO response content, so the body is empty.
      return { status: 404, body: null };
    }
    // The repository media type makes this return the repo object with the
    // team's role_name folded in.
    return ok({ ...restRepoSurface(state.repo), role_name: access.role_name });
  },
  "teams.grant": ({ state, param, body }) => {
    const slug = param("team_slug");
    state.teams[slug] = teamRepoFromPut(asObject(body));
    return noContent();
  },

  // milestones: moved to src/sections/milestones/mock.ts

  // interaction limits -------------------------------------------------------
  "interaction_limits.get": ({ state }) =>
    // A literal empty object is GitHub's "no limit set" answer (the spec's
    // empty-object anyOf branch), never null or a 404. When the org-override
    // flag is set with no seeded limit, GitHub would report the org's limit,
    // so the mock derives one - an override with an empty GET is a live
    // state GitHub cannot produce.
    ok(
      state.interaction_limits ??
        (state.interaction_limits_org_override ? INTERACTION_ORG_LIMIT : {}),
    ),
  "interaction_limits.put": ({ state, body }) => {
    if (state.interaction_limits_org_override) {
      return INTERACTION_ORG_CONFLICT;
    }
    const payload = asObject(body);
    const expiry = typeof payload.expiry === "string" ? payload.expiry : "one_day";
    // GitHub stores limit/origin/expires_at only; the declared expiry
    // duration maps to a FIXED expires_at per value so repeat applies stay
    // byte-stable for the idempotence proof.
    state.interaction_limits = {
      limit: payload.limit,
      origin: "repository",
      expires_at: INTERACTION_EXPIRES[expiry] ?? INTERACTION_EXPIRES.one_day,
    };
    return ok(state.interaction_limits);
  },
  "interaction_limits.remove": ({ state }) => {
    if (state.interaction_limits_org_override) {
      return INTERACTION_ORG_CONFLICT;
    }
    state.interaction_limits = null;
    return noContent();
  },
  "interaction_limits.capGet": ({ state }) =>
    state.pull_creation_cap_unavailable ? CAP_UNAVAILABLE_405 : ok(state.pull_creation_cap),
  "interaction_limits.capPatch": ({ state, body }) => {
    if (state.pull_creation_cap_unavailable) {
      return CAP_UNAVAILABLE_405;
    }
    // The PATCH requires enabled and takes max_open_pull_requests optionally;
    // merging over the stored cap keeps the response's required max field.
    state.pull_creation_cap = { ...state.pull_creation_cap, ...asObject(body) };
    return ok(state.pull_creation_cap);
  },
  // The endpoint documents no pagination parameters, so the whole list is
  // served in one body, like GitHub.
  "interaction_limits.bypassList": ({ state }) => ok(state.pull_bypass_list),
  "interaction_limits.bypassAdd": ({ state, body }) => {
    // Adds the named logins to the list (case-insensitively deduped); never
    // a wholesale replace - the DELETE removes. The documented 100-user
    // total is enforced, so an add-before-remove regression 422s here.
    const additions = bypassLogins(body).filter(
      (login) => !state.pull_bypass_list.some((user) => sameLogin(user, login)),
    );
    if (state.pull_bypass_list.length + additions.length > 100) {
      return {
        status: 422,
        body: {
          message: "Validation Failed: the bypass list can only hold a maximum of 100 users",
        },
      };
    }
    for (const login of additions) {
      state.pull_bypass_list.push(bypassUser({ login }, state.nextId++));
    }
    return noContent();
  },
  "interaction_limits.bypassRemove": ({ state, body }) => {
    const logins = bypassLogins(body);
    state.pull_bypass_list = state.pull_bypass_list.filter(
      (user) => !logins.some((login) => sameLogin(user, login)),
    );
    return noContent();
  },

  // actions_variables --------------------------------------------------------
  "actions_variables.list": ({ state, query }) => {
    // The cap comes from the endpoint DECLARATION, the same single source
    // the client's page loop and the spec-derived pageSize sweep read - so
    // the mock can never clamp at a stale number the section stopped using.
    const page = slicePage(
      state.actions_variables,
      query,
      allEndpoints()["actions_variables.list"]?.pageSize,
    );
    return ok({ total_count: state.actions_variables.length, variables: page });
  },
  "actions_variables.create": ({ state, body }) => {
    const payload = asObject(body);
    // GitHub stores variable names uppercased regardless of how they are
    // entered (the variables naming rules; the spec examples show uppercase
    // names), so the stored GET shape carries the uppercase name. Payload
    // spread FIRST so passthrough fields the section sends (and later
    // subsetDiffs) are stored and read back; the canonical fields are then
    // normalized over them.
    const variable: Json = {
      ...payload,
      name: variableName(payload),
      value: payload.value ?? "",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    };
    state.actions_variables.push(variable);
    // The documented 201 body is an empty object.
    return { status: 201, body: {} };
  },
  "actions_variables.update": ({ state, param, body }) => {
    const name = param("name").toUpperCase();
    const variable = state.actions_variables.find((v) => String(v.name).toUpperCase() === name);
    if (!variable) {
      return { status: 404, body: { message: "Not Found" } };
    }
    const payload = asObject(body);
    if (typeof payload.name === "string") {
      variable.name = payload.name.toUpperCase();
    }
    if (payload.value !== undefined) {
      variable.value = payload.value;
    }
    // Passthrough fields update verbatim, mirroring the create path, so a
    // second apply's subsetDiff over them reads back what was written.
    for (const [key, value] of Object.entries(payload)) {
      if (VARIABLE_CANONICAL_KEYS.has(key)) {
        continue;
      }
      variable[key] = value;
    }
    return noContent();
  },
  "actions_variables.remove": ({ state, param }) => {
    const name = param("name").toUpperCase();
    const index = state.actions_variables.findIndex((v) => String(v.name).toUpperCase() === name);
    if (index < 0) {
      return { status: 404, body: { message: "Not Found" } };
    }
    state.actions_variables.splice(index, 1);
    return noContent();
  },

  // agents_variables ---------------------------------------------------------
  //
  // The Copilot agents variable store mirrors the actions_variables handlers
  // exactly: same GET shape, same uppercase-stored names, same 30-item page
  // cap read from the endpoint declaration.
  "agents_variables.list": ({ state, query }) => {
    const page = slicePage(
      state.agents_variables,
      query,
      allEndpoints()["agents_variables.list"]?.pageSize,
    );
    return ok({ total_count: state.agents_variables.length, variables: page });
  },
  "agents_variables.create": ({ state, body }) => {
    const payload = asObject(body);
    const variable: Json = {
      ...payload,
      name: variableName(payload),
      value: payload.value ?? "",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    };
    state.agents_variables.push(variable);
    // The documented 201 body is an empty object.
    return { status: 201, body: {} };
  },
  "agents_variables.update": ({ state, param, body }) => {
    const name = param("name").toUpperCase();
    const variable = state.agents_variables.find((v) => String(v.name).toUpperCase() === name);
    if (!variable) {
      return { status: 404, body: { message: "Not Found" } };
    }
    const payload = asObject(body);
    if (typeof payload.name === "string") {
      variable.name = payload.name.toUpperCase();
    }
    if (payload.value !== undefined) {
      variable.value = payload.value;
    }
    // Passthrough fields update verbatim, mirroring the create path, so a
    // second apply's subsetDiff over them reads back what was written.
    for (const [key, value] of Object.entries(payload)) {
      if (VARIABLE_CANONICAL_KEYS.has(key)) {
        continue;
      }
      variable[key] = value;
    }
    return noContent();
  },
  "agents_variables.remove": ({ state, param }) => {
    const name = param("name").toUpperCase();
    const index = state.agents_variables.findIndex((v) => String(v.name).toUpperCase() === name);
    if (index < 0) {
      return { status: 404, body: { message: "Not Found" } };
    }
    state.agents_variables.splice(index, 1);
    return noContent();
  },

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
  // (the shared orgProbeHandler stays bound under "teams.org" above until
  // the teams section moves)

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

  // secret_scanning_custom_patterns ------------------------------------------
  //
  // custom_pattern_version is real optimistic concurrency here: the mock
  // mints a fresh version on EVERY mutation (deterministic, from a per-state
  // counter) and both write handlers answer 412 on a stale one, so a section
  // that reuses a version across writes - instead of re-reading - fails a
  // single-threaded e2e run instead of only failing against real GitHub.
  // Two escapes, both spec-faithful: a PATCH may send version: null (the
  // body requires the key but marks it nullable - the no-concurrency form
  // the section uses for a version-less live pattern), and the bulk
  // DELETE's per-pattern version is OPTIONAL upstream (only pattern_id is
  // required) - the section sending versions whenever it HAS them is pinned
  // by its unit tests' payload assertions, not by this gate.
  "secret_scanning_custom_patterns.list": ({ state, query }) =>
    ok(slicePage(state.secret_scanning_patterns, query)),
  "secret_scanning_custom_patterns.create": ({ state, body }) => {
    const patterns = asObject(body).patterns;
    // An empty (or missing) patterns array is GitHub's documented 422; a
    // MISSING one is also how a request whose body never made it onto the
    // wire would look, so the bulk-DELETE/POST body transmission is proven
    // by this rejection arm staying cold in the curated scenarios.
    if (!Array.isArray(patterns) || patterns.length === 0) {
      return {
        status: 422,
        body: { message: "Validation failed: no patterns provided", validation_errors: {} },
      };
    }
    const created: Json[] = [];
    for (const [index, entry] of patterns.entries()) {
      const payload = asObject(entry);
      const name = String(payload.name ?? "");
      const duplicate =
        state.secret_scanning_patterns.some((p) => p.name === name) ||
        created.some((p) => p.name === name);
      if (duplicate) {
        // A duplicate name answers GitHub's per-index validation_errors map;
        // nothing is created (the section never POSTs a duplicate).
        return {
          status: 422,
          body: {
            message: "Validation failed for one or more patterns",
            validation_errors: {
              [String(index)]: {
                errors: [{ code: "name", message: `A pattern named "${name}" already exists` }],
              },
            },
          },
        };
      }
      created.push(secretScanningPatternFromCreate(state, payload));
    }
    state.secret_scanning_patterns.push(...created);
    return { status: 201, body: { created_patterns: created } };
  },
  "secret_scanning_custom_patterns.update": ({ state, param, body }) => {
    const id = param("pattern_id");
    const pattern = state.secret_scanning_patterns.find((p) => String(p.id) === id);
    if (!pattern) {
      // Existence first, like GitHub: an unknown id 404s before the version
      // is even compared.
      return { status: 404, body: { message: "Not Found" } };
    }
    const payload = asObject(body);
    // A null version skips the concurrency check (the body marks the key
    // required but nullable); a present string must match the stored one.
    if (
      payload.custom_pattern_version !== null &&
      payload.custom_pattern_version !== pattern.custom_pattern_version
    ) {
      return SECRET_SCANNING_STALE_VERSION;
    }
    // The endpoint requires at least one updatable field alongside the
    // version (the request schema's anyOf); a version-only body is GitHub's
    // 422, so a regression that stops sending fields fails e2e loudly.
    if (!SECRET_SCANNING_UPDATABLE_KEYS.some((key) => payload[key] !== undefined)) {
      return {
        status: 422,
        body: { message: "Validation failed: at least one updatable field must be provided" },
      };
    }
    for (const key of SECRET_SCANNING_UPDATABLE_KEYS) {
      if (payload[key] !== undefined) {
        pattern[key] = payload[key];
      }
    }
    pattern.custom_pattern_version = mintSecretScanningVersion(state);
    pattern.updated_at = "2026-07-02T00:00:00Z";
    return ok(pattern);
  },
  "secret_scanning_custom_patterns.remove": ({ state, body }) => {
    const payload = asObject(body);
    const entries = payload.patterns;
    if (!Array.isArray(entries) || entries.length === 0) {
      // The spec marks the body (and its patterns list) required; a missing
      // list is also what a DELETE whose body never transmitted would look
      // like, so this arm is the loud tripwire for that transport property.
      return { status: 400, body: { message: "Bad Request: no patterns provided" } };
    }
    const action = payload.post_delete_action;
    if (action !== undefined && action !== "delete_alerts" && action !== "resolve_alerts") {
      return {
        status: 400,
        body: { message: `Bad Request: unknown post_delete_action "${String(action)}"` },
      };
    }
    // Resolve and version-check EVERY entry before deleting ANY, so a stale
    // version can never half-delete the batch - GitHub documents the 412 for
    // the operation, not per pattern.
    const targets: Json[] = [];
    for (const entry of entries) {
      const request = asObject(entry);
      const pattern = state.secret_scanning_patterns.find(
        (p) => String(p.id) === String(request.pattern_id),
      );
      if (!pattern) {
        return { status: 404, body: { message: "Not Found" } };
      }
      if (
        request.custom_pattern_version !== undefined &&
        request.custom_pattern_version !== pattern.custom_pattern_version
      ) {
        return SECRET_SCANNING_STALE_VERSION;
      }
      targets.push(pattern);
    }
    state.secret_scanning_patterns = state.secret_scanning_patterns.filter(
      (p) => !targets.includes(p),
    );
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
  // repository ---------------------------------------------------------------
  // The two GraphQL-only repo settings, stored on state.repo but invisible to
  // every REST handler (restRepoSurface): the read serves both plus the repo's
  // canonical minted node id, the mutation resolves its target back through
  // the codec.
  "repository.featuresQuery": ({ state }) => ({
    data: { repository: { id: repoNodeId(state), ...repoFeatureFields(state) } },
  }),
  "repository.updateFeatures": ({ state, variables }) => {
    const { repositoryId, hasSponsorshipsEnabled, issueCreationPolicy } = variables as {
      repositoryId?: unknown;
      hasSponsorshipsEnabled?: unknown;
      issueCreationPolicy?: unknown;
    };
    // The pipeline already resolved the id to this state's slug; the family
    // is this handler's own concern - a decodable non-repo id (say an
    // environment's) would silently update the wrong resource, so it is a
    // loud mock failure instead.
    const decoded = decodeNodeId(String(repositoryId ?? ""));
    if (decoded?.family !== "repo") {
      throw new Error(
        `E2E MOCK: UpdateRepositoryFeatures got repositoryId of family "${String(decoded?.family)}", expected a repo node id`,
      );
    }
    if (typeof hasSponsorshipsEnabled === "boolean") {
      state.repo.has_sponsorships_enabled = hasSponsorshipsEnabled;
    }
    if (issueCreationPolicy === "ALL" || issueCreationPolicy === "COLLABORATORS_ONLY") {
      state.repo.issue_creation_policy = issueCreationPolicy;
    }
    return { data: { updateRepository: { repository: repoFeatureFields(state) } } };
  },
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
  { rest: autolinksMockHandlers },
  { rest: customPropertiesMockHandlers },
  { rest: labelsMockHandlers },
  { rest: milestonesMockHandlers },
  { rest: pagesMockHandlers },
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
