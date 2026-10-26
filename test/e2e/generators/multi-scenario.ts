import { SECTION_KEYS, type SectionKey } from "../../../src/schema.js";
import { SECTIONS } from "../../../src/sections/registry.js";
import { ADMIN_SLUG } from "../constants.js";
import type { LiveState } from "../mock/state.js";
import type { DenialStyle, MaskGrade, MaskKey, MultiRepo, Scenario } from "../scenario.js";
import { entriesOf, type Json } from "./gen-support.js";
import { NON_MAPPING_YAML, UNPARSEABLE_YAML } from "./invalid-settings.js";
import type { Rng } from "./prng.js";
import {
  ARTIFACT_TEST_RECIPIENT,
  genSettings,
  MASK_KEYS,
  presenceLiveState,
  SECRET_LIST_SECTIONS,
  suppressMaskedCustomProperties,
  suppressMaskedEnvironmentOverrides,
  validateAgainstPublishedSchema,
} from "./settings.js";
import type { ScenarioMeta } from "./single-scenario.js";

/** Derived from the registry's `permission` declarations, the source the oracle's sectionGrade and the mock's gate read too, so a future org-gated section inherits the forced-private strip without a hand edit. */
export const ORG_GATED_SECTIONS: ReadonlySet<SectionKey> = new Set(
  SECTIONS.filter((section) => section.permission.org === "members").map((section) => section.key),
);

/** The secret sections are excluded at the draw: their values are ALWAYS $NAME references, which a target-fetched settings.yml refuses (stripSecretReferences backstops the webhook secret field and the nested environments secrets). */
const TARGET_SECTION_POOL: readonly SectionKey[] = SECTION_KEYS.filter(
  (key) => !(SECRET_LIST_SECTIONS as readonly SectionKey[]).includes(key),
);

/** The rolls each force pins; a roll the force leaves alone keeps its drawn value. */
const FORCED_ROLLS: Readonly<Record<MultiBatteryForce, ForcedRolls>> = {
  "issue-report": { privateRepos: "redact", privateReport: "issue" },
  "idempotence-eligible": { mode: "apply", privateReport: "none" },
  "plain-first-target": { privateRepos: "show" },
};

/** Both raw kinds fail the target before any section runs. */
export type MultiRepoTarget =
  | { kind: "normal"; meta: ScenarioMeta }
  | { kind: "missing" }
  | { kind: "raw-invalid"; raw: "unparseable" | "non-mapping" };

export interface MultiRepoMeta {
  /** "owner/name", also the target's key in the scenario's repos map. */
  slug: string;

  /** "missing" has no settings file: the action applies the defaults document to it, or skips it when the scenario has none. */
  target: MultiRepoTarget;

  /** The visibility planted in the mock, which the repository probe reports. */
  visibility: "public" | "private" | "internal";

  /** True when mask.administration is "none": the visibility probe is denied, the resolver reads "unknown", and redaction fails closed whatever the planted visibility (src/flows/multi.ts). */
  probeDenied: boolean;

  /** Redacted iff the policy is redact, the slug is not the self slug, and the target is private/internal or probe-denied; the canaries are planted in the target's private surfaces and may appear in no public one. */
  redaction: { kind: "shown" } | { kind: "redacted"; placeholder: string; canaries: string[] };
}

export interface MultiScenarioMeta {
  /** One per target, in generation order, the order the action runs them. */
  repos: MultiRepoMeta[];

  /** The run's `mode` input. */
  mode: "apply" | "check";

  /** The run's `on_missing_permission` input. */
  policy: "fail" | "warn";

  /** The run's `private_repos` input. */
  privateRepos: "redact" | "show";

  /** The `private-report` channel; `issue-on-failure` is absent, since the oracle does not predict its per-target needsAttention writes (the curated multi-report-issue-on-failure-* scenarios pin it). */
  privateReport: "none" | "issue" | "artifact";

  /** GITHUB_REPOSITORY: a target whose slug equals it is never redacted. */
  selfSlug: string;

  /** The GLOBAL token mask (scenario token_permissions), varied only on org_members; the idempotence eligibility predicate reads it, since a globally denied org gate denies a declared teams section's grants even when every per-target mask is empty. */
  globalMask: Partial<Record<MaskKey, MaskGrade>>;

  /** The forced-private canary target under redact, undefined under show; tests address THAT target, since an unforced roll can also produce a redacted target. */
  forcedPrivateSlug?: string;

  /** A core-route fault the fuzz iteration injected, never set by generation; `fatal` means the FIRST target's settings fetch dies whatever its kind would otherwise report, while a non-fatal fault is retried away and changes no prediction. */
  coreFault?: { key: "core.contentsGet"; fatal: boolean };

  /** The ScenarioMeta a fileless target runs under (the defaults document's sections with an empty per-slug mask), present exactly when the scenario has a defaults_file; absent, a fileless target is skipped. */
  defaults?: ScenarioMeta;
}

/**
 * Forces pin the rolls a directed battery needs, so its entry EXISTS for every master seed: rejection sampling with any
 * fixed fork budget has miss seeds, each a spurious CI failure. A forced path may consume a different draw sequence
 * than the unforced one; that is safe because forced generation is deterministic per (seed, force) and every battery replay reapplies its force.
 *
 * "issue-report"          -> redact + the issue channel, the report-fault battery's precondition
 * "idempotence-eligible"  -> apply, non-delivering channel, no raw target, every normal mask empty (multiIdempotenceEligible)
 * "plain-first-target"    -> show (no canaries) and the raw target kept off index 0, the contents-fault victim guard
 */
export type MultiBatteryForce = "issue-report" | "idempotence-eligible" | "plain-first-target";

interface ForcedRolls {
  mode?: "apply";
  privateRepos?: "redact" | "show";
  privateReport?: "none" | "issue";
}

/** The rolls every target shares, taken before the per-target loop. */
interface RunDraw {
  rng: Rng;
  force: MultiBatteryForce | undefined;
  mode: "apply" | "check";
  policy: "fail" | "warn";
  denialStyle: DenialStyle;
  privateRepos: "redact" | "show";
  globalMask: Partial<Record<MaskKey, MaskGrade>>;
  missingIndex: number;
  forcedPrivateIndex: number;
  redactionFor: (redacted: boolean, canaries?: string[]) => MultiRepoMeta["redaction"];
}

/** The raw-invalid target's position and which raw body it serves. */
interface RawTarget {
  index: number;
  kind: "unparseable" | "non-mapping";
}

/** One target's position and the main-stream rolls taken before its kind branches. */
interface TargetDraw {
  index: number;
  slug: string;
  visibility: MultiRepoMeta["visibility"];
}

interface GeneratedTarget {
  spec: MultiRepo;
  meta: MultiRepoMeta;
}

/**
 * A target's own settings.yml refuses `$NAME` references (src/flows/multi.ts: target provenance never reads the
 * operator's environment), so a multi target never declares one; the secret sections go outright, since their values are always references.
 */
function stripSecretReferences(settings: Json): void {
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

export function displayKeyOf(meta: MultiRepoMeta): string {
  return meta.redaction.kind === "redacted" ? meta.redaction.placeholder : meta.slug;
}

export function canariesOf(meta: MultiRepoMeta): string[] {
  return meta.redaction.kind === "redacted" ? meta.redaction.canaries : [];
}

/** Mirrors planRedaction's format (src/flows/redact.ts); a change there must land here. */
export function redactionPlaceholder(ordinal: number): string {
  return `private repository #${ordinal}`;
}

/**
 * Varied ONLY on org_members: the mock grades org routes against the global mask and repo routes against the per-slug
 * overlay (mock/routes.ts), so any other global entry would have mock and oracle grading different masks. The
 * idempotence force clears it: a globally denied org gate leaves a declared teams section granting on every apply, which is no fixpoint.
 */
function drawGlobalMask(
  globalMaskRng: Rng,
  force: MultiBatteryForce | undefined,
): Partial<Record<MaskKey, MaskGrade>> {
  const globalMask: Partial<Record<MaskKey, MaskGrade>> = {};
  if (globalMaskRng.bool(0.3) && force !== "idempotence-eligible") {
    globalMask.org_members = globalMaskRng.pick(["none", "read", "write"] as const);
  }
  return globalMask;
}

/**
 * The raw-invalid target, or undefined when the run has none. Never the missing target (its gate is the contents 404)
 * and never the forced-private one (its canary flow must stay guaranteed for the leak counterfactual). The rolls are
 * taken under every force, so the main stream stays stable; the idempotence force then discards them.
 */
function drawRawTarget(
  rng: Rng,
  run: Pick<RunDraw, "force" | "missingIndex" | "forcedPrivateIndex">,
  count: number,
): RawTarget | undefined {
  const rawCandidates = Array.from({ length: count }, (_, i) => i).filter(
    (i) =>
      i !== run.missingIndex &&
      i !== run.forcedPrivateIndex &&
      // The contents-fault battery's victim is always index 0; keep the raw target off it by construction.
      (run.force !== "plain-first-target" || i !== 0),
  );
  const rolledRawIndex = rawCandidates.length > 0 && rng.bool(0.2) ? rng.pick(rawCandidates) : -1;
  const rawIndex = run.force === "idempotence-eligible" ? -1 : rolledRawIndex;
  if (rawIndex < 0) {
    return undefined;
  }
  return { index: rawIndex, kind: rng.pick(["unparseable", "non-mapping"] as const) };
}

/** Roughly half non-public, so the redaction path is exercised. */
function drawTarget(rng: Rng, index: number, forcedPrivateIndex: number): TargetDraw {
  const visibility =
    index === forcedPrivateIndex
      ? rng.pick(["private", "internal"] as const)
      : rng.pick(["public", "public", "private", "internal"] as const);
  return { index, slug: `e2e-owner/repo-${index}`, visibility };
}

/** Redacted iff the policy is redact, the slug is not the self slug, and the target is private/internal or probe-denied. */
function isRedacted(run: RunDraw, target: TargetDraw, probeDenied: boolean): boolean {
  return (
    run.privateRepos === "redact" &&
    target.slug !== ADMIN_SLUG &&
    (target.visibility !== "public" || probeDenied)
  );
}

/** A target with no settings document of its own (no file, or a raw body the parse or the top-level mapping check rejects); it is still probed, so it can still be redacted. */
function genDocumentlessTarget(
  run: RunDraw,
  target: TargetDraw,
  spec: MultiRepo,
  kind: MultiRepoTarget,
): GeneratedTarget {
  const probeDenied = false;
  const redacted = isRedacted(run, target, probeDenied);
  if (target.visibility !== "public") {
    spec.live_state = { repo: { private: true, visibility: target.visibility } };
  }
  return {
    spec,
    meta: {
      slug: target.slug,
      target: kind,
      visibility: target.visibility,
      probeDenied,
      redaction: run.redactionFor(redacted),
    },
  };
}

/**
 * Half the pool, at least one section. The forced-private target's guarantees (never preflight-aborts, always
 * delivers) assume every declared section is fully granted; a globally denied org gate denies org-gated reads whatever
 * the per-slug mask says, so it drops them there. The OTHER targets keep them covered.
 */
function drawTargetSections(child: Rng, run: RunDraw, target: TargetDraw): SectionKey[] {
  const sections = TARGET_SECTION_POOL.filter(() => child.bool(0.5));
  if (sections.length === 0) {
    sections.push(child.pick(TARGET_SECTION_POOL));
  }
  if (target.index !== run.forcedPrivateIndex || run.globalMask.org_members !== "none") {
    return sections;
  }
  const granted = sections.filter((key) => !ORG_GATED_SECTIONS.has(key));
  if (granted.length === 0) {
    // A new draw, so it forks off the child stream: the child's downstream draws stay unshifted.
    granted.push(
      child
        .fork("canary-refill")
        .pick(TARGET_SECTION_POOL.filter((key) => !ORG_GATED_SECTIONS.has(key))),
    );
  }
  return granted;
}

/**
 * The forced-private target must be a REAL leak test: under apply + fail one denied read preflight-aborts the target
 * and nothing, canary included, is rendered, so its mask is cleared. The idempotence force clears every normal
 * target's mask, since the apply-idempotence gate requires fully-granted targets. The clear follows the draw, so the child stream stays unshifted.
 */
function drawTargetMask(
  child: Rng,
  run: RunDraw,
  target: TargetDraw,
): Partial<Record<MaskKey, MaskGrade>> {
  const mask: Partial<Record<MaskKey, MaskGrade>> = {};
  for (const resource of MASK_KEYS) {
    if (child.bool(0.3)) {
      mask[resource] = child.pick(["none", "read", "write"] as const);
    }
  }
  if (target.index === run.forcedPrivateIndex || run.force === "idempotence-eligible") {
    return {};
  }
  return mask;
}

/**
 * Canaries catch a detail-SUPPRESSION regression, not just a slug leak; a name-matched label keeps the outcome
 * class the labels grade already predicts. Redaction must hide every surface below.
 *   label name (declared = live)      -> the apply change detail
 *   descriptions (declared != live)   -> the check drift detail
 *   repo canary                       -> the live repo description
 * The canary rides in on the labels section, so `sections` gains it and the oracle predicts it.
 */
function plantCanaries(
  seed: number,
  target: TargetDraw,
  settings: Json,
  live: LiveState,
  sections: SectionKey[],
): string[] {
  const nameCanary = `CANARY-${seed}-${target.index}-name`;
  const declaredDescCanary = `CANARY-${seed}-${target.index}-declared`;
  const liveDescCanary = `CANARY-${seed}-${target.index}-live`;
  const repoCanary = `CANARY-${seed}-${target.index}-repo`;
  const declaredLabels = settings.labels === undefined ? [] : entriesOf(settings.labels);
  declaredLabels.push({ name: nameCanary, color: "abcdef", description: declaredDescCanary });
  if (settings.labels === undefined) {
    settings.labels = declaredLabels;
  }
  const liveLabels = Array.isArray(live.labels) ? (live.labels as Json[]) : [];
  liveLabels.push({ name: nameCanary, color: "abcdef", description: liveDescCanary });
  live.labels = liveLabels;
  live.repo = { ...(live.repo ?? {}), description: repoCanary };
  if (!sections.includes("labels")) {
    sections.push("labels");
  }
  return [nameCanary, declaredDescCanary, liveDescCanary, repoCanary];
}

/** A target with its own settings file; every draw comes off the target's fork, so it replays alone. */
function genNormalTarget(run: RunDraw, target: TargetDraw): GeneratedTarget {
  const child = run.rng.fork(`repo:${target.index}`);
  const sections = drawTargetSections(child, run, target);
  const settings: Json = {};
  for (const key of sections) {
    settings[key] = genSettings(child.fork(`settings:${key}`), key);
  }
  stripSecretReferences(settings);
  const mask = drawTargetMask(child, run, target);
  suppressMaskedEnvironmentOverrides(settings, mask);
  suppressMaskedCustomProperties(settings, mask, sections);
  const probeDenied = mask.administration === "none";
  const redacted = isRedacted(run, target, probeDenied);

  const live: LiveState = presenceLiveState(settings) ?? {};
  if (target.visibility !== "public") {
    live.repo = { ...(live.repo ?? {}), private: true, visibility: target.visibility };
  }
  const canaries = redacted ? plantCanaries(run.rng.seed, target, settings, live, sections) : [];
  validateAgainstPublishedSchema(settings);

  const hasLive = Object.keys(live).length > 0;
  const spec: MultiRepo = {
    settings,
    ...(hasLive ? { live_state: live } : {}),
    ...(Object.keys(mask).length > 0 ? { permissions: mask } : {}),
  };
  const meta: MultiRepoMeta = {
    slug: target.slug,
    visibility: target.visibility,
    probeDenied,
    redaction: run.redactionFor(redacted, canaries),
    target: {
      kind: "normal",
      meta: {
        sections,
        mask,
        mode: run.mode,
        policy: run.policy,
        ownerKind: "org",
        denialStyle: run.denialStyle,
        requiredSections: [],
        orgMask: run.globalMask,
      },
    },
  };
  return { spec, meta };
}

/** The target at a position by its kind; the raw body is drawn here, in target order, so the main stream stays stable. */
function genTarget(run: RunDraw, target: TargetDraw, raw: RawTarget | undefined): GeneratedTarget {
  if (target.index === run.missingIndex) {
    return genDocumentlessTarget(run, target, { settings: null }, { kind: "missing" });
  }
  if (raw !== undefined && target.index === raw.index) {
    // Fully granted (no mask), so the contents read succeeds and the parse or top-level-mapping gate, not a permission gate, is what fires.
    const body =
      raw.kind === "unparseable" ? run.rng.pick(UNPARSEABLE_YAML) : run.rng.pick(NON_MAPPING_YAML);
    return genDocumentlessTarget(
      run,
      target,
      { settings_raw: body },
      { kind: "raw-invalid", raw: raw.kind },
    );
  }
  return genNormalTarget(run, target);
}

export function genMultiScenario(
  rng: Rng,
  force?: MultiBatteryForce,
): { scenario: Scenario; meta: MultiScenarioMeta } {
  const forced: ForcedRolls = force === undefined ? {} : FORCED_ROLLS[force];
  const count = rng.int(4) + 2;
  const rolledMode = rng.pick(["apply", "check"] as const);
  const mode = forced.mode ?? rolledMode;
  const policy = rng.pick(["fail", "warn"] as const);
  const denialStyle: DenialStyle = rng.pick(["fine_grained", 403] as const);
  const rolledPrivateRepos = rng.pick(["redact", "show"] as const);
  const privateRepos = forced.privateRepos ?? rolledPrivateRepos;
  // Only a redact run delivers a report: the config rejects a delivering channel beside show.
  const rolledReport =
    privateRepos === "redact" ? rng.pick(["none", "issue", "artifact"] as const) : "none";
  const privateReport = forced.privateReport ?? rolledReport;
  const selfSlug = ADMIN_SLUG;
  const globalMask = drawGlobalMask(rng.fork("global-mask"), force);
  const missingIndex = rng.int(count);
  // Under redact ONE non-missing target is forced private, or a run where every target rolled public would give an
  // empty forbidden set and a vacuous leak check. count >= 2 guarantees a non-missing index exists.
  const forcedPrivateIndex =
    privateRepos === "redact"
      ? (missingIndex + 1 + rng.int(count - 1)) % count // any non-missing index
      : -1;
  // Incremented per redacted target in target order: the exact numbering planRedaction assigns (self and public skipped).
  let redactedOrdinal = 0;
  const redactionFor = (redacted: boolean, canaries: string[] = []): MultiRepoMeta["redaction"] => {
    if (!redacted) {
      return { kind: "shown" };
    }
    redactedOrdinal += 1;
    return { kind: "redacted", placeholder: redactionPlaceholder(redactedOrdinal), canaries };
  };
  const run: RunDraw = {
    rng,
    force,
    mode,
    policy,
    denialStyle,
    privateRepos,
    globalMask,
    missingIndex,
    forcedPrivateIndex,
    redactionFor,
  };
  const raw = drawRawTarget(rng, run, count);

  const repos: Record<string, MultiRepo> = {};
  const repoMetas: MultiRepoMeta[] = [];
  for (let i = 0; i < count; i++) {
    const target = drawTarget(rng, i, forcedPrivateIndex);
    const generated = genTarget(run, target, raw);
    repos[target.slug] = generated.spec;
    repoMetas.push(generated.meta);
  }

  // Applied WHOLE to the fileless target and never merged into a target with its own file, so the fileless target's
  // meta is exactly the defaults' sections under the default write mask and every other target's meta stays its own.
  const defaultsFile: Json = {
    labels: [{ name: "shared-default", color: "cccccc" }],
    milestones: [{ title: "shared-milestone", state: "open" }],
  };
  const defaults: ScenarioMeta = {
    sections: Object.keys(defaultsFile) as SectionKey[],
    mask: {},
    mode,
    policy,
    ownerKind: "org",
    denialStyle,
    requiredSections: [],
    orgMask: globalMask,
  };

  const scenario: Scenario = {
    name: `fuzz-multi-${rng.seed}`,
    tiers: ["mock"],
    settings: {},
    inputs: {
      mode,
      on_missing_permission: policy,
      private_repos: privateRepos,
      ...(privateReport === "none" ? {} : { private_report: privateReport }),
      // The config rejects the artifact channel without a recipient, and a recipient with any other channel.
      ...(privateReport === "artifact" ? { report_public_key: ARTIFACT_TEST_RECIPIENT } : {}),
    },
    denial_style: denialStyle,
    owner_kind: "org",
    ...(Object.keys(globalMask).length > 0 ? { token_permissions: globalMask } : {}),
    // A GHES-style prefix, as in genScenario.
    ...(rng.fork("base-prefix").bool(0.15) ? { base_prefix: "/api/v3" } : {}),
    repos,
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
      defaults,
    },
  };
}
