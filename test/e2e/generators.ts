/**
 * Fuzz generators for the e2e harness: random but valid-shaped settings per
 * section, random mock live state, and random whole scenarios. Everything is a
 * pure function of an Rng, so a failing fuzz iteration replays from its seed.
 *
 * Three-way drift detection: every settings document a generator produces is
 * also validated against the published lib/settings.schema.json with ajv. If a
 * generator emits something the schema rejects, either the generator or the
 * schema is wrong, and the fuzz run fails loudly rather than silently drifting.
 */

import { Ajv, type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";
import settingsSchema from "../../lib/settings.schema.json" with { type: "json" };
import {
  type MustBeNever,
  SECTION_KEYS,
  type SectionKey,
  UNDECLARED_POLICY_SECTIONS,
} from "../../src/schema.js";
import { undeclaredPolicy } from "../../src/sections/contract.js";
import { SECTIONS } from "../../src/sections/registry.js";
import type { LiveState } from "./mock/state.js";
import { CUSTOM_PROPERTY_DEFINITIONS, PROTECTION_RULE_APPS } from "./mock/state.js";
import type { Rng } from "./prng.js";
import {
  type DenialStyle,
  type MaskGrade,
  type MaskKey,
  type OwnerKind,
  MASK_KEYS as SCHEMA_MASK_KEYS,
  type Scenario,
} from "./schema.js";

type Json = Record<string, unknown>;

/** Either form a knobbed list section's generated value can take. */
type EntriesForm = Json[] | { undeclared?: "keep" | "delete"; entries: Json[] };

/**
 * Unwrap a generated section value into its entry list through the SAME
 * helper the engine uses, so harness code reads both the plain and the
 * wrapped form without hand-rolled casts. Entries come back by reference:
 * mutating them (or pushing into them) edits the generated document in
 * place, whichever form was drawn. The default policy is irrelevant here -
 * only the entries are read.
 */
function entriesOf(value: unknown): Json[] {
  return undeclaredPolicy(value as EntriesForm, "keep").entries as Json[];
}

/**
 * Sometimes rewrap a generated entry list in the `{undeclared, entries}`
 * form, so the fuzz corpus exercises the knob's parsing, merging, and
 * schema surface alongside the plain form. The policy draw is skewed toward
 * OMITTING `undeclared` (the wrapper alone), because with the mock's empty
 * live baselines an explicit policy changes no outcome - the delete/keep
 * behavior itself is pinned by curated scenarios (labels-undeclared-keep,
 * rulesets-undeclared-delete, milestones-undeclared-delete).
 *
 * The WITNESS sections (labels, milestones) must never call this: the
 * oracle refines their predictions from the seeded witness alone, so a
 * generated `undeclared: keep` over an extra-undeclared labels witness
 * would flip the engine's outcome (a kept note instead of drift/deletion)
 * and fail the iteration, and milestones' delete path has no witness
 * modeling it. New draws live on a forked stream so the pre-existing
 * main-stream sequence (and every recorded seed) stays stable.
 */
function maybeWrapUndeclared(rng: Rng, entries: Json[]): EntriesForm {
  const knobRng = rng.fork("undeclared-knob");
  if (!knobRng.bool(0.25)) {
    return entries;
  }
  return knobRng.bool(0.5)
    ? { undeclared: knobRng.pick(["keep", "delete"] as const), entries }
    : { entries };
}

/**
 * Hostile string pool for names that flow into URLs, step-summary cells, and
 * request paths: pipes and backslashes (summary-table escaping), quotes,
 * spaces, percent signs and slashes (URL encoding), unicode, and a near-limit
 * length. A generator that mixes these in exercises the escaping and encoding
 * paths that a tidy ASCII name would never reach.
 */
const HOSTILE_NAMES = [
  "plain",
  "with space",
  "with|pipe",
  'with"quote',
  "with\\backslash",
  "with%percent",
  "with/slash",
  "with#hash",
  "unicode-éñ中",
  "emoji-\u{1f600}",
  "a".repeat(48),
] as const;

const HEX_COLORS = ["d73a4a", "a2eeef", "ededed", "0e8a16", "ffffff", "000000"] as const;

/**
 * A fixed, valid age recipient for the `artifact` private-report channel:
 * enough for the action's config validation to accept the key and for the
 * encrypter to produce ciphertext. Generated once with age-encryption's own
 * generateX25519Identity/identityToRecipient (runner.test.ts re-validates it
 * against src's parseRecipient so it cannot silently rot), then pinned so
 * scenarios and the fuzzer share one hermetic recipient. The matching identity
 * is never needed: the harness never decrypts (the artifact upload fails with a
 * safe warning because the runner token is absent), it only proves the run
 * stays green and leaks nothing when a real key is configured.
 */
export const ARTIFACT_TEST_RECIPIENT =
  "age1wshulnlu6mpa4rx54w6xs9kscqw7uqem3fh748xsrfyqusgmfv2qfca3qt";

/** Fixed ISO due dates: a pool, never Date.now, so generation stays deterministic. */
const DUE_DATES = ["2026-01-15T00:00:00Z", "2026-06-30T00:00:00Z", "2026-12-31T00:00:00Z"] as const;

/** The four core branch-protection keys the classic PUT requires. */
const PROTECTION_CORE_KEYS = [
  "required_status_checks",
  "enforce_admins",
  "required_pull_request_reviews",
  "restrictions",
] as const;

/** A hostile-or-plain name, biased toward plain so most docs stay readable. */
function name(rng: Rng): string {
  return rng.bool(0.6)
    ? rng.pick(["bug", "chore", "docs", "feature", "infra"])
    : rng.pick(HOSTILE_NAMES);
}

// Per-section settings generators. Each returns a valid-shaped value for that
// section's SettingsFile property.

function genLabels(rng: Rng): Json[] {
  const count = rng.int(4) + 1;
  const used = new Set<string>();
  const labels: Json[] = [];
  for (let i = 0; i < count; i++) {
    let n = name(rng);
    while (used.has(n.toLowerCase())) {
      n = `${n}-${i}`;
    }
    used.add(n.toLowerCase());
    const label: Json = { name: n };
    if (rng.bool(0.8)) {
      label.color = rng.pick(HEX_COLORS);
    }
    if (rng.bool(0.5)) {
      label.description = rng.pick(["", "does a thing", name(rng)]);
    }
    labels.push(label);
  }
  // labels is a WITNESS section: always the plain array form, never
  // maybeWrapUndeclared (its rationale explains why).
  return labels;
}

function genRepository(rng: Rng): Json {
  const repo: Json = {};
  if (rng.bool()) {
    repo.has_issues = rng.bool();
  }
  if (rng.bool()) {
    repo.has_wiki = rng.bool();
  }
  if (rng.bool()) {
    repo.allow_merge_commit = rng.bool();
  }
  if (rng.bool(0.5)) {
    repo.topics = Array.from({ length: rng.int(3) + 1 }, () =>
      rng.pick(["automation", "governance", "settings", "infra"]),
    );
  }
  if (rng.bool(0.4)) {
    repo.enable_vulnerability_alerts = rng.bool();
  }
  if (rng.bool(0.3)) {
    repo.enable_git_lfs = rng.bool();
  }
  if (rng.bool(0.3)) {
    repo.enable_immutable_releases = rng.bool();
  }
  // Always leave at least one key so the section does real work.
  if (Object.keys(repo).length === 0) {
    repo.has_issues = rng.bool();
  }
  return repo;
}

function genRulesets(rng: Rng): EntriesForm {
  const entries = Array.from({ length: rng.int(2) + 1 }, (_, i) => {
    const target = rng.pick(["branch", "tag"] as const);
    return {
      name: `${rng.pick(["protect", "guard", "lock"])}-${i}`,
      target,
      enforcement: rng.pick(["active", "disabled", "evaluate"]),
      conditions: {
        ref_name: {
          include: [target === "tag" ? "~ALL" : "~DEFAULT_BRANCH"],
          exclude: [],
        },
      },
      rules: [{ type: rng.pick(["deletion", "non_fast_forward", "required_signatures"]) }],
    };
  });
  return maybeWrapUndeclared(rng, entries);
}

function genBranches(rng: Rng): Json[] {
  // The required_signatures draws are NEW, so they live on a forked stream:
  // the main stream stays stable and recorded seeds keep reproducing.
  const sigRng = rng.fork("required-signatures");
  return Array.from({ length: rng.int(2) + 1 }, (_, i) => {
    const name = `${rng.pick(["main", "release", "dev"])}-${i}`;
    if (rng.bool(0.3)) {
      return { name, protection: null };
    }
    // A random subset of the four core protection keys, with realistic values;
    // the handler null-fills the omitted ones, so any subset is valid input.
    const protection: Json = {};
    if (rng.bool(0.6)) {
      protection.required_pull_request_reviews = {
        required_approving_review_count: rng.int(3) + 1,
      };
    }
    if (rng.bool(0.5)) {
      protection.enforce_admins = rng.bool();
    }
    if (rng.bool(0.4)) {
      protection.required_status_checks = { strict: rng.bool(), contexts: [] };
    }
    if (rng.bool(0.3)) {
      protection.restrictions = null;
    }
    // Guarantee at least one core key so the payload is not empty.
    if (Object.keys(protection).length === 0) {
      const key = rng.pick(PROTECTION_CORE_KEYS);
      protection[key] = key === "enforce_admins" ? true : null;
    }
    if (sigRng.bool(0.3)) {
      protection.required_signatures = sigRng.bool();
    }
    return { name, protection };
  });
}

function genEnvironments(rng: Rng): Json[] {
  // The variables draws are NEW, so they live on a forked stream: the main
  // stream stays stable and recorded seeds keep reproducing.
  const variablesRng = rng.fork("variables");
  // The nested secrets draws are NEWER still, so they fork off their own
  // stream for the same reason.
  const secretsRng = rng.fork("secrets");
  // And the branch-policy pattern draws are the newest, on their own fork.
  const policiesRng = rng.fork("branch-policies");
  // Protection-rule draws, newer again, fork the same way.
  const rulesRng = rng.fork("protection-rules");
  return Array.from({ length: rng.int(2) + 1 }, (_, i) => {
    const env: Json = { name: `${rng.pick(["staging", "prod", "qa"])}-${i}` };
    if (rng.bool()) {
      env.wait_timer = rng.int(30);
    }
    if (rng.bool()) {
      env.prevent_self_review = rng.bool();
    }
    if (variablesRng.bool(0.35)) {
      // Names are unique per environment by the suffix even after the
      // case-insensitive uppercase match, and mixed-case picks exercise it.
      // The empty live baseline means an explicit `undeclared` policy would
      // change no outcome, so the wrapped draw omits it (the keep-note and
      // delete paths are pinned by curated scenarios); the bare `{entries}`
      // wrapper still exercises the nested knob's parsing and schema surface.
      const entries: Json[] = Array.from({ length: variablesRng.int(2) + 1 }, (_, j) => ({
        name: `${variablesRng.pick(["DEPLOY_REGION", "log_level", "Retries"])}_${j}`,
        value: variablesRng.pick(["eu-west-1", "debug", "3"]),
      }));
      env.variables = variablesRng.bool(0.25) ? { entries } : entries;
    }
    if (secretsRng.bool(0.3)) {
      // References come from the fixed pool, like every secret family, so
      // scenarioSecretEnv can wire the child env. Same-named secrets across
      // sibling environments are deliberately common here (the pool is
      // small): per-environment scope resolution is exactly what that
      // exercises.
      const names = Object.keys(E2E_SECRET_ENV);
      const count = secretsRng.int(names.length) + 1;
      const entries: Json[] = names.slice(0, count).map((name) => ({
        name,
        value: `$${name}`,
      }));
      env.secrets = secretsRng.bool(0.25) ? { entries } : entries;
    }
    if (policiesRng.bool(0.3)) {
      // The index suffix keeps names unique (the natural key is the exact
      // pattern string). The generator ALWAYS pairs the list with the
      // singular flag object set to custom_branch_policies: true, so the
      // oracle never sees the section's validation-error path.
      const entries: Json[] = Array.from({ length: policiesRng.int(2) + 1 }, (_, j) => {
        const entry: Json = { name: `${policiesRng.pick(["release/*", "hotfix/*", "v*"])}-${j}` };
        if (policiesRng.bool(0.4)) {
          entry.type = policiesRng.pick(["branch", "tag"]);
        }
        return entry;
      });
      env.deployment_branch_policies = policiesRng.bool(0.25) ? { entries } : entries;
      env.deployment_branch_policy = { protected_branches: false, custom_branch_policies: true };
    }
    if (rulesRng.bool(0.3)) {
      // App slugs come ONLY from the shared PROTECTION_RULE_APPS fixture (the
      // mock's available-Apps listing serves the same objects), so a declared
      // rule can always resolve and enable. The slice keeps slugs unique per
      // environment. The empty live baseline means an explicit `undeclared`
      // policy would change no outcome, so the wrapped draw omits it (the
      // keep-note and disable paths are pinned by curated scenarios).
      const slugs = PROTECTION_RULE_APPS.map((app) => String(app.slug));
      const count = rulesRng.int(slugs.length) + 1;
      const entries: Json[] = slugs.slice(0, count).map((slug) => ({ app: slug }));
      env.deployment_protection_rules = rulesRng.bool(0.25) ? { entries } : entries;
    }
    return env;
  });
}

function genAutolinks(rng: Rng): EntriesForm {
  const entries = Array.from({ length: rng.int(2) + 1 }, (_, i) => ({
    key_prefix: `${rng.pick(["JIRA", "TICKET", "REF"])}-${i}-`,
    url_template: `https://example.com/browse/<num>?ref=${i}`,
    is_alphanumeric: rng.bool(),
  }));
  return maybeWrapUndeclared(rng, entries);
}

function genActions(rng: Rng): Json {
  // oidc_customization_sub is deliberately NEVER generated here: its
  // endpoints carry a per-endpoint permission override (Actions instead of
  // Administration) that the fuzz oracle's section-level PERMISSION_BY_KEY
  // model cannot grade, so any masked iteration declaring it would
  // mispredict the outcome. Curated scenarios (actions-oidc-*) cover the
  // key, including both denial directions. If a second mixed-permission
  // section ever appears, model per-endpoint requirements in the oracle
  // instead of widening this exclusion.
  const actions: Json = {};
  if (rng.bool()) {
    actions.default_workflow_permissions = rng.pick(["read", "write"]);
  }
  if (rng.bool()) {
    actions.can_approve_pull_request_reviews = rng.bool();
  }
  // Coupling: selected_actions only applies under allowed_actions "selected".
  if (rng.bool(0.5)) {
    actions.allowed_actions = "selected";
    actions.selected_actions = {
      github_owned_allowed: rng.bool(),
      verified_allowed: rng.bool(),
      patterns_allowed: [`${rng.pick(["actions", "octo"])}/*`],
    };
  } else if (rng.bool()) {
    actions.allowed_actions = rng.pick(["all", "local_only"]);
  }
  if (rng.bool(0.3)) {
    actions.access_level = rng.pick(["none", "user", "organization"]);
  }
  if (rng.bool(0.3)) {
    actions.artifact_and_log_retention = { days: rng.int(400) + 1 };
  }
  if (rng.bool(0.3)) {
    const cache: Json = {};
    if (rng.bool()) {
      cache.max_cache_retention_days = rng.int(14) + 1;
    }
    if (rng.bool() || Object.keys(cache).length === 0) {
      cache.max_cache_size_gb = rng.int(50) + 1;
    }
    actions.cache = cache;
  }
  if (Object.keys(actions).length === 0) {
    actions.default_workflow_permissions = rng.pick(["read", "write"]);
  }
  // The fork PR policy keys are NEW draws appended after the original body,
  // each on its own forked stream, so pre-existing seeds keep producing the
  // same document above (the seed-stability convention; see genCodeScanning).
  const approvalRng = rng.fork("fork-pr-approval");
  if (approvalRng.bool(0.3)) {
    actions.fork_pr_contributor_approval = {
      approval_policy: approvalRng.pick([
        "first_time_contributors_new_to_github",
        "first_time_contributors",
        "all_external_contributors",
      ]),
    };
  }
  const privateReposRng = rng.fork("fork-pr-private");
  if (privateReposRng.bool(0.3)) {
    // The shape requires the COMPLETE policy (GitHub does not document
    // whether the PUT preserves an omitted toggle), so every draw carries
    // all four booleans.
    actions.fork_pr_workflows_private_repos = {
      run_workflows_from_fork_pull_requests: privateReposRng.bool(),
      send_write_tokens_to_workflows: privateReposRng.bool(),
      send_secrets_and_variables: privateReposRng.bool(),
      require_approval_for_fork_pr_workflows: privateReposRng.bool(),
    };
  }
  return actions;
}

function genWorkflows(rng: Rng): Json[] {
  return Array.from({ length: rng.int(2) + 1 }, (_, i) => ({
    path: `.github/workflows/${rng.pick(["ci", "release", "lint"])}-${i}.yml`,
    state: rng.pick(["active", "disabled"] as const),
  }));
}

/**
 * The secret sections' entries draw their `$NAME` references from
 * E2E_SECRET_ENV, the ONE fixed name -> plaintext pool shared with webhook
 * secrets; scenarioSecretEnv() builds the scenario `env` from the same map,
 * so a generated reference can never name a variable the child env lacks.
 * Shared by the three repository-level secret families - their settings
 * shapes are identical.
 */
function genSecretEntries(rng: Rng): EntriesForm {
  const names = Object.keys(E2E_SECRET_ENV);
  const count = rng.int(names.length) + 1;
  const entries = names.slice(0, count).map((name) => ({
    name,
    value: `$${name}`,
  })) as Json[];
  return maybeWrapUndeclared(rng, entries);
}

function genPages(rng: Rng): Json | null {
  if (rng.bool(0.25)) {
    return null;
  }
  // source is required to CREATE Pages (the POST body must carry it), and the
  // generator never seeds Pages into live state, so every Pages scenario is a
  // create - always emit source. Other fields are optional extras.
  const pages: Json = {
    source: { branch: rng.pick(["main", "gh-pages"]), path: rng.pick(["/", "/docs"]) },
  };
  if (rng.bool(0.4)) {
    pages.https_enforced = rng.bool();
  }
  return pages;
}

/**
 * The code-scanning default-setup languages the real API accepts (the enum from
 * GitHub's OpenAPI). The published settings schema is looser, but the mock
 * validates the PATCH request body against the real spec, so the generator must
 * emit only these canonical values.
 */
const CODE_SCANNING_LANGUAGES = [
  "actions",
  "c-cpp",
  "csharp",
  "go",
  "java-kotlin",
  "javascript-typescript",
  "python",
  "ruby",
  "swift",
] as const;

function genCodeScanning(rng: Rng): Json {
  const cfg: Json = { state: rng.pick(["configured", "not-configured"]) };
  if (rng.bool()) {
    cfg.query_suite = rng.pick(["default", "extended"]);
  }
  // threat_model occupies the draw slots of the duplicated query_suite
  // branch it replaced (same bool threshold, same two-way pick), so every
  // draw after it in this function is byte-identical across the swap.
  if (rng.bool()) {
    cfg.threat_model = rng.pick(["remote", "remote_and_local"]);
  }
  // The runner fields are NEW draws, so they live on a forked stream: the
  // main stream stays stable and recorded seeds keep reproducing.
  const runnerRng = rng.fork("runner");
  if (runnerRng.bool(0.3)) {
    cfg.runner_type = runnerRng.pick(["standard", "labeled"] as const);
    if (cfg.runner_type === "labeled") {
      // runner_label pairs with the labeled runner type (schema.ts).
      cfg.runner_label = "e2e-runner";
    }
  }
  if (rng.bool(0.5)) {
    cfg.languages = Array.from({ length: rng.int(3) + 1 }, () => rng.pick(CODE_SCANNING_LANGUAGES));
  }
  return cfg;
}

function genCollaborators(rng: Rng): EntriesForm {
  const used = new Set<string>();
  const out: Json[] = [];
  const count = rng.int(3) + 1;
  for (let i = 0; i < count; i++) {
    const username = `${rng.pick(["octocat", "hubot", "dev"])}-${i}`;
    if (used.has(username.toLowerCase())) {
      continue;
    }
    used.add(username.toLowerCase());
    out.push({ username, permission: rng.pick(["pull", "push", "maintain", "admin"]) });
  }
  return maybeWrapUndeclared(rng, out);
}

function genTeams(rng: Rng): Json[] {
  return Array.from({ length: rng.int(2) + 1 }, (_, i) => ({
    name: `${rng.pick(["core", "reviewers", "ops"])}-${i}`,
    permission: rng.pick(["pull", "push", "maintain", "admin"]),
  }));
}

function genMilestones(rng: Rng): Json[] {
  const used = new Set<string>();
  const out: Json[] = [];
  const count = rng.int(3) + 1;
  for (let i = 0; i < count; i++) {
    const title = `${rng.pick(["v1", "v2", "backlog"])}-${i}`;
    if (used.has(title)) {
      continue;
    }
    used.add(title);
    const m: Json = { title };
    if (rng.bool()) {
      m.description = rng.pick(["", "the milestone", name(rng)]);
    }
    if (rng.bool()) {
      m.state = rng.pick(["open", "closed"]);
    }
    if (rng.bool(0.4)) {
      m.due_on = rng.pick(DUE_DATES);
    }
    out.push(m);
  }
  // milestones is a WITNESS section: always the plain array form, never
  // maybeWrapUndeclared (its rationale explains why).
  return out;
}

function genInteractionLimits(rng: Rng): Json | null {
  // null (a clear) is a first-class declared value, like pages: null.
  if (rng.bool(0.2)) {
    return null;
  }
  const limits: Json = {
    limit: rng.pick(["existing_users", "contributors_only", "collaborators_only"]),
  };
  if (rng.bool()) {
    limits.expiry = rng.pick(["one_day", "three_days", "one_week", "one_month", "six_months"]);
  }
  return limits;
}

function genActionsVariables(rng: Rng): EntriesForm {
  const used = new Set<string>();
  const out: Json[] = [];
  const count = rng.int(3) + 1;
  for (let i = 0; i < count; i++) {
    // Names obey GitHub's variable naming rules (alphanumeric/underscore); the
    // index suffix keeps them unique under the case-insensitive key. A draw
    // sometimes lowercases the declared name, so the fuzz corpus exercises the
    // case-insensitive match against the uppercase-stored live name.
    let name = `${rng.pick(["DEPLOY_REGION", "BUILD_MODE", "LOG_LEVEL", "FEATURE_FLAG"])}_${i}`;
    if (rng.bool(0.3)) {
      name = name.toLowerCase();
    }
    if (used.has(name.toUpperCase())) {
      continue;
    }
    used.add(name.toUpperCase());
    out.push({ name, value: rng.pick(["us-east-1", "production", "debug", "on", "42"]) });
  }
  return maybeWrapUndeclared(rng, out);
}

/**
 * The ONE fixed pool secret references draw from, name -> plaintext: webhook
 * config.secret and actions_secrets values alike. Single-sourced: the
 * generators draw `$NAME` references from these keys and scenarioSecretEnv()
 * (below) builds the scenario `env` from the same map, so a generated
 * reference can never name a variable the child env lacks. The values are
 * distinctive strings so leak checks can hunt them.
 */
export const E2E_SECRET_ENV = {
  E2E_SECRET_A: "e2e-hook-secret-alpha",
  E2E_SECRET_B: "e2e-hook-secret-bravo",
  E2E_SECRET_C: "e2e-hook-secret-charlie",
} as const;

/** The whole-value references the webhook generator draws from. */
const E2E_SECRET_REFS = Object.keys(E2E_SECRET_ENV).map((name) => `$${name}`);

function genWebhooks(rng: Rng): EntriesForm {
  const count = rng.int(2) + 1;
  const entries: Json[] = Array.from({ length: count }, (_, i) => {
    const config: Json = {
      url: `https://hooks.example.com/${rng.pick(["ci", "deploy", "notify"])}-${i}`,
    };
    if (rng.bool(0.6)) {
      config.content_type = rng.pick(["json", "form"]);
    }
    // Both spellings on purpose: GitHub stores insecure_ssl as a string, so
    // a declared number exercises the compare-side normalization.
    if (rng.bool(0.4)) {
      config.insecure_ssl = rng.pick(["0", "1", 0, 1] as const);
    }
    if (rng.bool(0.4)) {
      config.secret = rng.pick(E2E_SECRET_REFS);
    }
    const hook: Json = { config };
    if (rng.bool(0.6)) {
      hook.events = [
        ...new Set(
          Array.from({ length: rng.int(2) + 1 }, () =>
            rng.pick(["push", "pull_request", "issues", "release"]),
          ),
        ),
      ];
    }
    if (rng.bool(0.5)) {
      hook.active = rng.bool();
    }
    return hook;
  });
  return maybeWrapUndeclared(rng, entries);
}

/**
 * Custom property values, drawn ONLY from CUSTOM_PROPERTY_DEFINITIONS (the
 * mock's org-level definition fixture, shared with the values PATCH handler)
 * with type-appropriate values, so a generated declaration never trips the
 * undefined-property 422 the oracle does not model. A small null draw
 * exercises the unset path (a declared null over an empty live baseline is
 * simply already-converged).
 */
function genCustomProperties(rng: Rng): EntriesForm {
  const entries: Json[] = [];
  for (const definition of CUSTOM_PROPERTY_DEFINITIONS) {
    if (!rng.bool(0.6)) {
      continue;
    }
    let value: Json[keyof Json];
    if (rng.bool(0.15)) {
      value = null;
    } else if (definition.value_type === "string") {
      value = rng.pick(["platform", "payments", "infra"]);
    } else if (definition.value_type === "true_false") {
      // Both spellings on purpose: a declared boolean must normalize to the
      // "true"/"false" string GitHub stores.
      value = rng.pick([true, false, "true", "false"] as const);
    } else {
      const allowed = [...(definition.allowed_values ?? [])];
      const picked = allowed.slice(0, rng.int(allowed.length) + 1);
      // Sometimes reversed: multi_select compares order-insensitively.
      value = rng.bool(0.5) ? picked : picked.reverse();
    }
    entries.push({ property_name: definition.property_name, value });
  }
  if (entries.length === 0) {
    const definition = rng.pick(
      CUSTOM_PROPERTY_DEFINITIONS.filter((d) => d.value_type === "string"),
    );
    entries.push({ property_name: definition.property_name, value: "platform" });
  }
  return maybeWrapUndeclared(rng, entries);
}

/**
 * The fixed pool deploy-key entries draw from: plausible
 * "algorithm blob comment" strings whose blobs are DISTINCT (GitHub rejects a
 * reused public key with a 422, account-wide, and the mock mirrors that per
 * repo). The comments are load-bearing for the corpus: the mock strips them on
 * storage the way GitHub normalizes stored material, so a converging apply
 * proves the section compares algorithm + blob, not the raw string.
 */
const DEPLOY_KEY_POOL = [
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIE2e2eFuzzAlphaAlphaAlphaAlphaAlphaAlphaAlph deploy@alpha",
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIE2e2eFuzzBravoBravoBravoBravoBravoBravoBrav deploy@bravo",
  "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQCe2eFuzzCharlieCharlieCharlieCharlieCharlie deploy@charlie",
  "ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTZAAAAIbmlzdHAyNTYAAABBBe2e deploy@delta",
] as const;

function genDeployKeys(rng: Rng): EntriesForm {
  // Distinct keys AND distinct titles per document: the pool is sliced, never
  // sampled with replacement, because a duplicated blob 422s on create and a
  // duplicated title is rejected by the section's own duplicate check.
  const count = rng.int(DEPLOY_KEY_POOL.length) + 1;
  const entries: Json[] = DEPLOY_KEY_POOL.slice(0, count).map((key, i) => {
    const entry: Json = { title: `deploy-${rng.pick(["bot", "ci", "mirror"])}-${i}`, key };
    if (rng.bool(0.5)) {
      entry.read_only = rng.bool();
    }
    return entry;
  });
  return maybeWrapUndeclared(rng, entries);
}

/** The top-level sections whose entries are {name, value: $NAME} secret lists. */
const SECRET_LIST_SECTIONS = [
  "actions_secrets",
  "dependabot_secrets",
  "codespaces_secrets",
] as const satisfies readonly SectionKey[];

/**
 * The child-env half of any `$NAME` secret references a generated settings
 * document declares - webhook config.secret, the three repository secret
 * sections, and every environment entry's nested secrets - drawn from
 * E2E_SECRET_ENV (the same pool the generators pick from). Undefined when
 * the document declares none, so secret-free scenarios stay byte-identical.
 * A reference outside the pool is a generator bug and throws.
 */
export function scenarioSecretEnv(settings: Json): Record<string, string> | undefined {
  const env: Record<string, string> = {};
  let found = false;
  const collect = (reference: unknown): void => {
    if (typeof reference !== "string") {
      return;
    }
    const name = reference.slice(1);
    const value = E2E_SECRET_ENV[name as keyof typeof E2E_SECRET_ENV];
    if (value === undefined) {
      throw new Error(`BUG: generated secret reference ${reference} is not in the fixed pool`);
    }
    env[name] = value;
    found = true;
  };
  if (settings.webhooks !== undefined && settings.webhooks !== null) {
    for (const entry of entriesOf(settings.webhooks)) {
      collect((entry.config as Json | undefined)?.secret);
    }
  }
  for (const key of SECRET_LIST_SECTIONS) {
    if (settings[key] !== undefined && settings[key] !== null) {
      for (const entry of entriesOf(settings[key])) {
        collect(entry.value);
      }
    }
  }
  if (Array.isArray(settings.environments)) {
    for (const entry of settings.environments as Json[]) {
      if (entry.secrets !== undefined && entry.secrets !== null) {
        for (const secret of entriesOf(entry.secrets)) {
          collect(secret.value);
        }
      }
    }
  }
  return found ? env : undefined;
}

/**
 * Strip secret references from one generated settings document. A multi-repo
 * target's settings.yml is fetched from the TARGET repository, where a
 * `$NAME` reference is refused by design (target provenance must not read
 * the operator's environment) - so the multi generator never declares one
 * there: webhook entries lose their config.secret, the three repository
 * secret sections (whose values are ALWAYS references) are removed outright,
 * and every environment entry loses its nested secrets list. Mutates the
 * document in place through entriesOf's by-reference entries.
 */
export function stripSecretReferences(settings: Json): void {
  const webhooks = settings.webhooks;
  if (webhooks !== undefined && webhooks !== null) {
    for (const entry of entriesOf(webhooks)) {
      const config = entry.config as Json | undefined;
      if (config !== undefined) {
        delete config.secret;
      }
    }
  }
  for (const key of SECRET_LIST_SECTIONS) {
    delete settings[key];
  }
  if (Array.isArray(settings.environments)) {
    for (const entry of settings.environments as Json[]) {
      delete entry.secrets;
    }
  }
}

/**
 * Strip every environment entry's `deployment_branch_policies` AND
 * `deployment_protection_rules` keys when the drawn mask constrains the
 * permissions their endpoints carry as PER-ENDPOINT overrides (Actions read
 * for the list reads, Administration for the available-Apps read and the
 * writes - the same two resources gate both nested families). The fuzz
 * oracle grades permissions at SECTION level (PERMISSION_BY_KEY), so a
 * masked iteration keeping either key would be mispredicted - the same
 * reason genActions never emits oidc_customization_sub. Unlike the OIDC
 * key, these ARE generated: the strip fires only under a constraining mask,
 * so fully-granted iterations (including the convergence and idempotence
 * proofs) still exercise them, and the curated environment-*-denied
 * scenarios pin the denied paths. Stripping consumes no draws, so the main
 * stream stays stable. The paired singular flag stays: it rides the
 * environment PUT under the section's own permission.
 */
export function suppressMaskedEnvironmentOverrides(
  settings: Json,
  mask: Partial<Record<MaskKey, MaskGrade>>,
): void {
  const actionsDenied = (mask.actions ?? "write") === "none";
  const administrationBelowWrite = (mask.administration ?? "write") !== "write";
  if (!actionsDenied && !administrationBelowWrite) {
    return;
  }
  if (!Array.isArray(settings.environments)) {
    return;
  }
  for (const entry of settings.environments as Json[]) {
    delete entry.deployment_branch_policies;
    delete entry.deployment_protection_rules;
  }
}

/**
 * Strip a declared `custom_properties` section when the drawn mask denies the
 * custom_properties resource OUTRIGHT. The section's reads are
 * permission-"none" (the values GET is Metadata-gated only, the org probe is
 * public), so they can never be denied - but the oracle's grade-none fold
 * assumes a denied section's READ is deniable (under the 403 style it
 * predicts a preflight denial that cannot happen). A "read" grade stays: the
 * reads pass and the PATCH is denied mid-apply, which the "absent" semantics
 * model exactly. The curated custom-properties-write-denied scenario pins
 * the denial path this strip removes from the random stream. When the
 * section is the ONLY one declared, the mask entry is softened to "read"
 * instead, so the scenario never degenerates to an empty settings document.
 * The strip itself consumes no draws and generation stays deterministic per
 * seed - but it DOES shorten the section list, and later per-element draws
 * (requiredSections, the allowlist roll) walk that list, so draw alignment
 * between a stripped and an unstripped run of the same seed is NOT
 * preserved. That is fine: the strip is itself a pure function of the
 * seed's own mask roll, so every replay of a seed strips identically.
 */
export function suppressMaskedCustomProperties(
  settings: Json,
  mask: Partial<Record<MaskKey, MaskGrade>>,
  sections: SectionKey[],
): void {
  if ((mask.custom_properties ?? "write") !== "none" || settings.custom_properties === undefined) {
    return;
  }
  if (sections.length > 1) {
    delete settings.custom_properties;
    sections.splice(sections.indexOf("custom_properties"), 1);
  } else {
    mask.custom_properties = "read";
  }
}

/**
 * Names and regexes come from small fixed pools (the index suffix keeps
 * names unique under the exact-name natural key); delimiters and the
 * must_match/must_not_match extras ride along occasionally so the optional
 * fields are exercised. The regexes are inert strings to this action
 * (passthrough), so simple realistic shapes are enough.
 */
function genSecretScanningPatterns(rng: Rng): EntriesForm {
  const entries: Json[] = Array.from({ length: rng.int(3) + 1 }, (_, i) => {
    const entry: Json = {
      name: `${rng.pick(["internal-api-token", "staging-key", "vendor-secret", "license-key"])}-${i}`,
      pattern: rng.pick(["int_[a-z0-9]{8}", "key-[0-9]{6}", "tok_[A-Za-z0-9]{12}"]),
    };
    if (rng.bool(0.3)) {
      entry.start_delimiter = "\\b";
    }
    if (rng.bool(0.3)) {
      entry.end_delimiter = rng.pick(["\\b", "\\z"]);
    }
    if (rng.bool(0.2)) {
      entry.must_match = ["^prefix_prod"];
    }
    if (rng.bool(0.2)) {
      entry.must_not_match = ["test", "example"];
    }
    return entry;
  });
  return maybeWrapUndeclared(rng, entries);
}

const SETTINGS_GENERATORS: Record<SectionKey, (rng: Rng) => unknown> = {
  repository: genRepository,
  labels: genLabels,
  rulesets: genRulesets,
  branches: genBranches,
  environments: genEnvironments,
  autolinks: genAutolinks,
  actions: genActions,
  actions_secrets: genSecretEntries,
  dependabot_secrets: genSecretEntries,
  codespaces_secrets: genSecretEntries,
  workflows: genWorkflows,
  pages: genPages,
  code_scanning_default_setup: genCodeScanning,
  collaborators: genCollaborators,
  teams: genTeams,
  milestones: genMilestones,
  interaction_limits: genInteractionLimits,
  actions_variables: genActionsVariables,
  webhooks: genWebhooks,
  custom_properties: genCustomProperties,
  deploy_keys: genDeployKeys,
  secret_scanning_custom_patterns: genSecretScanningPatterns,
};

/** A valid-shaped settings value for one section. */
export function genSettings(rng: Rng, key: SectionKey): unknown {
  return SETTINGS_GENERATORS[key](rng);
}

/**
 * How a section's seeded live state relates to its declared settings, as a
 * SEMANTIC WITNESS the oracle can predict from exactly:
 *
 * - "matching": the live state mirrors EVERY field the handler diffs, so a
 *   correct engine reports exactly clean (check) or a no-op applied (apply).
 * - "drift-update": one DECLARED field diverges (never an omitted optional -
 *   a divergent value in a field the settings do not declare is not drift),
 *   so check must report drift and apply must issue an update.
 * - "extra-undeclared" (labels only): a live label the settings do not
 *   declare, so check reports undeclared drift and apply DELETEs it.
 *   Milestones keep undeclared entries by default, and their wrapped
 *   `undeclared: delete` path is pinned by a curated scenario
 *   (milestones-undeclared-delete) rather than a witness kind, so this
 *   kind is never generated for them.
 */
export type LiveWitnessKind = "matching" | "drift-update" | "extra-undeclared";

/**
 * The sections the witness generator models. Repository is deferred: a
 * faithful matching witness needs normalized topics, the enable_* toggles,
 * and fixture-aware treatment of absent fields.
 */
export const WITNESS_SECTIONS = ["labels", "milestones"] as const;
export type WitnessSection = (typeof WITNESS_SECTIONS)[number];

/** The witness kinds each modeled section supports. */
export const WITNESS_KINDS: Record<WitnessSection, readonly LiveWitnessKind[]> = {
  labels: ["matching", "drift-update", "extra-undeclared"],
  milestones: ["matching", "drift-update"],
};

/** Perturbation color: absent from HEX_COLORS, so it always reads as drift. */
const DRIFT_COLOR = "123456";
/** Perturbation description: absent from every description pool. */
const DRIFT_DESCRIPTION = "witness-drift";
/** The extra-undeclared live label; no generated name collides with it. */
const UNDECLARED_LABEL: Json = {
  name: "zz-undeclared-witness",
  color: "cccccc",
  description: "live label the settings never declare",
};

/** A generated live-state witness: the kind that actually holds, plus state. */
export interface LiveWitness {
  /**
   * The kind the state actually witnesses. May fall back to "matching" when
   * "drift-update" was requested but no entry declares a perturbable field.
   */
  kind: LiveWitnessKind;
  state: LiveState;
}

/**
 * Loud disjointness guard: a perturbation sentinel that collides with a
 * generated value would silently turn a drift witness into a matching one
 * (or an "undeclared" label into a declared one), so the collision throws
 * instead of degrading the witness.
 */
function assertSentinelDisjoint(condition: boolean, detail: string): void {
  if (!condition) {
    throw new Error(`witness sentinel collision: ${detail}`);
  }
}

/**
 * A live label body that the labels handler diffs as EXACTLY equal
 * (src/sections/labels.ts): the live label carries the FINAL name (new_name
 * wins - the handler matches by source or target key and treats any other
 * live name as rename drift), the declared color/description verbatim (they
 * are diffed only when DECLARED, so undeclared ones take fixed fillers), and
 * every extra declared key verbatim (extras are subsetDiffed as passthrough
 * fields, so a hardcoded field list would silently read as drift).
 */
function matchingLiveLabel(label: Json): Json {
  const { name, new_name, color, description, ...extras } = label;
  return {
    name: new_name ?? name,
    color: color ?? "ededed",
    description: description ?? null,
    ...extras,
  };
}

/**
 * True when uppercasing changes the name but keeps its case-insensitive key,
 * so the flipped live name still matches the declared label and the handler
 * reads it as rename drift (existing.name !== finalName).
 */
function caseFlippable(name: string): boolean {
  const flipped = name.toUpperCase();
  return flipped !== name && flipped.toLowerCase() === name.toLowerCase();
}

/**
 * The fields of one declared label a drift-update witness may perturb. The
 * name candidate flips the case of the FINAL name (new_name resolved), so the
 * divergence reads as rename drift against the post-rename state.
 */
function labelDriftFields(label: Json): Array<"color" | "description" | "name"> {
  const fields: Array<"color" | "description" | "name"> = [];
  if (label.color !== undefined) {
    fields.push("color");
  }
  if (label.description !== undefined) {
    fields.push("description");
  }
  if (caseFlippable(String(label.new_name ?? label.name))) {
    fields.push("name");
  }
  return fields;
}

function labelsWitness(rng: Rng, declared: Json[], kind: LiveWitnessKind): LiveWitness {
  const labels = declared.map(matchingLiveLabel);
  if (kind === "matching") {
    return { kind, state: { labels } };
  }
  if (kind === "extra-undeclared") {
    const undeclaredKey = String(UNDECLARED_LABEL.name).toLowerCase();
    for (const label of declared) {
      assertSentinelDisjoint(
        String(label.name).toLowerCase() !== undeclaredKey &&
          String(label.new_name ?? label.name).toLowerCase() !== undeclaredKey,
        `a declared label resolves to the undeclared sentinel "${undeclaredKey}"`,
      );
    }
    return { kind, state: { labels: [...labels, { ...UNDECLARED_LABEL }] } };
  }
  const eligible = declared
    .map((label, index) => ({ index, fields: labelDriftFields(label) }))
    .filter((entry) => entry.fields.length > 0);
  if (eligible.length === 0) {
    return { kind: "matching", state: { labels } };
  }
  const { index, fields } = rng.pick(eligible);
  const source = declared[index] as Json;
  const live = labels[index] as Json;
  const field = rng.pick(fields);
  if (field === "color") {
    assertSentinelDisjoint(
      source.color !== DRIFT_COLOR,
      `the label color pool contains ${DRIFT_COLOR}`,
    );
    live.color = DRIFT_COLOR;
  } else if (field === "description") {
    assertSentinelDisjoint(
      source.description !== DRIFT_DESCRIPTION,
      `the label description pool contains "${DRIFT_DESCRIPTION}"`,
    );
    live.description = DRIFT_DESCRIPTION;
  } else {
    live.name = String(source.new_name ?? source.name).toUpperCase();
  }
  return { kind: "drift-update", state: { labels } };
}

/**
 * A live milestone body the milestones handler diffs as EXACTLY equal
 * (src/sections/milestones.ts): the handler subsetDiffs EVERY declared field
 * verbatim, passthrough fields included, so the whole declaration is spread
 * over the handler-visible defaults - a future passthrough field is mirrored
 * automatically instead of silently reading as drift.
 */
function matchingLiveMilestone(milestone: Json, index: number): Json {
  return {
    id: 910_000 + index,
    number: index + 1,
    state: "open",
    description: null,
    ...milestone,
  };
}

/** The fields of one declared milestone a drift-update witness may perturb. */
function milestoneDriftFields(milestone: Json): Array<"description" | "state" | "due_on"> {
  const fields: Array<"description" | "state" | "due_on"> = [];
  if (milestone.description !== undefined) {
    fields.push("description");
  }
  if (milestone.state !== undefined) {
    fields.push("state");
  }
  if (milestone.due_on !== undefined) {
    fields.push("due_on");
  }
  return fields;
}

function milestonesWitness(rng: Rng, declared: Json[], kind: LiveWitnessKind): LiveWitness {
  const milestones = declared.map(matchingLiveMilestone);
  if (kind === "matching") {
    return { kind, state: { milestones } };
  }
  const eligible = declared
    .map((milestone, index) => ({ index, fields: milestoneDriftFields(milestone) }))
    .filter((entry) => entry.fields.length > 0);
  if (eligible.length === 0) {
    // Every milestone declares only its title: no field can legitimately
    // diverge, so the witness degrades to matching (and says so).
    return { kind: "matching", state: { milestones } };
  }
  const { index, fields } = rng.pick(eligible);
  const source = declared[index] as Json;
  const live = milestones[index] as Json;
  const field = rng.pick(fields);
  if (field === "description") {
    assertSentinelDisjoint(
      source.description !== DRIFT_DESCRIPTION,
      `the milestone description pool contains "${DRIFT_DESCRIPTION}"`,
    );
    live.description = DRIFT_DESCRIPTION;
  } else if (field === "state") {
    live.state = source.state === "open" ? "closed" : "open";
  } else {
    live.due_on = rng.pick(DUE_DATES.filter((d) => d !== source.due_on));
  }
  return { kind: "drift-update", state: { milestones } };
}

/**
 * A live-state witness for one section: mock live state with a KNOWN semantic
 * relation to the declared settings, so the oracle can pin the exact outcome
 * class instead of accepting {clean, drift} either way. Returns the kind that
 * actually holds (drift-update falls back to matching when nothing is
 * perturbable); callers that need a specific kind must check it.
 */
export function genLiveWitness(
  rng: Rng,
  key: WitnessSection,
  settings: unknown,
  kind: LiveWitnessKind,
): LiveWitness {
  if (!WITNESS_KINDS[key].includes(kind)) {
    throw new Error(`genLiveWitness: ${key} does not support the "${kind}" witness`);
  }
  // The witness sections are generated in the plain array form only, but the
  // unwrap keeps this correct if that exclusion ever moves.
  const declared = entriesOf(settings);
  return key === "labels"
    ? labelsWitness(rng, declared, kind)
    : milestonesWitness(rng, declared, kind);
}

// --- Invalid-settings catalog (input-mode fuzz) -----------------------------

/**
 * One deliberately invalid settings document plus a token the action's
 * rejection error must contain: a section path ("labels[2].name"), an unknown
 * top-level key, or a fixed wording fragment. Every case is a violation
 * validateSettingsDoc GENUINELY rejects. Values the loose shapes accept by
 * design stay out of the catalog - unknown nested keys (except inside the
 * strict actions.cache object, whose rejection the curated scenario
 * actions-cache-unknown-key-rejected pins), un-modeled enums
 * (milestones.state, most actions fields), arbitrary field types on loose
 * keys, `pages: null`, and underscore-prefixed top-level keys - because
 * generating them would assert failures the contract does not promise.
 */
export interface InvalidSettingsCase {
  doc: Json;
  offendingToken: string;
}

/** The sections whose settings value is a list. */
const ARRAY_SECTIONS = [
  "labels",
  "rulesets",
  "branches",
  "environments",
  "autolinks",
  "actions_secrets",
  "dependabot_secrets",
  "codespaces_secrets",
  "workflows",
  "collaborators",
  "teams",
  "milestones",
  "actions_variables",
  "webhooks",
  "custom_properties",
  "deploy_keys",
  "secret_scanning_custom_patterns",
] as const satisfies readonly SectionKey[];

/** The sections whose settings value is a plain record (anyRecord shapes). */
const RECORD_SECTIONS = [
  "repository",
  "actions",
  "code_scanning_default_setup",
] as const satisfies readonly SectionKey[];

/**
 * Compile-time exhaustiveness: every section is classified as array, record,
 * pages, or interaction_limits (the two nullable-object sections, each
 * covered by its own catalog cases). A new section that lands unclassified
 * fails here instead of silently missing wrong-container fuzzing.
 */
type CoveredSection =
  | (typeof ARRAY_SECTIONS)[number]
  | (typeof RECORD_SECTIONS)[number]
  | "pages"
  | "interaction_limits";
type _UnclassifiedSection = MustBeNever<Exclude<SectionKey, CoveredSection>>;

/** The required string field each array section's item shape enforces. */
const NATURAL_KEYS: Record<(typeof ARRAY_SECTIONS)[number], string> = {
  labels: "name",
  rulesets: "name",
  branches: "name",
  environments: "name",
  autolinks: "key_prefix",
  actions_secrets: "name",
  dependabot_secrets: "name",
  codespaces_secrets: "name",
  workflows: "path",
  collaborators: "username",
  teams: "name",
  milestones: "title",
  actions_variables: "name",
  // webhooks' natural key is the nested config.url, but the required
  // entry-level field the shape enforces is `config` itself.
  webhooks: "config",
  custom_properties: "property_name",
  deploy_keys: "title",
  secret_scanning_custom_patterns: "name",
};

/**
 * A valid generated array-section value plus a random item to break. The
 * knobbed sections sometimes come back in the wrapped `{entries}` form, so
 * the entries are unwrapped through the shared helper (mutations write
 * through by reference) and `itemToken` spells the issue path the validator
 * reports for whichever form was drawn (`labels[2]` or `labels.entries[2]`).
 */
function validItems(
  rng: Rng,
  key: (typeof ARRAY_SECTIONS)[number],
): { value: EntriesForm; entries: Json[]; index: number; itemToken: string } {
  const value = genSettings(rng.fork("valid"), key) as EntriesForm;
  const entries = entriesOf(value);
  const index = rng.int(entries.length);
  const itemToken = Array.isArray(value) ? `${key}[${index}]` : `${key}.entries[${index}]`;
  return { value, entries, index, itemToken };
}

/**
 * The named rejection catalog. The fuzz stream draws random members and the
 * directed input battery runs every member each run, so a validator or
 * generator regression on any case fails loudly instead of hiding behind the
 * random draw.
 */
export const INVALID_SETTINGS_CASES: ReadonlyArray<{
  name: string;
  build: (rng: Rng) => InvalidSettingsCase;
}> = [
  {
    name: "unknown-top-level-key",
    build: (rng) => {
      // Near-miss typos of real section names; none underscore-prefixed
      // (those are accepted as private keys by design).
      const typo = rng.pick(["labelz", "label", "milestone", "repositories", "branch"]);
      return {
        doc: { labels: genSettings(rng.fork("labels"), "labels") as Json, [typo]: [] },
        offendingToken: typo,
      };
    },
  },
  {
    name: "array-section-wrong-type",
    build: (rng) => {
      const key = rng.pick(ARRAY_SECTIONS);
      // { not: "an array" } keeps the input block's original fixed doc
      // reachable as one member of this case.
      return { doc: { [key]: rng.pick([{ not: "an array" }, "oops", 7]) }, offendingToken: key };
    },
  },
  {
    name: "record-section-wrong-type",
    build: (rng) => {
      const key = rng.pick(RECORD_SECTIONS);
      return { doc: { [key]: rng.pick(["oops", 7, [1], null] as const) }, offendingToken: key };
    },
  },
  {
    name: "pages-wrong-type",
    build: (rng) => ({
      doc: { pages: rng.pick(["gh-pages", [1]] as const) },
      offendingToken: "pages",
    }),
  },
  {
    // null is NOT in the pick list: it is a valid declared value (clear).
    name: "interaction-limits-wrong-type",
    build: (rng) => ({
      doc: { interaction_limits: rng.pick(["oops", 7, [1]] as const) },
      offendingToken: "interaction_limits",
    }),
  },
  {
    name: "interaction-limits-bad-limit",
    build: (rng) => ({
      // A missing or non-string `limit` fails the shape's one required key.
      doc: { interaction_limits: rng.pick([{ expiry: "one_week" }, { limit: 7 }] as const) },
      offendingToken: "interaction_limits",
    }),
  },
  {
    name: "scalar-item",
    build: (rng) => {
      const key = rng.pick(ARRAY_SECTIONS);
      const { value, entries, index, itemToken } = validItems(rng, key);
      (entries as unknown[])[index] = "oops";
      return { doc: { [key]: value }, offendingToken: itemToken };
    },
  },
  {
    name: "missing-natural-key",
    build: (rng) => {
      const key = rng.pick(ARRAY_SECTIONS);
      const { value, entries, index, itemToken } = validItems(rng, key);
      delete (entries[index] as Json)[NATURAL_KEYS[key]];
      return { doc: { [key]: value }, offendingToken: `${itemToken}.${NATURAL_KEYS[key]}` };
    },
  },
  {
    name: "non-string-natural-key",
    build: (rng) => {
      const key = rng.pick(ARRAY_SECTIONS);
      const { value, entries, index, itemToken } = validItems(rng, key);
      (entries[index] as Json)[NATURAL_KEYS[key]] = 42;
      return { doc: { [key]: value }, offendingToken: `${itemToken}.${NATURAL_KEYS[key]}` };
    },
  },
  {
    name: "labels-new-name-not-a-string",
    build: (rng) => {
      const { value, entries, index, itemToken } = validItems(rng, "labels");
      (entries[index] as Json).new_name = 7;
      return { doc: { labels: value }, offendingToken: `${itemToken}.new_name` };
    },
  },
  {
    name: "branches-protection-missing",
    build: (rng) => {
      // protection is REQUIRED (nullable, not optional) on every branch entry.
      const { value, entries, index, itemToken } = validItems(rng, "branches");
      delete (entries[index] as Json).protection;
      return { doc: { branches: value }, offendingToken: `${itemToken}.protection` };
    },
  },
  {
    name: "workflows-state-enum",
    build: (rng) => {
      // The one enum any loose shape enforces.
      const { value, entries, index, itemToken } = validItems(rng, "workflows");
      (entries[index] as Json).state = rng.pick(["paused", "enabled", "on"]);
      return { doc: { workflows: value }, offendingToken: `${itemToken}.state` };
    },
  },
  {
    name: "rulesets-include-not-a-list",
    build: (rng) => {
      // The classic missing "-" typo the rulesets shape exists to catch.
      const { value, entries, index, itemToken } = validItems(rng, "rulesets");
      (entries[index] as Json).conditions = { ref_name: { include: "main" } };
      return {
        doc: { rulesets: value },
        offendingToken: `${itemToken}.conditions.ref_name.include`,
      };
    },
  },
  {
    // The {undeclared, entries} wrapper is this action's own strict
    // vocabulary, so a typo'd wrapper key must fail upfront, named.
    name: "wrapper-unknown-key",
    build: (rng) => {
      const key = rng.pick(UNDECLARED_POLICY_SECTIONS);
      const typo = rng.pick(["entires", "entry", "items"]);
      return {
        doc: { [key]: { [typo]: entriesOf(genSettings(rng.fork("valid"), key)) } },
        offendingToken: typo,
      };
    },
  },
  {
    name: "wrapper-bad-policy",
    build: (rng) => {
      const key = rng.pick(UNDECLARED_POLICY_SECTIONS);
      const entries = entriesOf(genSettings(rng.fork("valid"), key));
      return {
        doc: { [key]: { undeclared: rng.pick(["detele", "kep", true]), entries } },
        offendingToken: `${key}.undeclared`,
      };
    },
  },
  {
    name: "pages-source-not-an-object",
    build: () => ({
      doc: { pages: { source: "main" } },
      offendingToken: "pages.source",
    }),
  },
  {
    name: "pages-source-branch-missing",
    build: () => ({
      doc: { pages: { source: { path: "/" } } },
      offendingToken: "pages.source.branch",
    }),
  },
];

/**
 * One random catalog case, tagged with its case name so callers can label
 * failures and coverage checks can prove every case is actually drawn.
 */
export function genInvalidSettings(rng: Rng): InvalidSettingsCase & { name: string } {
  const { name, build } = rng.pick(INVALID_SETTINGS_CASES);
  return { name, ...build(rng) };
}

/**
 * Raw settings bodies the yaml parser GENUINELY throws on (each verified
 * against the yaml package: unclosed flow collections, an unterminated
 * quote, a compact nested mapping). Single-repo they hit the "cannot read
 * settings ... valid YAML" read path; multi-repo the "cannot parse <slug>"
 * target gate. Both fire before any section runs.
 */
export const UNPARSEABLE_YAML = [
  "labels: [oops, unclosed",
  "{",
  "a: b\n  c: d",
  'key: "unterminated',
  "a: [1, 2\nb: 3",
] as const;

/**
 * Raw bodies that PARSE fine but not to a mapping, so they pass the yaml
 * parser and fail validateSettingsDoc's top-level check ("must be a YAML
 * mapping ... parsed as a list/string") instead. In multi mode the
 * defaults merge passes a non-mapping through wholesale (engine/merge.ts
 * deepMerge replaces on a non-object override), so the same wording fires
 * there with the slug as the source label.
 */
export const NON_MAPPING_YAML = ["- a\n- b", "just a string"] as const;

/**
 * Seed the live state that makes the "configure but cannot create" sections
 * converge: every declared branch name is present in `live_state.branches` (so a
 * protection PUT has a branch to attach to), and every declared workflow path is
 * present in `live_state.workflows` at its declared state (so enable/disable is a
 * no-op or a single flip that then converges). Returns undefined when the
 * settings declare neither section, leaving the scenario's live state absent.
 * Exported for the fault fuzz, whose single-section scenarios need the same
 * presence seeding to converge.
 */
export function presenceLiveState(settings: Json): LiveState | undefined {
  const live: LiveState = {};
  const branches = settings.branches as Json[] | undefined;
  if (Array.isArray(branches)) {
    live.branches = branches.map((b) => String(b.name));
  }
  const workflows = settings.workflows as Json[] | undefined;
  if (Array.isArray(workflows)) {
    live.workflows = workflows.map((w, i) => ({
      id: i + 1,
      name: String(w.path),
      path: String(w.path),
      state: w.state === "disabled" ? "disabled_manually" : "active",
    }));
  }
  return live.branches || live.workflows ? live : undefined;
}

// --- Fault-target catalog (fault-mode fuzz) ---------------------------------

/**
 * The one read each section issues UNCONDITIONALLY - in BOTH modes - whenever
 * the section is declared, as the "section.role" fault key the mock accepts.
 * A fault aimed here is guaranteed to fire, which the fuzz iteration's
 * faultsFired assertion turns into a non-vacuity proof. Sections whose first
 * read is conditional or check-mode-only are deliberately absent: repository,
 * environments, code_scanning_default_setup, and interaction_limits read
 * only under check (apply
 * writes unconditionally; environments' variables list additionally fires
 * only when an entry declares the nested key), and branches/actions gate
 * their reads on the
 * declared keys - a fault aimed at a read that never happens would fail the
 * non-vacuity assertion instead of testing anything.
 */
export const SECTION_PRIMARY_READ = {
  labels: "labels.list",
  rulesets: "rulesets.list",
  autolinks: "autolinks.list",
  workflows: "workflows.list",
  collaborators: "collaborators.list",
  teams: "teams.org",
  milestones: "milestones.list",
  pages: "pages.get",
  actions_variables: "actions_variables.list",
  actions_secrets: "actions_secrets.list",
  dependabot_secrets: "dependabot_secrets.list",
  codespaces_secrets: "codespaces_secrets.list",
  webhooks: "webhooks.list",
  // The values GET runs right after the org probe, in both modes, whenever
  // the section is declared on an org owner (the fault batteries pin
  // owner_kind: "org", so the probe never diverts it).
  custom_properties: "custom_properties.list",
  deploy_keys: "deploy_keys.list",
  secret_scanning_custom_patterns: "secret_scanning_custom_patterns.list",
} as const satisfies Partial<Record<SectionKey, string>>;

export type FaultableSection = keyof typeof SECTION_PRIMARY_READ;

/**
 * The sections deliberately absent from SECTION_PRIMARY_READ (the reasons are
 * in its doc). Together the two lists must cover every SectionKey: a NEW
 * section that lands unclassified fails this exhaustiveness check instead of
 * silently escaping fault fuzzing.
 */
const UNFAULTABLE_SECTIONS = [
  "repository",
  "branches",
  "environments",
  "actions",
  "code_scanning_default_setup",
  "interaction_limits",
] as const satisfies readonly SectionKey[];
type FaultClassified = FaultableSection | (typeof UNFAULTABLE_SECTIONS)[number];
type _UnclassifiedFaultSection = MustBeNever<Exclude<SectionKey, FaultClassified>>;

let validator: ValidateFunction | undefined;

/** Compile (once) the ajv validator for the published settings schema. */
function settingsValidator(): ValidateFunction {
  if (!validator) {
    const ajv = new Ajv({ strict: false, allErrors: true });
    const add = (addFormats as unknown as { default?: typeof addFormats }).default ?? addFormats;
    (add as typeof addFormats)(ajv);
    validator = ajv.compile(settingsSchema);
  }
  return validator;
}

/**
 * Validate a whole settings document against the PUBLISHED JSON schema
 * (lib/settings.schema.json). Throws with the ajv errors when it does not
 * match. This is one leg of the three-way drift check: a generated doc must
 * satisfy this, src's validateSettingsDoc, and each section's zod shape.
 */
export function validateAgainstPublishedSchema(doc: unknown): void {
  const validate = settingsValidator();
  if (!validate(doc)) {
    const errors = (validate.errors ?? [])
      .map((e) => `  ${e.instancePath || "(root)"} ${e.message}`)
      .join("\n");
    throw new Error(`generated settings failed schema validation:\n${errors}`);
  }
}

/** Options steering scenario generation, e.g. a biased or fixed section set. */
export interface GenScenarioOptions {
  /** Restrict generation to these sections (a smoke or PR-diff subset). */
  sections?: SectionKey[];
}

/**
 * Sections whose permission carries an org-members gate (today: teams).
 * Derived from the registry's `permission` declarations - the same single
 * source that drives the oracle's sectionGrade and the mock's permission
 * gate - so a future org-gated section inherits the forced-private strip
 * below without a hand edit.
 */
export const ORG_GATED_SECTIONS: ReadonlySet<SectionKey> = new Set(
  SECTIONS.filter((section) => section.permission.org === "members").map((section) => section.key),
);

/**
 * Permission-mask keys, taken from the schema's compile-complete tuple (its
 * MustBeNever tripwire covers every PatResource), so a new resource cannot be
 * left out of permission fuzzing by a stale manual copy here.
 */
const MASK_KEYS: readonly MaskKey[] = SCHEMA_MASK_KEYS;

/**
 * The generation facts the oracle (Phase 3b) needs to predict an outcome
 * class without re-parsing the scenario: which sections are declared, the
 * permission mask, the denial style, and the mode/policy/owner_kind.
 */
export interface ScenarioMeta {
  sections: SectionKey[];
  mask: Partial<Record<MaskKey, MaskGrade>>;
  mode: "apply" | "check";
  policy: "fail" | "warn";
  ownerKind: OwnerKind;
  denialStyle: DenialStyle;
  requiredSections: SectionKey[];
  /**
   * The `sections` (INPUT_SECTIONS) allowlist the run was generated under,
   * when one is set; undefined means no allowlist, every declared section
   * runs. The engine reports a declared-but-not-allowlisted section as
   * "excluded" BEFORE its handler runs (orchestrate.ts), so the oracle folds
   * exclusion ahead of grades and witnesses. genScenario rolls one on ~20%
   * of scenarios (a strict nonempty subset of the declared sections).
   */
  onlySections?: SectionKey[];
  /**
   * The live-state witness seeded per section (labels and milestones only):
   * the KNOWN semantic relation between the generated live state and the
   * declared settings, so the oracle can pin the exact success outcome. A
   * section without an entry has no witness (absent live state, or a family
   * the witness generator does not model) and keeps the loose prediction.
   */
  liveKinds?: Partial<Record<SectionKey, LiveWitnessKind>>;
  /**
   * The GLOBAL token mask, distinct from `mask` (the effective per-slug mask)
   * ONLY in multi-repo mode. teams' org-scoped endpoints are graded by the mock
   * against this global mask's org_members, not the per-slug overlay, so the
   * oracle uses it for the teams org gate. Absent (undefined) in single-repo
   * mode, where the effective mask IS the global mask.
   */
  orgMask?: Partial<Record<MaskKey, MaskGrade>>;
}

/**
 * A random whole scenario plus the generation metadata the oracle consumes.
 * The scenario's settings pass the published schema; required_sections are
 * drawn only from the declared sections so the scenario is internally
 * consistent. denial_style draws from fine_grained, 403, and 404 (only 403
 * discriminates in the oracle; 404 shares fine_grained's outcome classes for
 * every operation currently generated). The returned meta echoes the raw
 * generation facts so the oracle does not re-derive them from the scenario.
 */
export function genScenario(
  rng: Rng,
  options: GenScenarioOptions = {},
): { scenario: Scenario; meta: ScenarioMeta } {
  const pool =
    options.sections !== undefined && options.sections.length > 0 ? options.sections : SECTION_KEYS;
  const chosen = pool.filter(() => rng.bool(0.5));
  if (chosen.length === 0) {
    chosen.push(rng.pick(pool));
  }

  const settings: Json = {};
  for (const key of chosen) {
    settings[key] = genSettings(rng.fork(`settings:${key}`), key);
  }
  validateAgainstPublishedSchema(settings);

  // Seed live state for the sections whose resource the action can configure but
  // NOT create: branches (a protection PUT needs the branch to exist) and
  // workflows (a workflow can only be enabled/disabled if its file is present).
  // Without this the declared branch/workflow permanently drifts with a skip
  // note ("does not exist ... apply will skip it") and never converges, which is
  // correct engine behavior but not what a fully-granted apply should model. So
  // the generated live state contains every declared branch name and workflow
  // path, letting apply act on them and check converge.
  const presence = presenceLiveState(settings) ?? {};

  // Live-state WITNESSES for labels and milestones: seed live state whose
  // relation to the declared settings is known (matching, drift-update,
  // extra-undeclared), so the oracle predicts the exact outcome instead of
  // accepting {clean, drift} either way - a false-negative drift detector
  // would otherwise pass every iteration. A quarter of the time the section
  // keeps absent live state, preserving the create path.
  const liveKinds: Partial<Record<SectionKey, LiveWitnessKind>> = {};
  const witnessState: LiveState = {};
  for (const key of WITNESS_SECTIONS) {
    if (!chosen.includes(key)) {
      continue;
    }
    const witnessRng = rng.fork(`witness:${key}`);
    if (witnessRng.bool(0.25)) {
      continue;
    }
    const kind = witnessRng.pick(WITNESS_KINDS[key]);
    const witness = genLiveWitness(witnessRng, key, settings[key], kind);
    liveKinds[key] = witness.kind;
    Object.assign(witnessState, witness.state);
  }

  const combinedLive: LiveState = { ...presence, ...witnessState };
  const liveState = Object.keys(combinedLive).length > 0 ? combinedLive : undefined;

  const mask: Partial<Record<MaskKey, MaskGrade>> = {};
  for (const resource of MASK_KEYS) {
    if (rng.bool(0.4)) {
      mask[resource] = rng.pick(["none", "read", "write"] as const);
    }
  }
  // The branch-policy pattern and protection-rule endpoints carry
  // per-endpoint permission overrides the oracle cannot grade at section
  // level; strip the keys when this mask constrains them (see
  // suppressMaskedEnvironmentOverrides).
  suppressMaskedEnvironmentOverrides(settings, mask);
  // custom_properties' permission-"none" reads make a full denial ungradeable
  // at section level; strip (or soften) it under that mask (see
  // suppressMaskedCustomProperties).
  suppressMaskedCustomProperties(settings, mask, chosen);

  const mode = rng.pick(["apply", "check"] as const);
  const policy = rng.pick(["fail", "warn"] as const);
  const ownerKind: OwnerKind = rng.pick(["org", "user"] as const);
  // 404 answers EVERY denial (read and write) with Not Found; the mock still
  // classifies denied writes as PermissionDenied, so its outcome classes
  // equal fine_grained for every operation the generator currently produces
  // (a future generated write whose endpoint TOLERATES 404 would break that
  // parity) - 403 stays the discriminating style.
  const denialStyle: DenialStyle = rng.pick(["fine_grained", 403, 404] as const);
  const requiredSections = chosen.filter(() => rng.bool(0.25));
  // Occasionally run under a `sections` allowlist so the EXCLUDED outcome is
  // exercised: a strict nonempty subset of the declared sections is allowed
  // and the rest must render excluded. The oracle folds this before
  // permissions and witnesses (predictSection), and excluded sections never
  // preflight nor break the fullyGranted fixpoint gates.
  // New draws live on a forked stream so the pre-existing main-stream
  // sequence (and with it every recorded seed) stays stable.
  const allowRng = rng.fork("input-sections");
  let onlySections: SectionKey[] | undefined;
  if (chosen.length >= 2 && allowRng.bool(0.2)) {
    const subset = chosen.filter(() => allowRng.bool(0.6));
    onlySections =
      subset.length === 0
        ? [allowRng.pick(chosen)]
        : subset.length === chosen.length
          ? subset.slice(1)
          : subset;
  }

  // The step-env half of any generated secret references (webhook secrets
  // and actions_secrets values), from the SAME fixed pool the generators
  // drew them from - single-sourced, so a reference can never name a
  // variable the child env lacks.
  const secretEnv = scenarioSecretEnv(settings);

  const scenario: Scenario = {
    name: `fuzz-${rng.seed}`,
    tiers: ["mock"],
    settings,
    inputs: {
      mode,
      on_missing_permission: policy,
      ...(requiredSections.length > 0 ? { required_sections: requiredSections.join(",") } : {}),
      ...(onlySections !== undefined ? { sections: onlySections.join(",") } : {}),
    },
    ...(secretEnv === undefined ? {} : { env: secretEnv }),
    token_permissions: Object.keys(mask).length > 0 ? mask : undefined,
    denial_style: denialStyle,
    owner_kind: ownerKind,
    // Occasionally a GHES-style base URL prefix: the mock requires it on
    // every request, proving the client joins base URLs without dropping or
    // doubling the path (mirrors the curated ghes-prefix scenario). A new
    // draw, so it comes from a fork (main-stream stability).
    ...(rng.fork("base-prefix").bool(0.15) ? { base_prefix: "/api/v3" } : {}),
    ...(liveState ? { live_state: liveState } : {}),
    // The oracle predicts the outcome class in Phase 3b; a generated scenario
    // carries a placeholder expect until the oracle fills it.
    expect: { exit_code: 0 },
  };
  const meta: ScenarioMeta = {
    sections: chosen,
    mask,
    mode,
    policy,
    ownerKind,
    denialStyle,
    requiredSections,
    onlySections,
    liveKinds,
  };
  return { scenario, meta };
}

/**
 * What one multi-repo target IS. The discriminant makes the illegal
 * combinations unrepresentable: only a normal target carries a ScenarioMeta,
 * and only a raw-invalid one carries a raw kind ("unparseable" bodies throw
 * in the yaml parser - the "cannot parse <slug>" gate; "non-mapping" bodies
 * parse to a list/scalar and fail the top-level validator). Both raw kinds
 * fail the target before any section runs.
 */
export type MultiRepoTarget =
  | { kind: "normal"; meta: ScenarioMeta }
  | { kind: "missing" }
  | { kind: "raw-invalid"; raw: "unparseable" | "non-mapping" };

/** Generation facts for one target repo in a multi-repo scenario. */
export interface MultiRepoMeta {
  slug: string;
  /**
   * The target's kind plus its kind-specific facts: "normal" runs sections
   * under its meta, "missing" has no settings file (the action skips it),
   * "raw-invalid" serves settings_raw that fails before any section runs.
   */
  target: MultiRepoTarget;
  /** The visibility planted in this target's mock repo (drives the redaction rule). */
  visibility: "public" | "private" | "internal";
  /**
   * True when this target's administration-gated visibility probe is denied
   * (mask.administration === "none"), so the resolver reads "unknown" and
   * redaction fails closed regardless of the planted visibility.
   */
  probeDenied: boolean;
  /**
   * True when the oracle expects this target hidden from the public view:
   * policy is redact, the slug is not the self slug, and it is private/internal
   * OR its probe was denied. Its repos-result key is a placeholder, and its
   * canaries must leak into no public surface.
   */
  redacted: boolean;
  /** The repos-result KEY the action emits: the placeholder when redacted, else the slug. */
  displayKey: string;
  /**
   * Unique strings planted in this target's private surfaces (live label
   * name/description, repo description, remote settings.yml). When the target
   * is redacted, none may appear in any public surface (the leak invariant).
   */
  canaries: string[];
}

/** The generation facts a multi-repo scenario's oracle rollup consumes. */
export interface MultiScenarioMeta {
  repos: MultiRepoMeta[];
  mode: "apply" | "check";
  policy: "fail" | "warn";
  /** The `private-repos` policy the run was generated under (redact or show). */
  privateRepos: "redact" | "show";
  /**
   * The `private-report` channel: `issue` delivers the full report to each
   * redacted target's own repo; `artifact` age-encrypts the report and uploads
   * it as a workflow artifact (which fails with a safe warning in the harness,
   * where the runner token is absent); `none` sends nothing. Only ever `issue`
   * or `artifact` under redact (the config rejects a delivering channel + show).
   */
  privateReport: "none" | "issue" | "artifact";
  /** GITHUB_REPOSITORY: a target whose slug equals it is never redacted. */
  selfSlug: string;
  /**
   * The run's GLOBAL token mask (scenario token_permissions), varied only on
   * org_members. The idempotence eligibility predicate reads it: a globally
   * denied org gate makes a declared teams section a denied-path section even
   * when every per-target mask is empty.
   */
  globalMask: Partial<Record<MaskKey, MaskGrade>>;
  /**
   * The slug of the forced-private canary target, when redaction forced one
   * (privateRepos === "redact"); undefined under show. Lets tests address
   * THAT target exactly instead of pattern-matching redacted targets, which
   * an unforced roll can also produce.
   */
  forcedPrivateSlug?: string;
  /**
   * A core-route fault the FUZZ ITERATION injected (generation never sets
   * this). `fatal` is the modeled VERDICT - the fault kills the FIRST
   * target's settings fetch (an exhausting budget of 1 + MAX_RETRIES, or a
   * rate_limit_403's first firing): targets are processed in generation
   * order, the visibility probes consume nothing (they hit the repository
   * route), and the fault hook precedes both the missing-file 404 and the
   * permission gate - so the victim FAILS outright whatever its kind would
   * otherwise report. A non-fatal fault is retried away and changes no
   * prediction.
   */
  coreFault?: { key: "core.contentsGet"; fatal: boolean };
  /**
   * The slug of the target that opted out of the defaults' milestones section
   * (set milestones: null), or undefined when no target opted out. Recorded so
   * the oracle and tests can reason about the inherited-section fold.
   */
  milestonesOptOutSlug?: string;
}

/**
 * A random multi-repo scenario: 2 to 5 target repos, each with its own
 * generated settings, live state, and permission mask. One repo is randomly
 * left without a settings file, which the action skips, and one may serve raw
 * invalid settings text instead. A defaults file merged under every target may
 * null out one section (the opt-out path). The returned meta records each
 * repo's target kind (normal with its ScenarioMeta, missing, or raw-invalid)
 * for the per-repo oracle plus the worst-of rollup.
 */
/**
 * Battery-construction forces: pin specific rolls so a directed battery entry
 * EXISTS for every master seed. Rejection sampling with ANY fixed fork budget
 * has miss seeds (live counterexample: seed 8181 missed an issue-channel draw
 * in 40 forks), and with live CI seeds every miss is a spurious failure - so
 * the batteries CONSTRUCT eligibility instead of sampling for it. When the
 * knob landed, the UNFORCED path was verified byte-identical to the
 * pre-force generator over 400 seeds; later generator changes move both
 * paths together. FORCED paths may consume a DIFFERENT draw
 * sequence (an overridden roll can gate later draws - e.g. a forced redact
 * consumes the report pick a rolled show would skip), which is safe: forced
 * generation is deterministic per (seed, force), and every battery replay
 * (--iterations 0) reapplies its force. No consumer generates forced and
 * replays unforced.
 *
 * - "issue-report": the delivering issue channel (privateRepos redact +
 *   privateReport issue) - the report-fault battery's precondition.
 * - "idempotence-eligible": apply mode, non-delivering channel, no raw
 *   target, every normal target's mask empty - multiIdempotenceEligible by
 *   construction.
 * - "plain-first-target": privateRepos show (no canaries anywhere) and the
 *   raw target kept off index 0 - the contents-fault victim guard by
 *   construction.
 */
export type MultiBatteryForce = "issue-report" | "idempotence-eligible" | "plain-first-target";

export function genMultiScenario(
  rng: Rng,
  force?: MultiBatteryForce,
): { scenario: Scenario; meta: MultiScenarioMeta } {
  const count = rng.int(4) + 2; // 2..5
  const rolledMode = rng.pick(["apply", "check"] as const);
  const mode = force === "idempotence-eligible" ? "apply" : rolledMode;
  const policy = rng.pick(["fail", "warn"] as const);
  const denialStyle: DenialStyle = rng.pick(["fine_grained", 403] as const);
  // The private-repos policy for the run: redact (the default) or show. Under
  // redact, private/internal targets and probe-denied targets are hidden and
  // keyed by a placeholder; under show, nothing is redacted. Chosen randomly so
  // the fuzzer covers both, and the oracle predicts the placeholder keys and the
  // leak invariant from it.
  const rolledPrivateRepos = rng.pick(["redact", "show"] as const);
  const privateRepos =
    force === "issue-report"
      ? "redact"
      : force === "plain-first-target"
        ? "show"
        : rolledPrivateRepos;
  // The private-report channel. `issue` delivers the full report to each
  // redacted target's own repo; `artifact` age-encrypts every report into one
  // workflow artifact (which fails with a safe warning in the harness, where the
  // runner token is absent). Both are only valid under redact (the config rejects
  // a delivering channel + show, since show redacts nothing), so they are picked
  // only then. Randomized so the fuzzer covers delivery, reuse, denial, and the
  // artifact upload-attempt path.
  const rolledReport =
    privateRepos === "redact" ? rng.pick(["none", "issue", "artifact"] as const) : "none";
  const privateReport =
    force === "issue-report" ? "issue" : force === "idempotence-eligible" ? "none" : rolledReport;
  // The admin repo the runner runs as (GITHUB_REPOSITORY); a target whose slug
  // equals it is never redacted (the self carve-out). Kept in sync with
  // runner.ts's REPO_SLUG.
  const selfSlug = "e2e-owner/e2e-repo";
  // The GLOBAL token mask for the run, varied ONLY on org_members: the mock
  // grades org-scoped endpoints (teams' org routes) against the global mask
  // while repo-scoped ones use the per-slug overlay, so any other global
  // entry would make mock and oracle grade DIFFERENT effective masks.
  // org_members is org-scoped only, so both sides agree; each repo's oracle
  // meta carries this as orgMask (the teams org gate in sectionGrade). The
  // idempotence force clears it: a globally denied teams section under fail
  // policy would preflight-abort and block the fixpoint proof.
  // New draws, so they live on a forked stream: the pre-existing main-stream
  // sequence (missingIndex and everything after) stays stable and recorded
  // seeds keep reproducing.
  const globalMaskRng = rng.fork("global-mask");
  const globalMask: Partial<Record<MaskKey, MaskGrade>> = {};
  if (globalMaskRng.bool(0.3) && force !== "idempotence-eligible") {
    globalMask.org_members = globalMaskRng.pick(["none", "read", "write"] as const);
  }
  // One repo (chosen up front) is missing its settings file, so it is skipped.
  const missingIndex = rng.int(count);

  const repos: Record<string, unknown> = {};
  const repoMetas: MultiRepoMeta[] = [];
  // Under redact, force ONE non-missing target private so the run always has a
  // redacted target: otherwise a run where every target rolled public would give
  // an empty forbidden set and a vacuous leak check. Pick any index != missing
  // (count >= 2 guarantees one exists). Under show this is inert.
  const forcedPrivateIndex =
    privateRepos === "redact"
      ? (missingIndex + 1 + rng.int(count - 1)) % count // any non-missing index
      : -1;
  // The running placeholder ordinal, incremented per redacted target in target
  // order - the exact numbering planRedaction assigns (self and public skipped).
  let redactedOrdinal = 0;
  // With ~1/5 probability one further target serves RAW settings text: an
  // unparseable body (the "cannot parse <slug>" gate) or one parsing to a
  // non-mapping (the top-level validator gate). Never the missing target (its
  // gate is the contents 404) and never the forced-private target (its canary
  // flow must stay guaranteed for the leak counterfactual).
  const rawCandidates = Array.from({ length: count }, (_, i) => i).filter(
    (i) =>
      i !== missingIndex &&
      i !== forcedPrivateIndex &&
      // The contents-fault battery's victim is always index 0; keep the raw
      // target off it by construction.
      (force !== "plain-first-target" || i !== 0),
  );
  const rolledRawIndex = rawCandidates.length > 0 && rng.bool(0.2) ? rng.pick(rawCandidates) : -1;
  const rawIndex = force === "idempotence-eligible" ? -1 : rolledRawIndex;
  const rawKind = rawIndex >= 0 ? rng.pick(["unparseable", "non-mapping"] as const) : undefined;
  for (let i = 0; i < count; i++) {
    const slug = `e2e-owner/repo-${i}`;
    // Every target gets a random visibility; roughly half are non-public so the
    // redaction path is exercised. One index is forced private (see above) so a
    // redact run is never vacuous. The self slug is forced public-ish (its
    // visibility never matters - the carve-out fires first).
    const visibility =
      i === forcedPrivateIndex
        ? rng.pick(["private", "internal"] as const)
        : rng.pick(["public", "public", "private", "internal"] as const);
    if (i === missingIndex) {
      // No settings file: the action reads a 404 and skips the target. It is
      // still visibility-probed and can still be redacted (the placeholder key
      // is assigned before the target loop runs).
      const probeDenied = false;
      const redacted =
        privateRepos === "redact" && slug !== selfSlug && (visibility !== "public" || probeDenied);
      if (redacted) {
        redactedOrdinal += 1;
      }
      const displayKey = redacted ? `private repository #${redactedOrdinal}` : slug;
      const repoSpec: Record<string, unknown> = { settings: null };
      if (visibility !== "public") {
        repoSpec.live_state = { repo: { private: true, visibility } };
      }
      repos[slug] = repoSpec;
      repoMetas.push({
        slug,
        target: { kind: "missing" },
        visibility,
        probeDenied,
        redacted,
        displayKey,
        canaries: [],
      });
      continue;
    }
    if (i === rawIndex && rawKind !== undefined) {
      // Raw invalid settings text: the target fails at the parse gate (or the
      // top-level validator, for the non-mapping kind) before any section
      // runs. Fully granted (no mask) so the contents read always succeeds
      // and the parse gate - not a permission gate - is what fires; the
      // redaction mechanics stay identical to every other target.
      const raw =
        rawKind === "unparseable" ? rng.pick(UNPARSEABLE_YAML) : rng.pick(NON_MAPPING_YAML);
      const probeDenied = false;
      const redacted =
        privateRepos === "redact" && slug !== selfSlug && (visibility !== "public" || probeDenied);
      if (redacted) {
        redactedOrdinal += 1;
      }
      const displayKey = redacted ? `private repository #${redactedOrdinal}` : slug;
      const repoSpec: Record<string, unknown> = { settings_raw: raw };
      if (visibility !== "public") {
        repoSpec.live_state = { repo: { private: true, visibility } };
      }
      repos[slug] = repoSpec;
      repoMetas.push({
        slug,
        target: { kind: "raw-invalid", raw: rawKind },
        visibility,
        probeDenied,
        redacted,
        displayKey,
        canaries: [],
      });
      continue;
    }
    const child = rng.fork(`repo:${i}`);
    // A random section subset with its own settings and mask, sharing the run's
    // mode and policy. teams is included now that the multi-repo mock serves the
    // org-level probe (GET /orgs/{owner}) from shared org state under the global
    // mask, so per-repo teams exercises the org-members AND-gate too.
    // The secret sections are excluded at the draw: their values are ALWAYS
    // $NAME references, which target provenance refuses, so the sections are
    // unrepresentable in a target-fetched settings.yml (stripSecretReferences
    // below backstops the same rule for the webhook secret FIELD and the
    // nested environments secrets key).
    const pool = SECTION_KEYS.filter(
      (key) => !(SECRET_LIST_SECTIONS as readonly SectionKey[]).includes(key),
    );
    let sections = pool.filter(() => child.bool(0.5));
    if (sections.length === 0) {
      sections.push(child.pick(pool));
    }
    // The forced-private target's design guarantees - it never
    // preflight-aborts and its report always delivers - assume every section
    // it declares is fully granted. A globally denied org gate
    // (org_members: none) breaks that for org-gated sections (their reads are
    // denied whatever the per-slug mask says), so the canary target drops
    // them then; org-gated sections under a denied org gate stay covered on
    // the OTHER targets.
    if (i === forcedPrivateIndex && globalMask.org_members === "none") {
      sections = sections.filter((key) => !ORG_GATED_SECTIONS.has(key));
      if (sections.length === 0) {
        // A new draw, so it forks off the child stream: the child's own
        // downstream draws (per-target mask rolls) stay unshifted.
        sections.push(
          child.fork("canary-refill").pick(pool.filter((key) => !ORG_GATED_SECTIONS.has(key))),
        );
      }
    }
    const settings: Json = {};
    for (const key of sections) {
      settings[key] = genSettings(child.fork(`settings:${key}`), key);
    }
    // A remote target's settings.yml is authored by the TARGET repository,
    // where a $NAME secret reference is refused by design (target provenance
    // cannot read the operator's environment) - so multi targets never
    // declare one. The secret path stays covered by the single-repo stream.
    stripSecretReferences(settings);
    const mask: Partial<Record<MaskKey, MaskGrade>> = {};
    for (const resource of MASK_KEYS) {
      if (child.bool(0.3)) {
        mask[resource] = child.pick(["none", "read", "write"] as const);
      }
    }
    // The forced-private target must be a REAL leak test, not sometimes-vacuous.
    // It is fully GRANTED (every mask entry cleared to the write default): under
    // apply + fail a single denied section read aborts the whole target at
    // preflight and nothing - including the canary label - is ever rendered. A
    // fully-granted target never preflight-aborts, so its canary label's name
    // (and, in check mode, its description) always reaches the detail output that
    // redaction must suppress. Its visibility is already private (forced above),
    // so it stays redacted regardless. The OTHER targets keep their random masks,
    // so denial coverage is unaffected.
    // The idempotence battery force clears EVERY normal target's mask: the
    // apply-idempotence gate requires fully-granted targets (empty masks by
    // its deliberately narrow definition). The mask rolls themselves are
    // consumed either way; only their outcome is discarded.
    if (i === forcedPrivateIndex || force === "idempotence-eligible") {
      for (const resource of MASK_KEYS) {
        delete mask[resource];
      }
    }
    // Same rule as the single-repo generator: a per-target mask constraining
    // the branch-policy pattern and protection-rule overrides makes those
    // keys ungradeable, so they are stripped for this target (the global
    // mask varies only on org_members, so the per-target mask alone decides).
    suppressMaskedEnvironmentOverrides(settings, mask);
    // And a per-target mask denying custom_properties outright strips (or
    // softens) that section, as in the single-repo generator.
    suppressMaskedCustomProperties(settings, mask, sections);
    // A denied administration mask denies the visibility probe (GET /repos), so
    // the resolver reads "unknown" and redaction fails closed even for a public
    // target. Matches the redaction rule in multi.ts.
    const probeDenied = mask.administration === "none";
    const redacted =
      privateRepos === "redact" && slug !== selfSlug && (visibility !== "public" || probeDenied);
    if (redacted) {
      redactedOrdinal += 1;
    }
    const displayKey = redacted ? `private repository #${redactedOrdinal}` : slug;

    // Seed each target's live state the same way single-repo genScenario does,
    // so a target's declared branches/workflows exist and converge instead of
    // drifting on a permanent skip note.
    const live: LiveState = presenceLiveState(settings) ?? {};
    if (visibility !== "public") {
      live.repo = { ...(live.repo ?? {}), private: true, visibility };
    }

    // Plant canaries in a redacted target's private surfaces so a
    // detail-SUPPRESSION regression (not just a slug leak) is caught. The canary
    // is a declared label matched by a unique name; its live description DIFFERS
    // from the declared one, so the label drifts in check mode and updates in
    // apply mode - in both cases the label name and the differing description
    // flow into the section's drift/change detail, which redaction must hide. A
    // matched-by-name label keeps the outcome class the labels grade already
    // predicts (drift/applied), so the oracle needs no special case. A third
    // canary rides the live repo description. Under redaction none of these may
    // reach any public surface; the leak invariant checks exactly that.
    const canaries: string[] = [];
    if (redacted) {
      const nameCanary = `CANARY-${rng.seed}-${i}-name`;
      const declaredDescCanary = `CANARY-${rng.seed}-${i}-declared`;
      const liveDescCanary = `CANARY-${rng.seed}-${i}-live`;
      const repoCanary = `CANARY-${rng.seed}-${i}-repo`;
      canaries.push(nameCanary, declaredDescCanary, liveDescCanary, repoCanary);
      // The declared labels may be in either form (plain array or wrapper);
      // entriesOf returns the live entry list by reference, so the push
      // lands inside whichever container was generated.
      const declaredLabels = settings.labels === undefined ? [] : entriesOf(settings.labels);
      declaredLabels.push({ name: nameCanary, color: "abcdef", description: declaredDescCanary });
      if (settings.labels === undefined) {
        settings.labels = declaredLabels;
      }
      const liveLabels = Array.isArray(live.labels) ? (live.labels as Json[]) : [];
      // Same name (so the engine matches and diffs it, not create+delete) but a
      // DIFFERENT description, so the canary drifts into the detail line.
      liveLabels.push({ name: nameCanary, color: "abcdef", description: liveDescCanary });
      live.labels = liveLabels;
      live.repo = { ...(live.repo ?? {}), description: repoCanary };
      // The canary rides in on the labels section, so the oracle must predict it.
      if (!sections.includes("labels")) {
        sections.push("labels");
      }
    }
    validateAgainstPublishedSchema(settings);

    const hasLive = Object.keys(live).length > 0;
    repos[slug] = {
      settings,
      ...(hasLive ? { live_state: live } : {}),
      ...(Object.keys(mask).length > 0 ? { permissions: mask } : {}),
    };
    repoMetas.push({
      slug,
      visibility,
      probeDenied,
      redacted,
      displayKey,
      canaries,
      target: {
        kind: "normal",
        meta: {
          sections,
          mask,
          mode,
          policy,
          ownerKind: "org",
          denialStyle,
          requiredSections: [],
          // teams' org gate is graded by the mock against the GLOBAL mask, not
          // this per-slug one; genMultiScenario varies that global mask on
          // org_members only, and every target shares it.
          orgMask: globalMask,
        },
      },
    });
  }

  // A defaults file merged under every target. It DECLARES a shared milestones
  // section; a target opts out by setting milestones: null in ITS OWN settings
  // (the null-section opt-out only applies to a section the defaults declare,
  // and the defaults file itself must be schema-valid, so the null lives on a
  // target, never in the defaults file). Pick one non-missing target to opt out.
  const defaultsFile: Json = {
    labels: [{ name: "shared-default", color: "cccccc" }],
    milestones: [{ title: "shared-milestone", state: "open" }],
  };
  const optOutSlugs = Object.entries(repos)
    .filter(([, spec]) => {
      // Only a target with a REAL settings mapping can opt out: null marks
      // the missing-settings target, and undefined the raw-settings one
      // (writing milestones: null into its absent mapping would crash).
      const settings = (spec as { settings?: unknown }).settings;
      return settings !== null && settings !== undefined;
    })
    .map(([slug]) => slug);
  let optedOutSlug: string | undefined;
  if (optOutSlugs.length > 0 && rng.bool(0.3)) {
    optedOutSlug = rng.pick(optOutSlugs);
    const spec = repos[optedOutSlug] as { settings: Json };
    spec.settings.milestones = null;
  }

  // Fold the defaults-inherited sections into each target's oracle meta: every
  // target runs the defaults' labels and milestones (merged under its own
  // settings) UNLESS it opted that section out with a null. The oracle predicts
  // from meta.sections, so a target that inherits labels but never declared it
  // must still have labels predicted - otherwise a denied inherited section
  // (e.g. labels under issues:read) is an unpredicted failure. The opt-out
  // works both ways: the null overwrites even a SELF-declared milestones on
  // that target, so the section must also be REMOVED from its meta, not just
  // skipped when adding.
  const DEFAULTS_SECTIONS: SectionKey[] = ["labels", "milestones"];
  for (const repoMeta of repoMetas) {
    if (repoMeta.target.kind !== "normal") {
      continue;
    }
    const repoScenarioMeta = repoMeta.target.meta;
    const optedOut = repoMeta.slug === optedOutSlug ? ["milestones"] : [];
    repoScenarioMeta.sections = repoScenarioMeta.sections.filter(
      (s) => !optedOut.includes(s),
    ) as SectionKey[];
    for (const inherited of DEFAULTS_SECTIONS) {
      if (!repoScenarioMeta.sections.includes(inherited) && !optedOut.includes(inherited)) {
        repoScenarioMeta.sections.push(inherited);
      }
    }
  }

  const scenario: Scenario = {
    name: `fuzz-multi-${rng.seed}`,
    tiers: ["mock"],
    settings: {},
    inputs: {
      mode,
      on_missing_permission: policy,
      private_repos: privateRepos,
      ...(privateReport !== "none" ? { private_report: privateReport } : {}),
      // The artifact channel needs a valid age recipient; the config rejects it
      // without one (and rejects a key set for any other channel), so forward the
      // fixed test recipient exactly when the channel is artifact.
      ...(privateReport === "artifact" ? { report_public_key: ARTIFACT_TEST_RECIPIENT } : {}),
    },
    denial_style: denialStyle,
    owner_kind: "org",
    ...(Object.keys(globalMask).length > 0 ? { token_permissions: globalMask } : {}),
    // Occasionally a GHES-style base URL prefix, as in genScenario.
    ...(rng.fork("base-prefix").bool(0.15) ? { base_prefix: "/api/v3" } : {}),
    repos: repos as Scenario["repos"],
    defaults_file: defaultsFile,
    expect: { exit_code: 0 },
  };
  return {
    scenario,
    meta: {
      repos: repoMetas,
      mode,
      policy,
      privateRepos,
      privateReport,
      selfSlug,
      globalMask,
      ...(forcedPrivateIndex >= 0
        ? { forcedPrivateSlug: `e2e-owner/repo-${forcedPrivateIndex}` }
        : {}),
      milestonesOptOutSlug: optedOutSlug,
    },
  };
}

/** The generation facts a discovery scenario's oracle check consumes. */
export interface DiscoveryScenarioMeta {
  pool: Array<{
    slug: string;
    archived?: boolean;
    fork?: boolean;
    visibility?: string;
    topics?: string[];
  }>;
  filters: {
    visibility?: string;
    archived?: string;
    forks?: string;
    topics?: string;
    exclude?: string;
  };
  /**
   * The `private-repos` policy the discovery run uses. Discovery targets are the
   * one surface with TRUE non-disclosure (their names come only from the private
   * /user/repos listing, never the operator's config), so the fuzzer runs them
   * under redact and checks that a kept private/internal repo is keyed by a
   * placeholder and its slug leaks nowhere.
   */
  privateRepos: "redact" | "show";
}

/**
 * A random `repos: "*"` discovery scenario: a pool of 4 to 8 repos with random
 * archived/fork/visibility/topic attributes, plus a random subset of discovery
 * filters. Each pool repo carries one label so a kept repo applies. The returned
 * meta echoes the pool and filters so predictDiscovery can compute the kept set
 * INDEPENDENTLY, and the fuzz asserts the action discovered exactly those.
 */
export function genDiscoveryScenario(
  rng: Rng,
  /**
   * Battery construction: "converges" pins a non-empty kept set structurally
   * (pool repo 0 non-archived + no filters), so the convergence battery entry
   * exists for EVERY master seed instead of rejection-sampling for one. The
   * unforced path is byte-identical to the pre-force generator; the forced
   * path is deterministic per (seed, force) and battery replays reapply it.
   */
  force?: "converges",
): {
  scenario: Scenario;
  meta: DiscoveryScenarioMeta;
} {
  const count = rng.int(5) + 4; // 4..8
  const TOPIC_POOL = ["platform", "infra", "legacy", "misc"];
  // Discovery always runs under redact (see privateRepos below), so force ONE
  // pool repo non-public: an all-public pool would hand the leak invariant an
  // empty forbidden set and the check would pass vacuously - the same guard
  // genMultiScenario's forced-private target provides.
  const forcedPrivateIndex = rng.int(count);
  const pool: DiscoveryScenarioMeta["pool"] = [];
  for (let i = 0; i < count; i++) {
    const repo: DiscoveryScenarioMeta["pool"][number] = { slug: `e2e-owner/disc-${i}` };
    // This particular roll IS consumed either way (only the outcome is
    // masked): the converges force keeps repo 0 non-archived so the
    // unfiltered kept set is provably non-empty.
    if (rng.bool(0.3) && !(force === "converges" && i === 0)) {
      repo.archived = true;
    }
    if (rng.bool(0.3)) {
      repo.fork = true;
    }
    repo.visibility =
      i === forcedPrivateIndex
        ? rng.pick(["private", "internal"] as const)
        : rng.pick(["public", "private", "internal"]);
    if (rng.bool(0.6)) {
      repo.topics = [rng.pick(TOPIC_POOL)];
    }
    pool.push(repo);
  }

  // A random subset of filters. Each is included ~40% of the time; the values
  // are drawn from the documented allowed sets. exclude uses a glob over slugs.
  // Rolled into `rolledFilters` (these rolls are consumed either way) and
  // overridden to none under the converges force.
  const rolledFilters: DiscoveryScenarioMeta["filters"] = {};
  if (rng.bool(0.4)) {
    rolledFilters.visibility = rng.pick(["all", "public", "private", "internal"]);
  }
  if (rng.bool(0.4)) {
    rolledFilters.archived = rng.pick(["skip", "include", "only"]);
  }
  if (rng.bool(0.4)) {
    rolledFilters.forks = rng.pick(["include", "exclude", "only"]);
  }
  if (rng.bool(0.4)) {
    rolledFilters.topics = rng.pick(TOPIC_POOL);
  }
  if (rng.bool(0.3)) {
    rolledFilters.exclude = `disc-${rng.int(count)}`;
  }
  // Under the converges force no filter applies, so the kept set is exactly
  // the non-archived pool - which provably contains repo 0.
  const filters: DiscoveryScenarioMeta["filters"] = force === "converges" ? {} : rolledFilters;

  const repos: Record<string, unknown> = {};
  for (const repo of pool) {
    repos[repo.slug] = {
      settings: { labels: [{ name: "managed", color: "00ff00" }] },
    };
  }

  const inputs: Record<string, string> = {};
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined) {
      inputs[key] = value;
    }
  }

  // Discovery runs under redact (the default and the realistic case for a
  // fleet with private members); the iteration maps kept private/internal repos
  // to their placeholder keys and checks their slugs leak nowhere.
  const privateRepos = "redact" as const;
  const scenario: Scenario = {
    name: `fuzz-discovery-${rng.seed}`,
    tiers: ["mock"],
    settings: {},
    inputs: { mode: "apply", on_missing_permission: "warn", private_repos: privateRepos },
    denial_style: "fine_grained",
    owner_kind: "org",
    discovery: { pool, inputs },
    repos: repos as Scenario["repos"],
    token_permissions: { issues: "write", contents: "read" },
    expect: { exit_code: 0 },
  };
  return { scenario, meta: { pool, filters, privateRepos } };
}
