/**
 * The zod Scenario type for the e2e harness: one hermetic run, from settings and inputs through the
 * token's permission mask and the mock's starting state to the expected outcome.
 */

import { type Dirent, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";
import { RESERVED_REF_PREFIXES } from "../../src/engine/secret-refs.js";
import { FILTER_INPUTS } from "../../src/flows/inputs.js";
import { MARKER_LABEL, MARKER_LABEL_CONFIG } from "../../src/report/issue-report.js";
import { SECTION_KEYS } from "../../src/schema.js";
import type { PatResource } from "../../src/sections/contract/permissions.js";
import type { MustBeNever } from "../../src/types.js";
import type { LiveState } from "./mock/state.js";
import { LIVE_STATE_KEYS } from "./mock/state.js";

/** Only "mock" exists today; "live" is reserved for a future App-token tier scenarios can opt into. */
const TierSchema = z.enum(["mock", "live"]);

/** Every fine-grained PAT resource plus the organization "members" grant, which teams need and is not a PatResource. */
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

type _MaskCoversEveryResource = MustBeNever<Exclude<PatResource, (typeof MASK_KEYS)[number]>>;

const MaskKeySchema = z.enum(MASK_KEYS);

const MaskGradeSchema = z.enum(["none", "read", "write"]);

/**
 * How denied resources answer. "fine_grained" mirrors a real fine-grained token; the numeric styles
 * answer every denial with that status.
 *   denied read   -> 404 "Not Found"
 *   denied write  -> 403 "Resource not accessible by personal access token"
 */
const DenialStyleSchema = z.union([z.literal("fine_grained"), z.literal(403), z.literal(404)]);

/** Which account kind the mock owner presents as (teams behave differently). */
const OwnerKindSchema = z.enum(["org", "user"]);

/** The action inputs a scenario can set; the list inputs stay comma-separated strings, the action's own wire format. */
const InputsSchema = z
  .object({
    mode: z.enum(["apply", "check", "merge", "snapshot"]).optional(),
    /** The mode: merge run default for the keyed list sections (INPUT_LAYERING). */
    layering: z.enum(["merge", "replace"]).optional(),
    /**
     * mode: snapshot only, exactly one of the two: where the child writes,
     * relative to the scenario's temp dir (its working directory), forwarded
     * verbatim as INPUT_SNAPSHOT-FILE / INPUT_SNAPSHOT-DIR.
     */
    snapshot_file: z.string().optional(),
    snapshot_dir: z.string().optional(),
    on_missing_permission: z.enum(["fail", "warn"]).optional(),
    required_sections: z.string().optional(),
    sections: z.string().optional(),
    private_repos: z.enum(["redact", "show"]).optional(),
    private_report: z.enum(["none", "issue", "issue-on-failure", "artifact"]).optional(),
    /**
     * The age recipient the `artifact` channel encrypts the report to. A config-rejection scenario
     * sets a malformed value on purpose; a delivery scenario sets ARTIFACT_TEST_RECIPIENT (generators.ts).
     */
    report_public_key: z.string().optional(),
  })
  .strict();

/** A settings file body: any YAML mapping (validated for real by the action). */
const SettingsSchema = z.record(z.string(), z.unknown());

const ExpectSchema = z
  .object({
    /**
     * A non-empty array lists every ALLOWED code: the fuzz oracle predicts a set of legal exits, since
     * per-section outcome classes can land on either side of the worst-of fold. Curated scenarios keep the number.
     */
    exit_code: z.union([z.number().int(), z.array(z.number().int()).min(1)]),
    /** The `result` output ("clean", "drift", "applied", "failed", ...). */
    result: z.string().optional(),
    /**
     * The `skipped-sections` output as a set, whatever the comma-joined order. A section skipped under
     * on-missing-permission: warn must surface here, not only in the summary table.
     */
    skipped_sections: z.array(z.string()).optional(),
    /** Per-section outcome parsed from the step-summary table. */
    outcomes: z.record(z.string(), z.string()).optional(),
    /**
     * Ordered "METHOD /path" prefixes the write log must contain as a subsequence; `{repo}` expands to
     * the scenario's owner/name. A GraphQL operation is spelled "GRAPHQL <opName>", and a GraphQL READ
     * never appears in the write log despite its POST.
     */
    mutations: z.array(z.string()).optional(),
    /**
     * Prefixes of "METHOD /path?query" (or "GRAPHQL <opName>") that must NEVER appear in the request log; a pattern
     * with a query forbids one lookup on a path that other lookups share.
     */
    never: z.array(z.string()).optional(),
    summary_contains: z.array(z.string()).optional(),
    /** Substrings the publicly-readable step summary must NOT contain: a redacted target's slug and private live values. */
    summary_lacks: z.array(z.string()).optional(),
    stdout_contains: z.array(z.string()).optional(),
    /**
     * Substrings stdout must NOT contain, matched AFTER the runner strips the `::add-mask::` lines
     * core.setSecret emits: those legitimately carry the raw slug so the real runner can mask it.
     */
    stdout_lacks: z.array(z.string()).optional(),
    /**
     * Substrings that must appear on NO public surface: the step summary, stdout and stderr (mask
     * lines stripped), and every output value, through the same checkLeaks primitive the fuzzer
     * applies. Reserve summary_lacks and stdout_lacks for a string allowed on one surface but not another.
     */
    leaks_nowhere: z.array(z.string()).optional(),
    /**
     * The private-report issue channel's delivery to one target repo, read off the recorded issue writes for
     * that slug; the only place the private slug and sentinel may legitimately appear. A created issue must
     * always carry the marker label; that is asserted without a field.
     *   body_contains   -> the delivered body: the create, or the PATCH on a reuse run
     *   body_lacks      -> the runner already sweeps every report for the run's resolved secrets
     *   lookup_by_label -> the issues list GET used the labels=<marker> filter
     *   labels          -> the LAST write that set them; a reattached marker must not clobber human labels
     *   created_count   -> report issues POSTed for the slug; 0 on the denied or reuse path
     */
    issue_report: z
      .object({
        slug: z.string(),
        title: z.string().optional(),
        body_contains: z.array(z.string()).optional(),
        body_lacks: z.array(z.string()).optional(),
        state: z.enum(["open", "closed"]).optional(),
        created_count: z.number().int().optional(),
        lookup_by_label: z.boolean().optional(),
        labels: z.array(z.string()).optional(),
      })
      .strict()
      .optional(),
    /** Requests of any method the log must contain, as substrings of "METHOD path": a `page=2` read proves pagination ran. */
    requests_contain: z.array(z.string()).optional(),
    /**
     * When true, the mock must have received ZERO requests: the failure under test (a settings_raw
     * parse failure, read from the local filesystem) fires before any API contact.
     */
    zero_requests: z.boolean().optional(),
    /** Rerun in check mode against the SAME mutated mock, expecting exit 0 and zero writes (the convergence proof). */
    converges: z.boolean().optional(),
    /**
     * Re-run APPLY against the SAME mutated mock and prove it a fixpoint (assertApplyIdempotent), ending
     * in a converging check; subsumes `converges`. Apply mode without the issue report channel.
     */
    apply_idempotent: z.boolean().optional(),
    /**
     * The canonical spelling the transform below emits, accepted on input so a dumped artifact
     * scenario.yml (stringified AFTER the transform) reparses. Set this or one legacy boolean, never both.
     */
    fixpoint: z.enum(["converges", "apply_idempotent"]).optional(),
    /** Multi-repo: the per-target rollup from the `repos-result` output, "owner/name" -> result string. */
    repos_result: z.record(z.string(), z.string()).optional(),
    /**
     * mode: merge only: the EXACT document the run must write to merged-file, compared whole after a
     * YAML parse. A merge never runs the engine, so it cannot combine with a fixpoint re-run proof.
     */
    merged: SettingsSchema.optional(),
    /**
     * mode: snapshot, file form only: the EXACT document the run must write to
     * snapshot_file, compared whole after a YAML parse (so the comment header
     * is ignored). A dir-form target pins its file under `repos.<slug>.expect.snapshot`.
     */
    snapshot: SettingsSchema.optional(),
    /**
     * mode: snapshot, file form only. When true, the runner re-runs the bundle
     * in CHECK mode with the written snapshot as its settings file against the
     * SAME seeded state (the allowlist and the denial policy carried over) and
     * expects exit 0, `result: clean`, and zero writes: the round trip.
     */
    snapshot_converges: z.boolean().optional(),
  })
  .strict()
  // apply_idempotent's final check-mode run IS the convergence proof, so arming both would rerun it.
  .refine((expected) => !(expected.converges && expected.apply_idempotent), {
    message: "apply_idempotent subsumes converges; set only one",
  })
  .refine(
    (expected) =>
      expected.merged === undefined ||
      (expected.converges === undefined &&
        expected.apply_idempotent === undefined &&
        expected.fixpoint === undefined),
    { message: "merged pins a mode: merge run, which has no fixpoint re-run to prove" },
  )
  .refine(
    (expected) =>
      expected.fixpoint === undefined ||
      (expected.converges === undefined && expected.apply_idempotent === undefined),
    { message: "set fixpoint or a legacy converges/apply_idempotent boolean, not both" },
  )
  // A snapshot applies nothing, so the apply-mode fixpoint proofs have no run to re-run.
  .refine(
    (expected) =>
      (expected.snapshot === undefined && expected.snapshot_converges === undefined) ||
      (expected.converges === undefined &&
        expected.apply_idempotent === undefined &&
        expected.fixpoint === undefined),
    {
      message:
        "snapshot and snapshot_converges pin a mode: snapshot run, which has no apply-mode fixpoint",
    },
  )
  // The two YAML booleans collapse into one armed proof, so consumers branch on a single enum instead
  // of two booleans whose exclusivity would otherwise live in a comment.
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
 * The mock's starting state, keyed by ./mock/state.ts's LIVE_STATE_KEYS so a typo'd family name fails
 * scenario load instead of being accepted and silently unseeded.
 */
const LiveStateSchema = z
  .partialRecord(z.enum(LIVE_STATE_KEYS), z.unknown())
  .transform((v) => v as LiveState);

const TokenPermissionsSchema = z.partialRecord(MaskKeySchema, MaskGradeSchema);

/**
 * One target repo in a multi-repo scenario. At most one of `settings`/`settings_raw` is set; neither,
 * or `settings: null`, means NO settings file.
 *
 *   no settings file  -> the defaults document applies, or the target is skipped
 *   settings_raw      -> served verbatim, for a YAML parse failure a serialized object cannot produce
 *   expect.result     -> this repo's own rollup, also assertable via the top-level repos_result map
 */
const MultiRepoSchema = z
  .object({
    settings: SettingsSchema.nullable().optional(),
    settings_raw: z.string().optional(),
    live_state: LiveStateSchema.optional(),
    permissions: TokenPermissionsSchema.optional(),
    expect: z
      .object({
        result: z.string().optional(),
        /** mode: snapshot, dir form: the EXACT document written to `<snapshot_dir>/<owner>/<name>.yml`. */
        snapshot: SettingsSchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  // Both define the served settings.yml; setting both would silently favor one.
  .refine((repo) => !(repo.settings !== undefined && repo.settings_raw !== undefined), {
    message: "set only one of `settings` or `settings_raw`, not both",
  });

/** One discovery-pool repo `/user/repos` enumerates; the mock pre-filters visibility only, as GitHub does server-side (mock/core-paths.ts). */
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
 * A repos: "*" scenario's pool and the discovery-filter inputs the runner forwards as INPUT_* vars,
 * keyed by the real filter input names so a typoed filter fails at load instead of being forwarded and ignored.
 */
const DiscoverySchema = z
  .object({
    pool: z.array(DiscoveryRepoSchema),
    inputs: z.partialRecord(z.enum(FILTER_INPUTS), z.string()).default({}),
  })
  .strict();

/**
 * `endpoint` is a "section.role" key or a core-route key from CORE_FAULT_KEYS in mock/chaos.ts. These model
 * failures the permission and handler layers cannot:
 *
 *   rate_limit_403   -> 403 with "rate limit" in the body; the client must read it as throttling, not a denial
 *   429_then_200     -> the secondary-rate-limit shape; the throttling plugin honors its Retry-After (in RETRY_BASE_MS units under the runner)
 *   server_error     -> 5xx rotating 500/502/503 per firing; times 1 recovers, times >= 3 (1 + MAX_RETRIES) fails
 *   connection_drop  -> the socket dies before any response, a network failure surfaced after the retries
 *   echo_422         -> a validation rejection quoting the request body verbatim; a secret-carrying request must surface none of it
 */
const FaultSchema = z
  .object({
    endpoint: z.string(),
    kind: z.enum(["rate_limit_403", "429_then_200", "connection_drop", "server_error", "echo_422"]),
    times: z.union([z.number().int().positive(), z.literal("always")]).optional(),
  })
  .strict();

/**
 * Names a scenario's `env` map may not set: the runner builds the child environment from scratch
 * and these are its own controls. The prefixes are the SAME set secret references refuse.
 */
const RESERVED_ENV_NAMES = new Set(["PATH", "HOME", "RETRY_BASE_MS"]);

function reservedEnvKey(name: string): boolean {
  return RESERVED_ENV_NAMES.has(name) || RESERVED_REF_PREFIXES.some((p) => name.startsWith(p));
}

/**
 * Extra child-process variables for `$NAME` secret references (the step-env wiring a workflow's
 * `env:` does). A colliding key is rejected at load: a scenario must not smuggle an input or a
 * runner override past the hermetic childEnv build.
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
     * The EXACT settings.yml text the single-repo run reads (a multi-repo target's is
     * `repos.<slug>.settings_raw`), for inputs a serialized object cannot produce: unparseable YAML, or
     * a non-mapping document. Read from the LOCAL filesystem before any API call, so assert expect.zero_requests too.
     */
    settings_raw: z.string().optional(),
    /**
     * mode: merge only: the documents BELOW `settings`, lowest first; the runner lists them before
     * settings.yml in INPUT_SETTINGS-FILE, so `settings` is always the top layer.
     */
    settings_layers: z.array(SettingsSchema).optional(),
    inputs: InputsSchema.optional(),
    /** The step-env half of a `$NAME` secret reference, the way a workflow's `env:` block defines it. */
    env: EnvSchema.optional(),
    /** Resource -> granted access; unspecified resources default to "write". */
    token_permissions: TokenPermissionsSchema.optional(),
    denial_style: DenialStyleSchema.default("fine_grained"),
    live_state: LiveStateSchema.optional(),
    owner_kind: OwnerKindSchema.default("org"),
    /**
     * A GHES-style path prefix (e.g. "/api/v3") the mock bakes into its base URL and requires on every
     * request, proving the client neither drops nor doubles it.
     */
    base_prefix: z.string().optional(),
    /**
     * Multi-repo mode: the targets keyed by "owner/name". Setting this (or `discovery`) drives the
     * action's multi-repo path (INPUT_REPOS) against the admin repo e2e-owner/e2e-repo.
     */
    repos: z.record(z.string(), MultiRepoSchema).optional(),
    discovery: DiscoverySchema.optional(),
    /** The defaults-file body applied to every target without a settings file (INPUT_DEFAULTS-FILE). */
    defaults_file: SettingsSchema.optional(),
    faults: z.array(FaultSchema).optional(),
    expect: ExpectSchema,
  })
  .strict()
  // Both define the served settings.yml, and setting both would silently favor one; setting neither
  // leaves the run without a settings document at all.
  .refine((s) => !(s.settings !== undefined && s.settings_raw !== undefined), {
    message: "set only one of `settings` or `settings_raw`, not both",
  })
  .refine((s) => s.settings !== undefined || s.settings_raw !== undefined, {
    message: "one of `settings` or `settings_raw` is required",
  })
  // The single-repo settings file is not read at all in multi mode, so a top-level settings_raw
  // there would be silently dead configuration.
  .refine((s) => s.settings_raw === undefined || (!s.repos && !s.discovery), {
    message:
      "settings_raw is single-repo only; a multi-repo target's raw file is `repos.<slug>.settings_raw`",
  })
  // Only a mode: merge run reads the layer files and writes the merged file the pin compares against.
  .refine((s) => s.settings_layers === undefined || s.inputs?.mode === "merge", {
    message: "settings_layers only applies with inputs.mode: merge",
  })
  .refine((s) => s.expect.merged === undefined || s.inputs?.mode === "merge", {
    message: "expect.merged only applies with inputs.mode: merge",
  })
  // A merge runs no engine: a fixpoint re-run would be a check against nothing.
  .refine((s) => s.inputs?.mode !== "merge" || s.expect.fixpoint === undefined, {
    message: "a mode: merge scenario cannot arm converges or apply_idempotent",
  })
  // The snapshot destinations and their pins describe a mode: snapshot run and
  // nothing else; anywhere else they would be dead configuration.
  .refine(
    (s) =>
      s.inputs?.mode === "snapshot" ||
      (s.inputs?.snapshot_file === undefined && s.inputs?.snapshot_dir === undefined),
    { message: "snapshot_file and snapshot_dir only apply with inputs.mode: snapshot" },
  )
  .refine(
    (s) =>
      s.inputs?.mode !== "snapshot" ||
      (s.inputs.snapshot_file === undefined) !== (s.inputs.snapshot_dir === undefined),
    {
      message:
        "a mode: snapshot scenario sets exactly one of inputs.snapshot_file or inputs.snapshot_dir",
    },
  )
  .refine(
    (s) =>
      (s.expect.snapshot === undefined && s.expect.snapshot_converges === undefined) ||
      s.inputs?.snapshot_file !== undefined,
    {
      message: "expect.snapshot and expect.snapshot_converges only apply with inputs.snapshot_file",
    },
  )
  .refine(
    (s) =>
      s.inputs?.snapshot_dir !== undefined ||
      Object.values(s.repos ?? {}).every((repo) => repo.expect?.snapshot === undefined),
    { message: "repos.<slug>.expect.snapshot only applies with inputs.snapshot_dir" },
  )
  // A snapshot never runs the engine's apply path, so a fixpoint proof has no run to re-run.
  .refine((s) => s.inputs?.mode !== "snapshot" || s.expect.fixpoint === undefined, {
    message: "a mode: snapshot scenario cannot arm converges or apply_idempotent",
  });

export type MaskKey = z.infer<typeof MaskKeySchema>;
export type MaskGrade = z.infer<typeof MaskGradeSchema>;
/**
 * The grade ordering: shared DATA for the mock's permission gate and the oracle, unlike their grading
 * predicates, which stay deliberately independent mirrors.
 */
export const GRADE_RANK: Record<MaskGrade, number> = { none: 0, read: 1, write: 2 };
export type PermissionMask = z.infer<typeof TokenPermissionsSchema>;
export type DenialStyle = z.infer<typeof DenialStyleSchema>;
export type OwnerKind = z.infer<typeof OwnerKindSchema>;
/** The transform always emits `fixpoint`; a hand-built expectation (the fuzz cores) may omit it. */
export type Expect = Omit<z.infer<typeof ExpectSchema>, "fixpoint"> & {
  fixpoint?: "converges" | "apply_idempotent";
};
/**
 * The zod refines prove the `settings`/`settings_raw` exclusivity at the parse boundary; the
 * `?: never` halves carry it into the type, so a generator setting both fails to compile instead of
 * silently favoring `settings_raw`.
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
 * The ONE settings.yml derivation the single-repo runner and the multi-repo contents endpoint share.
 * A Scenario always carries one of the two sources, so its overload never yields null.
 */
export function settingsYamlFor(source: SettingsSource): string;
export function settingsYamlFor(source: MultiSettingsSource): string | null;
export function settingsYamlFor(source: {
  settings?: Record<string, unknown> | null;
  settings_raw?: string;
}): string | null {
  if (source.settings_raw !== undefined) {
    return source.settings_raw;
  }
  if (source.settings === null || source.settings === undefined) {
    return null;
  }
  return stringifyYaml(source.settings);
}

/**
 * Scenario .yml files cannot import MARKER_LABEL_CONFIG, so their DECLARED settings and expectations
 * re-type it; a config change then fails scenario load naming the drifted fixture. live_state is
 * deliberately out of scope: seeding a DRIFTED marker there is how a scenario would test the report
 * path repairing a mangled marker, so the pin must not make that inexpressible.
 */
export function markerLabelFixtureMismatches(scenario: Scenario): string[] {
  const roots: Array<[string, unknown]> = [
    ["settings", scenario.settings],
    ["defaults_file", scenario.defaults_file],
    ["expect", scenario.expect],
    ...(scenario.settings_layers ?? []).map((layer, i): [string, unknown] => [
      `settings_layers[${i}]`,
      layer,
    ]),
  ];
  for (const [slug, repo] of Object.entries(scenario.repos ?? {})) {
    roots.push([`repos.${slug}.settings`, repo.settings], [`repos.${slug}.expect`, repo.expect]);
  }
  // Marker-label fixtures inside a pinned snapshot are declared data too.
  return roots.flatMap(([path, root]) => markerMismatchesIn(root, path));
}

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

/**
 * Every .yml under a directory. An unreadable corpus must never look empty: run.ts reports an empty
 * unfiltered corpus and exits 0.
 *   ENOENT             -> [] (a section may have no scenarios/ yet; test/schema-corpus.test.ts rejects the empty root)
 *   any other failure  -> propagates naming the directory
 */
export function collectYmlFiles(dir: string): string[] {
  const out: string[] = [];
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return out;
    }
    throw new Error(
      `cannot read the scenario directory ${dir}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
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
 * The curated corpus; run.ts and .github/scripts/check-endpoint-coverage.ts both read it, so they
 * cannot disagree. The roots are not filtered by existence: an existsSync filter would silently drop
 * a scenarios/ under a mode-000 <key>/, where collectYmlFiles fails loudly instead.
 *   test/e2e/scenarios/             -> multi-section flows; a scenario exercising ONE section lives with that section
 *   <sectionsDir>/<key>/scenarios/  -> every registered section, so a new section's first scenario needs no list edit
 */
export function scenarioRoots(
  sectionsDir: string = join(import.meta.dir, "..", "..", "src", "sections"),
): string[] {
  return [
    join(import.meta.dir, "scenarios"),
    ...SECTION_KEYS.map((key) => join(sectionsDir, key, "scenarios")),
  ];
}

/**
 * Every scenario under `dirs`, sorted by path for a stable run order. Two files claiming one scenario
 * name fail naming both: names key --scenario filtering and the failure artifacts.
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
