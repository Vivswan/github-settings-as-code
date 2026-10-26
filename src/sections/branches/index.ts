/**
 * `branches:` section: classic branch protection, [{name, protection: {...} | null}]. Three keys
 * cannot ride the protection PUT; the one rules query fires only when an entry needs the GraphQL
 * surface, so a pure-REST declaration issues no GraphQL request at all.
 *
 * required_signatures                          -> GitHub's PUT silently drops it; its own POST/DELETE sub-endpoint applies it
 * force_push_bypassers, required_deployments   -> no REST field at all; one updateBranchProtectionRule mutation applies both
 * a WILDCARD name (contains `*`, `?`, or `[`)  -> invisible to every REST protection endpoint; the rule mutations, GraphQL-twin keys only
 */

import { err, ok, type Result, safeTry } from "neverthrow";
import { z } from "zod";
import { type Delta, deltas, phantomNote, renderPath, subsetDiff } from "../../engine/diff.js";
import { isPlainObject, isZeroValue } from "../../plain-data.js";
import { listEntries, type PlainTyped } from "../contract/declared.js";
import { matchesRejection } from "../contract/endpoints.js";
import { type SectionFailure, sectionFailure } from "../contract/errors.js";
import { identifiedBy } from "../contract/keyed-list.js";
import { liveByIdentity, liveIdentity } from "../contract/live.js";
import type { SectionMeta, SectionModule } from "../contract/module.js";
import type { SectionPermission } from "../contract/permissions.js";
import type { PlainData, Read } from "../contract/plan.js";
import { layeredList, routed, rule } from "../shared/schema-helpers.js";
import { ENDPOINTS, MISSING_BRANCH } from "./endpoints.js";
import {
  type BranchesContext,
  type BranchesPlan,
  GRAPHQL,
  type GraphqlRun,
  type RuleNode,
} from "./graphql-ops.js";
import {
  fetchRules,
  fetchRulesForSnapshot,
  routedKeysSnapshot,
  wildcardSnapshot,
} from "./graphql-reads.js";
import {
  GRAPHQL_REVIEW_TWINS,
  GRAPHQL_STATUS_CHECK_TWINS,
  hasRoutedGraphqlKeys,
  type RestOnlyProtection,
  type RoutedProtection,
  type SplitProtection,
  WILDCARD_KEY_SET,
  WILDCARD_KEYS,
} from "./graphql-vocabulary.js";
import {
  justified,
  planRoutedUpdate,
  planWildcardEntry,
  resolveActorIds,
} from "./graphql-writes.js";
import { BOOLEAN_CONTROL_SET, isGetOnlyKey } from "./keys.js";
import {
  type BranchConfig,
  BranchesConfig,
  BranchProtectionConfig,
  copiedActorName,
  PROTECTION_MAPPING_KEYS,
} from "./schema.js";

/** The classic PUT rejects a payload missing any of these; null is a valid value for each. */
export const REQUIRED_PROTECTION_KEYS = [
  "required_status_checks",
  "enforce_admins",
  "required_pull_request_reviews",
  "restrictions",
] as const;

/** The PUT's vocabulary by holder path; a declared key outside it that the GET does not echo is noted as never converging, while a documented key the GET omits (an off control, an optional review setting) is drift the PUT resolves. */
const PROTECTION_VOCABULARY: ReadonlyMap<string, ReadonlySet<string>> = new Map(
  Object.entries({
    ...PROTECTION_MAPPING_KEYS,
    "": [...Object.keys(BranchProtectionConfig.shape), ...BOOLEAN_CONTROL_SET],
    required_pull_request_reviews: [
      ...PROTECTION_MAPPING_KEYS.required_pull_request_reviews,
      ...Object.keys(GRAPHQL_REVIEW_TWINS),
    ],
  }).map(([holder, keys]) => [holder, new Set(keys)]),
);

/**
 * Whether every step of a phantom's path names a key the PUT documents under its holder. The steps
 * are checked one at a time, so a literal key holding a dot never reads as documented nesting.
 */
function isProtectionVocabulary(path: Delta["path"]): boolean {
  let holder = "";
  for (const step of path) {
    if (typeof step !== "string" || !(PROTECTION_VOCABULARY.get(holder)?.has(step) ?? false)) {
      return false;
    }
    holder = holder === "" ? step : `${holder}.${step}`;
  }
  return true;
}

/**
 * The declared keys outside the vocabulary under a documented holder the GET omits entirely: the
 * phantom stops at the absent holder, so its declared mapping is walked here, holder by holder.
 * An empty declared value (null, "") is skipped, as the diff skips it.
 */
function undocumentedKeysUnder(value: unknown, holder: string): string[] {
  const documented = PROTECTION_VOCABULARY.get(holder);
  if (!isPlainObject(value) || documented === undefined) {
    return [];
  }
  return Object.entries(value).flatMap(([key, inner]) => {
    const path = `${holder}.${key}`;
    if (documented.has(key)) {
      return undocumentedKeysUnder(inner, path);
    }
    return inner === null || inner === undefined || inner === "" ? [] : [path];
  });
}

/**
 * The protection passes unknown keys through, so a key GitHub never echoes would re-PUT on every
 * apply without converging; the note names it beside the drift it causes. An unprotected branch
 * scans against an empty live object, so the note lands on the run that plans the first PUT.
 */
function noteUndocumentedKeys(
  plan: BranchesPlan,
  prefix: string,
  declared: Record<string, unknown>,
  live: unknown,
): void {
  const phantom = undocumentedPhantoms(declared, live);
  if (phantom.length > 0) {
    plan.notes.push(phantomNote(prefix, phantom, "branch protection", "this PUT will re-run"));
  }
}

/** The declared keys the GET does not echo and the PUT does not document, as dotted paths for the note. */
function undocumentedPhantoms(declared: Record<string, unknown>, live: unknown): string[] {
  return deltas(declared, live).flatMap((delta) => {
    if (delta.kind !== "phantom") {
      return [];
    }
    return isProtectionVocabulary(delta.path)
      ? undocumentedKeysUnder(delta.desired, delta.path.join("."))
      : [renderPath("", delta.path)];
  });
}

/** Git refnames forbid `*`, `?`, and `[`, so a wildcard entry can never collide with a literal branch. */
export function isWildcardPattern(name: string): boolean {
  return /[*?[]/.test(name);
}

// GitHub spells this one list two ways inside required_status_checks and the GET returns both, so a declaration carrying either covers the other.
const STATUS_CHECK_ALIASES: Readonly<Record<string, string>> = {
  "required_status_checks.checks": "required_status_checks.contexts",
  "required_status_checks.contexts": "required_status_checks.checks",
};

/**
 * Nothing the replacing PUT would need to preserve: GitHub's default fill under a declared block,
 * an empty list, or a review-side actor holder with empty lists (GitHub reads it as off and omits
 * it). Any other nested object is a control that is ON by its presence, `restrictions` included:
 * an all-empty one restricts pushes to nobody, and the GET omits the key only when unrestricted.
 */
function isEmptySetting(key: string, value: unknown): boolean {
  if (isZeroValue(value)) {
    return true;
  }
  if (isPlainObject(value) && REVIEW_ACTOR_HOLDER_SET.has(key)) {
    const keys = Object.keys(value);
    return (
      keys.length > 0 &&
      keys.every((inner) => ACTOR_LIST_KEYS.has(inner) && isEmptySetting(inner, value[inner]))
    );
  }
  return false;
}

/**
 * The PUT replaces each nested object whole, so every non-empty live value at a path the
 * declaration omits, at any depth, would be reset by it.
 */
function omittedLiveDrift(
  declared: Record<string, unknown>,
  live: Record<string, unknown>,
  prefix: string,
  path = "",
): string[] {
  const drift: string[] = [];
  for (const [key, value] of Object.entries(live)) {
    const keyPath = path === "" ? key : `${path}.${key}`;
    if (Object.hasOwn(declared, key)) {
      const inner = declared[key];
      if (isPlainObject(inner) && isPlainObject(value)) {
        drift.push(...omittedLiveDrift(inner, value, prefix, keyPath));
      }
      continue;
    }
    const alias = STATUS_CHECK_ALIASES[keyPath];
    if (alias !== undefined && Object.hasOwn(declared, alias.slice(alias.lastIndexOf(".") + 1))) {
      continue;
    }
    if (isEmptySetting(key, value)) {
      continue;
    }
    drift.push(
      `${prefix}.${keyPath}: set live but omitted from the settings file, so apply would REMOVE it; add ${keyPath} to the branch's protection in the settings file to keep it`,
    );
  }
  return drift;
}

const permission: SectionPermission = { repo: ["administration"] };

const LiveProtection = z.looseObject({
  required_signatures: z.looseObject({ enabled: z.boolean() }).optional(),
});

const LiveBranchSummary = z.looseObject({ name: z.string() });

/**
 * Built in the ONE place that decides whether the GraphQL run state exists, so no other site re-spells the predicate.
 * The run rides exactly the entries that need it: a literal entry's protection carries no routed key, so no
 * shape says "routed keys without the run". Exported for the compile-time controls in branches.test.ts.
 */
export type ClassifiedEntry =
  | { kind: "wildcard"; branch: BranchConfig; graphqlRun: GraphqlRun }
  | {
      kind: "routed";
      branch: { name: string; protection: PlainTyped<RoutedProtection> };
      graphqlRun: GraphqlRun;
    }
  | {
      kind: "literal";
      branch: { name: string; protection: PlainTyped<RestOnlyProtection> | null };
    };

/** A literal or routed entry's declared protection, once known not to be null. */
type LiteralProtection = NonNullable<
  Exclude<ClassifiedEntry, { kind: "wildcard" }>["branch"]["protection"]
>;

type ProtectionProbe = { data: z.infer<typeof LiveProtection> } | { missing: true };

/** One literal entry's PUT as planned against its probe. */
interface ProtectionPut {
  name: string;
  prefix: string;
  params: { branch: string };
  payload: Record<string, PlainData | undefined>;
  declared: LiteralProtection;
}

/** The declared signatures toggle beside what the PUT planning learned of the branch. */
interface SignatureToggle {
  name: string;
  prefix: string;
  params: { branch: string };
  required: boolean;
  live: Record<string, unknown> | null;
  putPlanned: boolean;
}

/**
 * A literal-pattern rule the REST reads did not surface as a protected branch: no branch of that
 * name exists (a pattern needs none), or its protection probe was denied. A literal entry applies
 * through the REST PUT, which needs the branch, so the rule is noted instead of written. The
 * pattern appears once and the text stays short, so the rendered header line ("# " prefixed)
 * stays under 256 chars for patterns up to 54 chars.
 */
function unreachableLiteralRuleNote(pattern: string): string {
  return (
    `branches[${pattern}]: rule kept out of the snapshot: REST read no protected branch by this ` +
    "name (the branch is missing, or its protection is unreadable); create the branch or fix the " +
    "grant, then snapshot again"
  );
}

function wildcardKeyError(name: string, key: string): string {
  return (
    `the wildcard entry "${name}" declares protection.${key}, which this section does not manage on wildcard rules; ` +
    `only the keys it can round-trip through the GraphQL rule mutations apply here: [${WILDCARD_KEYS.join(", ")}]. ` +
    "For actor lists and richer controls, prefer the rulesets section (the modern successor of classic protection)"
  );
}

/**
 * The keys a wildcard entry declares that the rule mutations cannot round-trip, each as its path
 * steps under protection. The structured pairs translate NAMED sub-keys only, so an unknown sub-key
 * would be silently lost; the schema already holds each pair to a mapping or null.
 */
function wildcardKeysOutsideVocabulary(protection: Record<string, unknown>): string[][] {
  const outside: string[][] = [];
  for (const key of Object.keys(protection)) {
    if (!WILDCARD_KEY_SET.has(key)) {
      outside.push([key]);
    }
  }
  const nested: Array<[string, Record<string, string>]> = [
    ["required_status_checks", GRAPHQL_STATUS_CHECK_TWINS],
    ["required_pull_request_reviews", GRAPHQL_REVIEW_TWINS],
  ];
  for (const [key, twins] of nested) {
    const value = protection[key];
    if (!isPlainObject(value)) {
      continue;
    }
    for (const subKey of Object.keys(value)) {
      if (!(subKey in twins)) {
        outside.push([key, subKey]);
      }
    }
  }
  return outside;
}

/**
 * The declared protection a live GET body reads back as: flattenProtection's PUT vocabulary with
 * every top-level control that is off dropped, since the replacing PUT resets an omitted control
 * to off anyway.
 */
export function protectionSnapshot(live: Record<string, unknown>): BranchProtectionConfig {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(flattenProtection(live))) {
    if (value !== false && value !== null && value !== undefined) {
      out[key] = value;
    }
  }
  // The engine validates the assembled document, so this cast is the projection boundary.
  return out as BranchProtectionConfig;
}

function startGraphqlRun(ctx: BranchesContext): Read<GraphqlRun> {
  return fetchRules(ctx).map((rules) => ({
    rules,
    repoId: null,
    actorIds: new Map(),
    lateActors: [],
  }));
}

/**
 * GET /protection wraps booleans as {url, enabled} and expands actor lists into user/team/app
 * OBJECTS, while the PUT shape uses login/slug strings; both unwrap so check compares like with
 * like. Exported so the e2e state tests can assert their protectionFromPut inverts this exact function.
 */
export function flattenProtection(live: Record<string, unknown>): Record<string, unknown> {
  const out = flattenValue(live) as Record<string, unknown>;
  const checks = out.required_status_checks;
  if (isPlainObject(checks)) {
    out.required_status_checks = putStatusChecks(checks);
  }
  return out;
}

/**
 * The required status checks in the PUT's spelling, applied to the live body and the declared
 * payload alike so both sides compare equal: "any App may report this check" reads back as app_id
 * null but the PUT takes -1 (an omitted app_id lets GitHub pin whichever App reported last), and
 * the PUT still requires `contexts` beside `checks`, so a body carrying only `checks` (a mock
 * storing a PUT verbatim) gets the names derived from it.
 */
function putStatusChecks<T extends Record<string, unknown>>(status: T): T {
  if (!Array.isArray(status.checks)) {
    return status;
  }
  const checks = status.checks.map((check) =>
    isPlainObject(check) && check.app_id === null ? { ...check, app_id: -1 } : check,
  );
  const contexts = Array.isArray(status.contexts)
    ? status.contexts
    : checks.flatMap((check) =>
        isPlainObject(check) && typeof check.context === "string" ? [check.context] : [],
      );
  return { ...status, checks, contexts };
}

const ACTOR_LIST_KEYS = new Set(["users", "teams", "apps"]);

/**
 * GitHub matches a login or slug in any case and reads back its own spelling, so the compare folds
 * every actor list on both sides; the PUT still carries the file's spelling and the snapshot GitHub's.
 *   declared users: [Octocat]  vs  live users: [octocat]  -> clean
 */
function foldActorNames(protection: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(protection)) {
    if (ACTOR_LIST_KEYS.has(key) && Array.isArray(value)) {
      out[key] = value.map((name) => (typeof name === "string" ? name.toLowerCase() : name));
    } else {
      out[key] = isPlainObject(value) ? foldActorNames(value) : value;
    }
  }
  return out;
}

// GitHub serves these two holders only when they name someone (an all-empty one is "no restriction" and the GET omits the key); the top-level restrictions is NOT one of them.
const REVIEW_ACTOR_HOLDERS = ["dismissal_restrictions", "bypass_pull_request_allowances"] as const;

// The string-keyed view for the walks whose keys are plain strings.
const REVIEW_ACTOR_HOLDER_SET: ReadonlySet<string> = new Set(REVIEW_ACTOR_HOLDERS);

/**
 * A live review block without a holder reads as the all-empty holder, so a declared empty one is
 * clean and a declared actor diffs against an empty list instead of a missing field. Compare-only:
 * the snapshot writes the GET's own shape. `restrictions` stays as read, since an all-empty one is
 * a restriction that lets nobody push, ON by its presence.
 */
function withEmptyReviewHolders(live: Record<string, unknown>): Record<string, unknown> {
  const reviews = live.required_pull_request_reviews;
  if (!isPlainObject(reviews)) {
    return live;
  }
  const filled = { ...reviews };
  for (const holder of REVIEW_ACTOR_HOLDERS) {
    filled[holder] ??= { users: [], teams: [], apps: [] };
  }
  return { ...live, required_pull_request_reviews: filled };
}

function flattenValue(value: unknown): unknown {
  if (typeof value !== "object" || value === null) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(flattenValue);
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    "enabled" in record &&
    typeof record.enabled === "boolean" &&
    keys.every((k) => k === "enabled" || k === "url" || k.endsWith("_url"))
  ) {
    return record.enabled;
  }
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(record)) {
    if (ACTOR_LIST_KEYS.has(key) && Array.isArray(inner)) {
      out[key] = inner.map((actor) => copiedActorName(actor) ?? actor);
      continue;
    }
    if (isGetOnlyKey(key)) {
      // The GET-only vocabulary at any depth (keys.ts); the schema refuses the same keys in a declaration.
      continue;
    }
    out[key] = flattenValue(inner);
  }
  return out;
}

/**
 * The REST PUT's body: GitHub's PUT silently DROPS required_signatures and the other two routed
 * keys have no REST field at all, so none of them rides it; the core keys are present (null when
 * the file omits one) and the status checks are in the PUT's spelling.
 */
function restPayload(protection: LiteralProtection): Record<string, PlainData | undefined> {
  const {
    required_signatures: _signatures,
    force_push_bypassers: _bypassers,
    required_deployments: _deployments,
    ...payload
  } = protection;
  for (const key of REQUIRED_PROTECTION_KEYS) {
    if (!(key in payload)) {
      payload[key] = null;
    }
  }
  if (isPlainObject(payload.required_status_checks)) {
    payload.required_status_checks = putStatusChecks(payload.required_status_checks);
  }
  return payload;
}

/**
 * The drift a replacing PUT resolves: the declared values that differ from the live ones, and the
 * live settings the declaration omits, which the PUT would remove. The undocumented-key note lands
 * here too.
 */
function replacingPutDrift(
  plan: BranchesPlan,
  put: ProtectionPut,
  live: Record<string, unknown>,
): readonly [string, ...string[]] | null {
  const declaredRest: Record<string, unknown> = { ...put.payload };
  for (const key of REQUIRED_PROTECTION_KEYS) {
    if (!(key in put.declared)) {
      delete declaredRest[key];
    }
  }
  // Both sides compare in GitHub's spelling; the PUT payload keeps the file's.
  const declaredView = foldActorNames(declaredRest);
  const liveView = withEmptyReviewHolders(foldActorNames(live));
  noteUndocumentedKeys(plan, put.prefix, declaredView, liveView);
  // The PUT replaces the whole protection, so live settings the declaration omits are REMOVED by
  // it: drift, not silence. The signature toggle is the one live field the PUT never touches.
  const { required_signatures: _liveSignatures, ...liveRest } = liveView;
  return justified([
    ...subsetDiff(declaredView, liveView, put.prefix),
    ...omittedLiveDrift(declaredView, liveRest, put.prefix),
  ]);
}

/**
 * The protection PUT the probe calls for, if any: the first PUT on an unprotected branch (a missing
 * branch is refused first), or the replacing PUT when the live protection drifts. Answers the live
 * view the signature toggle compares against, null when unprotected, and whether a PUT was planned.
 */
async function planProtectionPut(
  ctx: BranchesContext,
  section: SectionMeta,
  plan: BranchesPlan,
  put: ProtectionPut,
  probe: ProtectionProbe,
): Promise<Result<{ live: Record<string, unknown> | null; putPlanned: boolean }, SectionFailure>> {
  return safeTry(async function* () {
    const { name, prefix, params, payload } = put;
    if ("missing" in probe) {
      // Protection 404s for a missing BRANCH too; the advisory probe tells the two apart. A denied probe
      // is a 404 "Not Found" as well (fine-grained tokens conceal denied reads), so only GitHub's own
      // body counts and a denial keeps the plain unprotected reading.
      const branchProbe = yield* ctx.read.branchProbe.tryCall(z.unknown(), { params });
      if ("error" in branchProbe && matchesRejection(MISSING_BRANCH, branchProbe.error)) {
        // The same failure the PUT raises without the Contents grant, so the outcome does not depend on it.
        return err(
          sectionFailure("refused", `${section.key}: branches[${name}]: ${MISSING_BRANCH.advice}`),
        );
      }
      noteUndocumentedKeys(plan, prefix, payload, {});
      plan.ops.push({
        role: "putProtection",
        params,
        payload,
        describe: `replacing protection for branch "${name}"`,
        drift: [
          `branches[${name}]: unprotected live but the settings file declares protection; apply will protect it`,
        ],
        change: `applied protection to "${name}"`,
      });
      return ok({ live: null, putPlanned: true });
    }
    const live = flattenProtection(probe.data);
    // The protection GET OMITS required_signatures entirely when signed commits are not required,
    // so an absent live field means false; normalized so declared false does not read as drift.
    if (!("required_signatures" in live)) {
      live.required_signatures = false;
    }
    const drift = replacingPutDrift(plan, put, live);
    if (drift === null) {
      return ok({ live, putPlanned: false });
    }
    plan.ops.push({
      role: "putProtection",
      params,
      payload,
      describe: `replacing protection for branch "${name}"`,
      drift,
      change: `applied protection to "${name}"`,
    });
    return ok({ live, putPlanned: true });
  });
}

/**
 * The toggle applies through its sub-endpoint once the PUT has ensured the protection (and with it
 * the sub-resource) exists, and again after a planned PUT, since GitHub does not document whether
 * the PUT preserves it.
 */
function planSignatureToggle(plan: BranchesPlan, toggle: SignatureToggle): void {
  const { name, prefix, params, required, live, putPlanned } = toggle;
  const sigDrift = subsetDiff(
    { required_signatures: required },
    { required_signatures: live?.required_signatures ?? false },
    prefix,
  );
  if (sigDrift.length === 0 && putPlanned) {
    sigDrift.push(
      `${prefix}.required_signatures: re-applied after the protection PUT (GitHub does not document whether the PUT preserves it)`,
    );
  }
  const drift = justified(sigDrift);
  if (drift === null) {
    return;
  }
  if (required) {
    plan.ops.push({
      role: "sigPost",
      params,
      describe: `requiring signed commits on branch "${name}"`,
      drift,
      change: `required signed commits on "${name}"`,
    });
    return;
  }
  plan.ops.push({
    role: "sigDelete",
    params,
    describe: `removing the signed-commit requirement from branch "${name}"`,
    drift,
    change: `removed the signed-commit requirement from "${name}"`,
  });
}

/** A literal entry's operations in order: the PUT (or the removal), the signatures toggle, the routed update. */
async function planLiteralEntry(
  ctx: BranchesContext,
  section: SectionMeta,
  entry: Exclude<ClassifiedEntry, { kind: "wildcard" }>,
  plan: BranchesPlan,
): Promise<Result<void, SectionFailure>> {
  return safeTry(async function* () {
    const { branch } = entry;
    const params = { branch: branch.name };
    const prefix = `branches[${branch.name}].protection`;
    const probe = yield* ctx.read.getProtection.probeAbsent(LiveProtection, {
      params,
      describe: `branch "${branch.name}"`,
    });
    if (branch.protection === null) {
      if ("missing" in probe) {
        return ok(undefined);
      }
      plan.ops.push({
        role: "removeProtection",
        params,
        drift: [
          `branches[${branch.name}]: protected live but the settings file declares protection: null; apply will remove the protection`,
        ],
        change: `removed protection from "${branch.name}"`,
      });
      return ok(undefined);
    }
    const put: ProtectionPut = {
      name: branch.name,
      prefix,
      params,
      payload: restPayload(branch.protection),
      declared: branch.protection,
    };
    const { live, putPlanned } = yield* await planProtectionPut(ctx, section, plan, put, probe);
    const requiredSignatures = branch.protection.required_signatures;
    // An undeclared toggle leaves the live requirement alone.
    if (requiredSignatures !== undefined) {
      planSignatureToggle(plan, {
        name: branch.name,
        prefix,
        params,
        required: requiredSignatures,
        live,
        putPlanned,
      });
    }
    if (entry.kind === "routed") {
      planRoutedUpdate(ctx, entry.graphqlRun, plan, {
        name: branch.name,
        protection: entry.branch.protection,
        prefix,
        putPlanned,
      });
    }
    return ok(undefined);
  });
}

/**
 * The entries by the surface they apply through. The first entry that needs the GraphQL surface
 * starts the one rules read, ahead of every REST probe; a pure-REST declaration never starts it,
 * so no separate predicate gates the fetch.
 */
async function classifyEntries(
  ctx: BranchesContext,
  branches: readonly PlainTyped<BranchConfig>[],
): Promise<Result<{ entries: ClassifiedEntry[]; graphqlRun: GraphqlRun | null }, SectionFailure>> {
  return safeTry(async function* () {
    let graphqlRun: GraphqlRun | null = null;
    const entries: ClassifiedEntry[] = [];
    for (const branch of branches) {
      const protection: PlainTyped<SplitProtection> | null = branch.protection;
      if (isWildcardPattern(branch.name)) {
        graphqlRun ??= yield* startGraphqlRun(ctx);
        entries.push({ kind: "wildcard", branch, graphqlRun });
      } else if (hasRoutedGraphqlKeys(protection)) {
        graphqlRun ??= yield* startGraphqlRun(ctx);
        entries.push({ kind: "routed", branch: { name: branch.name, protection }, graphqlRun });
      } else {
        entries.push({ kind: "literal", branch: { name: branch.name, protection } });
      }
    }
    return ok({ entries, graphqlRun });
  });
}

/** A note per live wildcard rule the file does not declare: this action never deletes undeclared rules. */
function undeclaredRuleNotes(
  graphqlRun: GraphqlRun,
  branches: readonly { name: string }[],
): string[] {
  const declaredPatterns = new Set(branches.map((branch) => branch.name));
  return [...(graphqlRun.rules?.keys() ?? [])]
    .sort()
    .filter((pattern) => isWildcardPattern(pattern) && !declaredPatterns.has(pattern))
    .map(
      (pattern) =>
        `undeclared classic protection rule "${pattern}" exists on the repo - declare it to manage it (this action never deletes undeclared rules)`,
    );
}

/**
 * Every actor a planned mutation resolves at execution resolves ahead of the plan's FIRST write,
 * whichever entry it belongs to: a misspelled actor fails while every branch's live protection
 * is still untouched, and the mutations' thunks then find the ids cached.
 */
function withActorsResolvedFirst(
  ctx: BranchesContext,
  graphqlRun: GraphqlRun,
  ops: BranchesPlan["ops"],
): BranchesPlan["ops"] {
  const [lead, ...rest] = ops;
  if (graphqlRun.lateActors.length === 0 || lead === undefined) {
    return ops;
  }
  return [
    {
      ...lead,
      before: async (exec) =>
        (await resolveActorIds(ctx, exec, graphqlRun, graphqlRun.lateActors)).map(() => undefined),
    },
    ...rest,
  ];
}

/**
 * A literal entry per listed branch whose protection probe answers and whose own rule the rules
 * read carries. A branch only a wildcard rule matches is left to that rule's entry, since a
 * literal entry here would create a second rule on apply.
 */
async function literalSnapshotEntries(
  ctx: BranchesContext,
  listed: readonly { name: string }[],
  rules: ReadonlyMap<string, RuleNode>,
): Promise<Result<BranchConfig[], SectionFailure>> {
  return safeTry(async function* () {
    const entries: BranchConfig[] = [];
    for (const { name } of listed) {
      const probe = yield* ctx.read.getProtection.probeAbsent(LiveProtection, {
        params: { branch: name },
        describe: `branch "${name}"`,
      });
      if ("missing" in probe) {
        continue;
      }
      const rule = rules.get(name);
      if (rule === undefined) {
        continue;
      }
      entries.push({
        name,
        protection: { ...protectionSnapshot(probe.data), ...routedKeysSnapshot(rule) },
      });
    }
    return ok(entries);
  });
}

/**
 * The wildcard rules as entries in connection order, never sorted (GitHub applies overlapping
 * wildcard rules in creation order, which the connection lists, and apply creates the entries in
 * file order), and a note per literal rule no written entry covers.
 */
function wildcardSnapshotEntries(
  rules: ReadonlyMap<string, RuleNode>,
  written: ReadonlySet<string>,
): { entries: BranchConfig[]; notes: string[] } {
  const entries: BranchConfig[] = [];
  const notes: string[] = [];
  for (const [pattern, rule] of rules) {
    if (isWildcardPattern(pattern)) {
      entries.push({ name: pattern, protection: wildcardSnapshot(rule) });
    } else if (!written.has(pattern)) {
      notes.push(unreachableLiteralRuleNote(pattern));
    }
  }
  return { entries, notes };
}

export const branchesSection = {
  // Branch names and patterns are verbatim keys; two entries for one would overwrite each other's write on every run.
  ...identifiedBy("branches", "name", "branch"),
  undeclaredDefault: "untouched",
  permission,
  endpoints: ENDPOINTS,
  graphql: GRAPHQL,
  // The wildcard key sweep composes HERE, not in schema.ts: it reads the GraphQL translation tables,
  // which are this section's own machinery, and nothing outside them can reach a wildcard rule.
  shape: routed(layeredList(BranchesConfig)).check(
    rule((declared, refineCtx) => {
      // The routed shape parsed one of the two forms; under the wrapper an issue's path starts at `entries`.
      const wrapped = !Array.isArray(declared);
      const entries = listEntries(declared as BranchConfig[] | { entries: BranchConfig[] });
      const at = (index: number, ...rest: string[]): (string | number)[] => [
        ...(wrapped ? ["entries"] : []),
        index,
        ...rest,
      ];
      entries.forEach((entry: BranchConfig, index) => {
        // The entry, its name, or its protection may be raw or missing beside its own shape issue; a regex would
        // coerce the name (`[object Object]` wildcards), and a non-mapping protection holds no keys to sweep.
        if (
          !isPlainObject(entry) ||
          typeof entry.name !== "string" ||
          !isWildcardPattern(entry.name)
        ) {
          return;
        }
        const protection = entry.protection;
        if (!isPlainObject(protection)) {
          return;
        }
        for (const steps of wildcardKeysOutsideVocabulary(protection)) {
          refineCtx.addIssue({
            code: "custom",
            path: at(index, "protection", ...steps),
            message: wildcardKeyError(entry.name, steps.join(".")),
          });
        }
      });
    }),
  ),
  async plan(ctx, desired): Promise<Result<BranchesPlan, SectionFailure>> {
    const section = this;
    return safeTry(async function* () {
      const branches = listEntries(desired);
      const plan: BranchesPlan = { ops: [], notes: [], drift: [] };
      const { entries, graphqlRun } = yield* await classifyEntries(ctx, branches);
      if (graphqlRun !== null) {
        plan.notes.push(...undeclaredRuleNotes(graphqlRun, branches));
      }
      for (const entry of entries) {
        if (entry.kind === "wildcard") {
          await planWildcardEntry(ctx, entry.graphqlRun, entry.branch, plan);
          continue;
        }
        yield* await planLiteralEntry(ctx, section, entry, plan);
      }
      if (graphqlRun !== null) {
        plan.ops = withActorsResolvedFirst(ctx, graphqlRun, plan.ops);
      }
      return ok(plan);
    });
  },
  // The listing also names branches only a ruleset protects, whose classic protection probe answers
  // 404: nothing to declare here. The engine notes the denial that 404 could also be when every
  // listed branch answers it. The rules read is unconditional, unlike plan()'s: it is the only view
  // of the wildcard rules and of the two routed keys, and it names which rule protects a branch.
  async snapshot(ctx) {
    const section = this;
    return safeTry(async function* () {
      const listed = yield* ctx.read.listProtected.listAll(LiveBranchSummary, {
        query: { protected: "true" },
      });
      // Git refnames are exact, so the fold is the name itself.
      yield* liveByIdentity(
        section,
        "protected branch",
        listed,
        (branch) => branch.name,
        (branch) => liveIdentity(branch.name),
      );
      const rules = yield* fetchRulesForSnapshot(ctx);
      const literal = yield* await literalSnapshotEntries(ctx, listed, rules);
      const written = new Set(literal.map((entry) => entry.name));
      const wildcard = wildcardSnapshotEntries(rules, written);
      const entries = [...literal, ...wildcard.entries];
      if (entries.length === 0) {
        return ok({ value: undefined, notes: wildcard.notes });
      }
      return ok({ value: entries, notes: wildcard.notes });
    });
  },
} satisfies SectionModule<"branches", typeof ENDPOINTS, typeof GRAPHQL>;
