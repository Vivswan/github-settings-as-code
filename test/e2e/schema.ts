/**
 * Zod-validated Scenario type for the e2e harness. A scenario fully describes
 * one hermetic run: the settings file and action inputs, the token's
 * permission mask and how denials are shaped, the mock's starting live state,
 * and the expected outcome. The loader validates every scenario file against
 * this schema, so a malformed scenario fails loudly at load time (naming the
 * file and the offending field) rather than producing a confusing run.
 */

import { type Dirent, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { FILTER_INPUTS } from "../../src/action/inputs.js";
import { RESERVED_REF_PREFIXES } from "../../src/action/secret-refs.js";
import { MARKER_LABEL, MARKER_LABEL_CONFIG } from "../../src/report/issue-report.js";
import type { MustBeNever } from "../../src/schema.js";
import type { PatResource } from "../../src/sections/contract.js";
import type { LiveState } from "./mock/state.js";

/** The tiers a scenario can run against. Only "mock" exists today; "live" is
 * reserved for a future App-token tier so scenarios can opt in later. */
const TierSchema = z.enum(["mock", "live"]);

/**
 * The permission mask keys: every fine-grained PAT resource plus the
 * organization "members" grant (teams need it, and it is not a PatResource).
 * The `satisfies` keeps this list in lockstep with PatResource - a new
 * resource that is not listed here fails to compile.
 */
export const MASK_KEYS = [
  "administration",
  "issues",
  "environments",
  "actions",
  "pages",
  "code_scanning_alerts",
  "contents",
  "variables",
  "webhooks",
  "secrets",
  "dependabot_secrets",
  "codespaces_secrets",
  "custom_properties",
  "secret_scanning_alerts",
  "agent_secrets",
  "agent_variables",
  "checks",
  "org_members",
] as const satisfies readonly (PatResource | "org_members")[];

/** Compile-time tripwire: a PatResource missing from MASK_KEYS fails here. */
type _MaskCoversEveryResource = MustBeNever<Exclude<PatResource, (typeof MASK_KEYS)[number]>>;

const MaskKeySchema = z.enum(MASK_KEYS);

/** Access level granted to a masked resource. */
const MaskGradeSchema = z.enum(["none", "read", "write"]);

/**
 * How denied resources answer. "fine_grained" (the default) mirrors real
 * fine-grained tokens: a denied read answers 404 "Not Found", a denied write
 * answers 403 "Resource not accessible by personal access token". The numeric
 * styles answer every denial uniformly with that status.
 */
const DenialStyleSchema = z.union([z.literal("fine_grained"), z.literal(403), z.literal(404)]);

/** Which account kind the mock owner presents as (teams behave differently). */
const OwnerKindSchema = z.enum(["org", "user"]);

/**
 * The action inputs a scenario can set; all optional with runner defaults.
 * required_sections and sections are comma-separated strings, matching the
 * action's own INPUT_REQUIRED-SECTIONS / INPUT_SECTIONS wire format.
 */
const InputsSchema = z
  .object({
    mode: z.enum(["apply", "check"]).optional(),
    on_missing_permission: z.enum(["fail", "warn"]).optional(),
    required_sections: z.string().optional(),
    sections: z.string().optional(),
    private_repos: z.enum(["redact", "show"]).optional(),
    private_report: z.enum(["none", "issue", "issue-on-failure", "artifact"]).optional(),
    /**
     * The age recipient the `artifact` channel encrypts the report to,
     * forwarded as INPUT_REPORT-PUBLIC-KEY. A config-rejection scenario sets a
     * malformed value on purpose; a delivery scenario sets a valid generated
     * recipient (see ARTIFACT_TEST_RECIPIENT in the runner).
     */
    report_public_key: z.string().optional(),
  })
  .strict();

/**
 * The expected outcome of a run. Every field is optional except exit_code; the
 * runner asserts only what a scenario declares, in a fixed order (violations
 * first, then exit code, then the rest), so a partial expectation still pins
 * the parts it names.
 */
const ExpectSchema = z
  .object({
    /**
     * The process exit code (0 clean/applied, 1 failed). A non-empty array
     * lists every ALLOWED code: the fuzz oracle predicts a set of legal exits
     * (per-section outcome classes can land on either side of the worst-of
     * fold), and the runner asserts membership. Curated scenarios keep the
     * plain number.
     */
    exit_code: z.union([z.number().int(), z.array(z.number().int()).min(1)]),
    /** The `result` output ("clean", "drift", "applied", "failed", ...). */
    result: z.string().optional(),
    /**
     * The published `skipped-sections` output as a set: the comma-joined
     * value must contain exactly these section keys, in any order. This is
     * the skipped-sections projection's end-to-end pin - a section skipped
     * under on-missing-permission: warn must surface here, not only in the
     * summary table.
     */
    skipped_sections: z.array(z.string()).optional(),
    /** Per-section outcome parsed from the step-summary table. */
    outcomes: z.record(z.string(), z.string()).optional(),
    /**
     * Ordered "METHOD /path" prefixes the write request log must contain as
     * a subsequence. `{repo}` is a placeholder the loader expands to the
     * scenario's owner/name before matching. A GraphQL operation is spelled
     * "GRAPHQL <opName>" (every GraphQL call shares POST /graphql, so the
     * operation name is the log's rendering), and a GraphQL READ never
     * appears in the write log despite its POST method.
     */
    mutations: z.array(z.string()).optional(),
    /**
     * "METHOD /path" (or "GRAPHQL <opName>") prefixes that must NEVER appear
     * in the request log.
     */
    never: z.array(z.string()).optional(),
    /** Substrings the step summary must contain. */
    summary_contains: z.array(z.string()).optional(),
    /**
     * Substrings the step summary must NOT contain: the redaction leak guard.
     * A redacted target's slug and its private live values must never reach the
     * publicly-readable summary, so a private scenario lists them here.
     */
    summary_lacks: z.array(z.string()).optional(),
    /** Substrings stdout must contain. */
    stdout_contains: z.array(z.string()).optional(),
    /**
     * Substrings stdout must NOT contain, matched AFTER the runner strips the
     * `::add-mask::` lines core.setSecret emits (those lines legitimately carry
     * the raw slug so the real runner can mask it; nothing else may). The
     * redaction leak guard for logs and workflow-command annotations, which
     * both land on stdout.
     */
    stdout_lacks: z.array(z.string()).optional(),
    /**
     * Substrings that must appear on NO publicly-readable surface at all: the
     * step summary, stdout, stderr (both with the `::add-mask::` lines stripped),
     * AND every action output value. This is the whole-surface leak invariant -
     * the same checkLeaks primitive the fuzzer applies - for a scenario that
     * needs to prove a slug or sentinel leaked NOWHERE, not just from one named
     * surface. Prefer this over listing the same needle in summary_lacks AND
     * stdout_lacks; reserve those two for a string that is allowed on one surface
     * but forbidden on another.
     */
    leaks_nowhere: z.array(z.string()).optional(),
    /**
     * The private-report issue channel's delivery to one target repo. The runner
     * inspects the recorded issue create/patch requests for that slug:
     *   - `body_contains`: substrings the delivered report body must include (the
     *     full unredacted detail, incl the sentinel) - the create body, or the
     *     PATCH body on a reuse run.
     *   - `title`: the created issue's title (checked only on create).
     *   - a created issue must ALWAYS carry the marker label (the lookup key);
     *     this is asserted unconditionally, not gated by a field.
     *   - `lookup_by_label`: assert the issues list GET used the labels=<marker>
     *     filter (the one-indexed-request lookup the reuse path depends on).
     *   - `labels`: the exact label-name array carried by the LAST issue write
     *     (create or PATCH) that set a labels field - the marker-reattach
     *     witness: a fallback-scan hit must reattach the stripped marker
     *     WITHOUT clobbering human-added labels.
     *   - `state`: the final open/closed state after all create/patch writes.
     *   - `created_count`: how many report issues were POSTed for the slug (1 =
     *     created once; 0 = none, e.g. the permission-denied or reuse path).
     * This is the only place the private slug and sentinel may legitimately appear.
     */
    issue_report: z
      .object({
        slug: z.string(),
        title: z.string().optional(),
        body_contains: z.array(z.string()).optional(),
        state: z.enum(["open", "closed"]).optional(),
        created_count: z.number().int().optional(),
        lookup_by_label: z.boolean().optional(),
        labels: z.array(z.string()).optional(),
      })
      .strict()
      .optional(),
    /**
     * Requests (any method) the log must contain, e.g. a `page=2` read that
     * proves pagination was exercised. Matched as substrings of "METHOD path".
     */
    requests_contain: z.array(z.string()).optional(),
    /**
     * When true, the mock must have received ZERO requests: the failure under
     * test (e.g. a settings_raw parse failure, read from the local filesystem
     * before the client is ever used) must fire before any API contact. The
     * same invariant the input fuzzer asserts, available to curated scenarios.
     */
    zero_requests: z.boolean().optional(),
    /**
     * When true, the runner reruns the scenario in check mode against the SAME
     * mutated mock and expects exit 0 with zero writes (the convergence proof).
     * Folded into `fixpoint: "converges"` by the transform below.
     */
    converges: z.boolean().optional(),
    /**
     * When true, the runner re-runs the scenario in APPLY mode a second time
     * against the SAME mutated mock and proves apply is a fixpoint: the second
     * apply exits 0; no compare-before-write section (COMPARE_BEFORE_WRITE in
     * apply-idempotence.ts) issues a write; the mock's working state is
     * unchanged family by family (unconditional-PUT sections may write again,
     * but must rewrite the same state); and a final check-mode run converges
     * (exit 0, zero writes), so `converges` cannot be set alongside.
     * Requires an apply-mode scenario WITHOUT the issue report channel: that
     * channel embeds a fresh timestamp in the report issue (state moves every
     * run) and injects the marker label into the labels declaration, so no
     * run under it is a fixpoint. Folded into `fixpoint: "apply_idempotent"`
     * by the transform below.
     */
    apply_idempotent: z.boolean().optional(),
    /**
     * The canonical spelling of the armed fixpoint re-run proof, which the
     * transform below emits - accepted on input so a dumped artifact
     * scenario.yml (stringified AFTER the transform) reparses. Set this or
     * one legacy boolean, never both.
     */
    fixpoint: z.enum(["converges", "apply_idempotent"]).optional(),
    /**
     * Multi-repo: the expected per-target rollup, parsed from the action's
     * `repos-result` JSON output, keyed by "owner/name" slug -> result string
     * ("applied" | "clean" | "drift" | "skipped" | "failed" | ...).
     */
    repos_result: z.record(z.string(), z.string()).optional(),
  })
  .strict()
  // apply_idempotent's final check-mode run IS the convergence proof, so a
  // scenario arming both would rerun a proof it already gets.
  .refine((expected) => !(expected.converges && expected.apply_idempotent), {
    message: "apply_idempotent subsumes converges; set only one",
  })
  .refine(
    (expected) =>
      expected.fixpoint === undefined ||
      (expected.converges === undefined && expected.apply_idempotent === undefined),
    { message: "set fixpoint or a legacy converges/apply_idempotent boolean, not both" },
  )
  // The two YAML booleans collapse into one armed fixpoint proof, so
  // consumers branch on a single enum instead of two booleans whose
  // exclusivity would otherwise live in a comment.
  .transform(({ converges, apply_idempotent, fixpoint, ...rest }) => ({
    ...rest,
    fixpoint:
      fixpoint ??
      (apply_idempotent
        ? ("apply_idempotent" as const)
        : converges
          ? ("converges" as const)
          : undefined),
  }));

/**
 * The mock's starting state. The LiveState shape is owned by
 * ./mock/state.ts (it is the GET-side body space the mock serves); here it is
 * accepted as a loose object and typed as LiveState, so the two files share
 * one definition instead of restating it.
 */
const LiveStateSchema = z.record(z.string(), z.unknown()).transform((v) => v as LiveState);

/** A settings file body: any YAML mapping (validated for real by the action). */
const SettingsSchema = z.record(z.string(), z.unknown());

/** The token permission mask shape, reused for the global and per-repo masks. */
const TokenPermissionsSchema = z.partialRecord(MaskKeySchema, MaskGradeSchema);

/**
 * One target repo in a multi-repo scenario. `settings` is that repo's
 * settings.yml body, or null when the repo has NO settings file (the
 * contents-404 -> skipped path). `settings_raw` serves that exact string as the
 * settings.yml content instead (for a genuine YAML PARSE failure, which a
 * serialized object cannot produce); exactly one of `settings`/`settings_raw`
 * is set. `live_state` and `permissions` scope the mock's per-slug state and
 * denial mask to this target; `expect.result` pins this repo's individual
 * rollup (also assertable via the top-level repos_result map).
 */
const MultiRepoSchema = z
  .object({
    settings: SettingsSchema.nullable().optional(),
    settings_raw: z.string().optional(),
    live_state: LiveStateSchema.optional(),
    permissions: TokenPermissionsSchema.optional(),
    expect: z.object({ result: z.string().optional() }).strict().optional(),
  })
  .strict()
  // settings and settings_raw are mutually exclusive: they both define the
  // served settings.yml, and setting both would silently favor one. Reject the
  // ambiguity loudly rather than let a scenario pass with a surprising result.
  .refine((repo) => !(repo.settings !== undefined && repo.settings_raw !== undefined), {
    message: "set only one of `settings` or `settings_raw`, not both",
  });

/**
 * One discovery-pool repo `/user/repos` enumerates for a repos: "*" scenario.
 * The four attributes are the client-side-filterable fields the discovery
 * engine reads; the mock serves them verbatim and never pre-filters.
 */
const DiscoveryRepoSchema = z
  .object({
    slug: z.string(),
    archived: z.boolean().optional(),
    fork: z.boolean().optional(),
    visibility: z.string().optional(),
    topics: z.array(z.string()).optional(),
  })
  .strict();

/**
 * The discovery configuration for a repos: "*" scenario: the pool the mock
 * enumerates, and the discovery-filter action inputs the runner forwards as
 * INPUT_* vars. Keys are constrained to the real filter input names
 * (FILTER_INPUTS from the action), so a typoed filter fails at load time rather
 * than being silently forwarded and ignored.
 */
const DiscoverySchema = z
  .object({
    pool: z.array(DiscoveryRepoSchema),
    inputs: z.partialRecord(z.enum(FILTER_INPUTS), z.string()).default({}),
  })
  .strict();

/**
 * A transport-level fault the mock injects on the first `times` (default 1;
 * "always" = every match) requests that match `endpoint` - a "section.role"
 * key, or a core-route key
 * from CORE_FAULT_KEYS in mock/chaos.ts (e.g. "core.discoveryList" for the
 * /user/repos discovery listing, "core.contentsGet" for the settings-file
 * fetch, and the "core.issue*" / "core.reportLabelCreate" / "core.userGet"
 * report routes). These model failures the permission/handler layers cannot:
 * `rate_limit_403` answers 403 with "rate limit" in the body (the client's
 * classifier must read it as throttling, NOT a permission denial);
 * `429_then_200` answers the REAL secondary-rate-limit shape (the documented
 * "secondary rate limit" message plus a small positive Retry-After), which
 * octokit's throttling plugin - production's only 429 recovery path -
 * recognizes and retries, so the next request succeeds; under RETRY_BASE_MS
 * the retry plugin absorbs it instead, equally fast; `server_error` answers a
 * 5xx with a JSON message body,
 * rotating 500/502/503 deterministically on the fault's fire count - the
 * client retries 5xx, so times: 1 is a transient the run recovers from and
 * times >= 3 (1 + MAX_RETRIES) exhausts the retries into a hard failure;
 * `connection_drop` destroys the socket before any response (a network failure
 * the client surfaces after its retries are spent).
 */
const FaultSchema = z
  .object({
    endpoint: z.string(),
    kind: z.enum(["rate_limit_403", "429_then_200", "connection_drop", "server_error"]),
    times: z.union([z.number().int().positive(), z.literal("always")]).optional(),
  })
  .strict();

/**
 * Environment variable names a scenario's `env` map may not set: the runner
 * builds the child environment from scratch, and these are its own controls.
 * The prefixes are the SAME reserved set secret references refuse
 * (RESERVED_REF_PREFIXES), plus the exact names the runner assigns itself.
 */
const RESERVED_ENV_NAMES = new Set(["PATH", "HOME", "RETRY_BASE_MS"]);

function reservedEnvKey(name: string): boolean {
  return RESERVED_ENV_NAMES.has(name) || RESERVED_REF_PREFIXES.some((p) => name.startsWith(p));
}

/**
 * Extra variables injected into the child process environment, for scenarios
 * that exercise `$NAME` secret references (the step-env wiring a real
 * workflow does with `env:`). Keys colliding with the harness's own controls
 * (INPUT_*, GITHUB_*, RUNNER_*, ACTIONS_*, NODE_*, and the runner-assigned
 * names) are rejected at load time: a scenario must not be able to smuggle an
 * input or runner override past the hermetic childEnv build.
 */
const EnvSchema = z.record(z.string(), z.string()).superRefine((env, ctx) => {
  for (const name of Object.keys(env)) {
    if (reservedEnvKey(name)) {
      ctx.addIssue({
        code: "custom",
        message: `env key "${name}" collides with a harness control (reserved: ${[...RESERVED_ENV_NAMES].join(", ")} and the ${RESERVED_REF_PREFIXES.join("/")} prefixes)`,
      });
    }
  }
});

const ScenarioSchema = z
  .object({
    name: z.string(),
    description: z.string().optional(),
    tiers: z.array(TierSchema).default(["mock"]),
    settings: SettingsSchema.optional(),
    /**
     * The EXACT settings.yml text the single-repo run reads, written verbatim
     * (no YAML round-trip), for inputs a serialized object cannot produce: raw
     * unparseable YAML (the "cannot read settings ... valid YAML" path) or a
     * document that parses to a non-mapping (the "must be a YAML mapping"
     * validator path). The file is read from the LOCAL filesystem before any
     * API call, so such a scenario must see zero requests (assert with
     * expect.zero_requests). Exactly one of `settings`/`settings_raw` is set;
     * a multi-repo target's raw file is `repos.<slug>.settings_raw` instead.
     */
    settings_raw: z.string().optional(),
    inputs: InputsSchema.optional(),
    /**
     * Extra child-process environment variables (see EnvSchema): the step-env
     * half of a `$NAME` secret reference, defined the way a workflow's `env:`
     * block would define it.
     */
    env: EnvSchema.optional(),
    /** Resource -> granted access; unspecified resources default to "write". */
    token_permissions: TokenPermissionsSchema.optional(),
    denial_style: DenialStyleSchema.default("fine_grained"),
    live_state: LiveStateSchema.optional(),
    owner_kind: OwnerKindSchema.default("org"),
    /**
     * A GHES-style path prefix (e.g. "/api/v3") the mock bakes into its base
     * URL and requires on every request, to prove the client joins the base
     * URL correctly without dropping or doubling the prefix.
     */
    base_prefix: z.string().optional(),
    /**
     * Multi-repo mode: the target repos keyed by "owner/name" slug. Setting
     * this (or `discovery`) makes the runner drive the action's multi-repo
     * path (INPUT_REPOS) against the admin repo e2e-owner/e2e-repo.
     */
    repos: z.record(z.string(), MultiRepoSchema).optional(),
    /** Multi-repo repos: "*" discovery: the pool plus the filter inputs. */
    discovery: DiscoverySchema.optional(),
    /** The defaults-file body merged under every target (INPUT_DEFAULTS-FILE). */
    defaults_file: SettingsSchema.optional(),
    /** Transport-level faults injected on the first matching requests. */
    faults: z.array(FaultSchema).optional(),
    expect: ExpectSchema,
  })
  .strict()
  // Both fields define the served settings.yml, and setting both would
  // silently favor one; setting neither leaves the run without a settings
  // document at all. Reject each ambiguity loudly, mirroring MultiRepoSchema.
  .refine((s) => !(s.settings !== undefined && s.settings_raw !== undefined), {
    message: "set only one of `settings` or `settings_raw`, not both",
  })
  .refine((s) => s.settings !== undefined || s.settings_raw !== undefined, {
    message: "one of `settings` or `settings_raw` is required",
  })
  // The single-repo settings file is not read at all in multi mode, so a
  // top-level settings_raw there would be silently dead configuration.
  .refine((s) => s.settings_raw === undefined || (!s.repos && !s.discovery), {
    message:
      "settings_raw is single-repo only; a multi-repo target's raw file is `repos.<slug>.settings_raw`",
  });

export type MaskKey = z.infer<typeof MaskKeySchema>;
export type MaskGrade = z.infer<typeof MaskGradeSchema>;
/** A token permission mask: MaskKey -> granted MaskGrade, closed vocabulary. */
export type PermissionMask = z.infer<typeof TokenPermissionsSchema>;
export type DenialStyle = z.infer<typeof DenialStyleSchema>;
export type OwnerKind = z.infer<typeof OwnerKindSchema>;
/**
 * ExpectSchema's output with `fixpoint` optional: the transform always emits
 * the key, but a hand-built expectation (the fuzz cores) may simply omit it.
 */
export type Expect = Omit<z.infer<typeof ExpectSchema>, "fixpoint"> & {
  fixpoint?: "converges" | "apply_idempotent";
};
/**
 * Exactly one of `settings`/`settings_raw` defines the settings.yml a target
 * serves (a MultiRepo target may also have NO file: `settings: null` or both
 * absent). The zod refines prove the exclusivity at the parse boundary; the
 * `?: never` halves carry it into the type, so a generator that sets both
 * fails to compile instead of silently favoring `settings_raw`.
 */
type SettingsSource =
  | { settings: Record<string, unknown>; settings_raw?: never }
  | { settings_raw: string; settings?: never };
type MultiSettingsSource =
  | { settings?: Record<string, unknown> | null; settings_raw?: never }
  | { settings_raw: string; settings?: never };
export type MultiRepo = Omit<z.infer<typeof MultiRepoSchema>, "settings" | "settings_raw"> &
  MultiSettingsSource;
export type Scenario = Omit<
  z.infer<typeof ScenarioSchema>,
  "settings" | "settings_raw" | "repos" | "expect"
> &
  SettingsSource & { repos?: Record<string, MultiRepo>; expect: Expect };

/**
 * Where a scenario re-types MARKER_LABEL_CONFIG as fixture data because .yml
 * files cannot import the constant: DECLARED settings (top-level, per-repo,
 * defaults file) and expectation blocks. live_state is deliberately out of
 * scope - seeding a DRIFTED marker label there is how a future scenario
 * would test that the report path repairs a mangled marker, so the pin must
 * not make that inexpressible. Walk each in-scope root and compare any
 * object named MARKER_LABEL against the config; a config change then fails
 * scenario load with the offending values instead of silently drifting the
 * declared fixtures. Returns "field: fixture value != config value" lines.
 */
export function markerLabelFixtureMismatches(scenario: Scenario): string[] {
  const roots: Array<[string, unknown]> = [
    ["settings", scenario.settings],
    ["defaults_file", scenario.defaults_file],
    ["expect", scenario.expect],
  ];
  for (const [slug, repo] of Object.entries(scenario.repos ?? {})) {
    roots.push([`repos.${slug}.settings`, repo.settings], [`repos.${slug}.expect`, repo.expect]);
  }
  return roots.flatMap(([path, root]) => markerMismatchesIn(root, path));
}

/** The recursive comparison markerLabelFixtureMismatches applies per root. */
function markerMismatchesIn(value: unknown, path: string): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, i) => markerMismatchesIn(item, `${path}[${i}]`));
  }
  if (typeof value !== "object" || value === null) {
    return [];
  }
  const record = value as Record<string, unknown>;
  const mismatches: string[] = [];
  if (record.name === MARKER_LABEL) {
    for (const field of ["color", "description"] as const) {
      if (field in record && record[field] !== MARKER_LABEL_CONFIG[field]) {
        mismatches.push(
          `${path}.${field}: ${JSON.stringify(record[field])} != MARKER_LABEL_CONFIG's ${JSON.stringify(MARKER_LABEL_CONFIG[field])}`,
        );
      }
    }
  }
  for (const [key, nested] of Object.entries(record)) {
    mismatches.push(...markerMismatchesIn(nested, `${path}.${key}`));
  }
  return mismatches;
}

/**
 * Parse and validate one scenario object. On failure, throw an error naming
 * the source file and every offending zod path, so a malformed scenario is
 * diagnosable without reading the schema.
 */
export function parseScenario(raw: unknown, sourcePath: string): Scenario {
  const result = ScenarioSchema.safeParse(raw);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `  ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new Error(`invalid scenario ${sourcePath}:\n${detail}`);
  }
  const markerMismatches = markerLabelFixtureMismatches(result.data as Scenario);
  if (markerMismatches.length > 0) {
    throw new Error(
      `invalid scenario ${sourcePath}: marker-label fixture data drifted from MARKER_LABEL_CONFIG (src/report/issue-report.ts):\n  ${markerMismatches.join("\n  ")}`,
    );
  }
  // The refines above prove the settings XOR the Scenario type declares.
  return result.data as Scenario;
}

/** Recursively collect every .yml file under a directory (empty if absent). */
export function collectYmlFiles(dir: string): string[] {
  const out: string[] = [];
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectYmlFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".yml")) {
      out.push(full);
    }
  }
  return out;
}

/**
 * The directories the curated corpus lives in: the flat legacy root
 * (test/e2e/scenarios/, drained as sections move) plus every
 * src/sections/<key>/scenarios/ directory on disk, enumerated at call time so
 * a moved section's first scenario is picked up without touching a list.
 * ONLY scenarios/ directories count - any other .yml under a section
 * directory (a fixture, an example settings file) never loads as a scenario.
 * run.ts and the endpoint-coverage tripwire both call this, so the two can
 * never disagree about what the corpus is.
 */
export function scenarioRoots(): string[] {
  const roots = [join(import.meta.dir, "scenarios")];
  const sectionsDir = join(import.meta.dir, "..", "..", "src", "sections");
  for (const entry of readdirSync(sectionsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const scenariosDir = join(sectionsDir, entry.name, "scenarios");
    if (existsSync(scenariosDir)) {
      roots.push(scenariosDir);
    }
  }
  return roots;
}

/**
 * Load and validate every scenario under `dirs` (recursively, all .yml files),
 * sorted by path for a stable run order. Each file is parsed as YAML and
 * validated through parseScenario, so a bad file fails loudly naming itself;
 * two files claiming the same scenario name fail loudly naming both, since
 * names key --scenario filtering and failure artifacts.
 */
export function loadScenarios(dirs: readonly string[]): Scenario[] {
  const sourceByName = new Map<string, string>();
  return dirs
    .flatMap((dir) => collectYmlFiles(dir))
    .sort()
    .map((path) => {
      let raw: unknown;
      try {
        raw = parseYaml(readFileSync(path, "utf8"));
      } catch (error) {
        throw new Error(
          `cannot parse scenario ${path} as YAML: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const scenario = parseScenario(raw, path);
      const previous = sourceByName.get(scenario.name);
      if (previous !== undefined) {
        throw new Error(
          `duplicate scenario name "${scenario.name}": declared by both ${previous} and ${path}`,
        );
      }
      sourceByName.set(scenario.name, path);
      return scenario;
    });
}
