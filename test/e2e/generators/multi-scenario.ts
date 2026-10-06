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

/**
 * Derived from the registry's `permission` declarations, the source the oracle's sectionGrade and the mock's gate read
 * too, so a future org-gated section inherits the forced-private strip without a hand edit.
 */
export const ORG_GATED_SECTIONS: ReadonlySet<SectionKey> = new Set(
  SECTIONS.filter((section) => section.permission.org === "members").map((section) => section.key),
);

/** Both raw kinds fail the target before any section runs. */
export type MultiRepoTarget =
  | { kind: "normal"; meta: ScenarioMeta }
  | { kind: "missing" }
  | { kind: "raw-invalid"; raw: "unparseable" | "non-mapping" };

export interface MultiRepoMeta {
  slug: string;
  /** "missing" has no settings file: the action applies the defaults document to it, or skips it when the scenario has none. */
  target: MultiRepoTarget;
  visibility: "public" | "private" | "internal";
  /**
   * True when mask.administration is "none": the visibility probe is denied, the resolver reads "unknown", and
   * redaction fails closed whatever the planted visibility (src/flows/multi.ts).
   */
  probeDenied: boolean;
  /**
   * Redacted iff the policy is redact, the slug is not the self slug, and the target is private/internal or probe-denied.
   *   placeholder  -> the repos-result key planRedaction assigns, numbered per redacted target in target order
   *   canaries     -> unique strings planted in the target's private surfaces; none may appear in a public surface
   */
  redaction: { kind: "shown" } | { kind: "redacted"; placeholder: string; canaries: string[] };
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

export interface MultiScenarioMeta {
  repos: MultiRepoMeta[];
  mode: "apply" | "check";
  policy: "fail" | "warn";
  privateRepos: "redact" | "show";
  /**
   * The `private-report` channel; only `issue` or `artifact` under redact (the config rejects a
   * delivering channel + show). `issue-on-failure` is absent: the oracle does not predict its
   * per-target needsAttention writes, so the curated multi-report-issue-on-failure-* scenarios pin it.
   */
  privateReport: "none" | "issue" | "artifact";
  /** GITHUB_REPOSITORY: a target whose slug equals it is never redacted. */
  selfSlug: string;
  /**
   * The GLOBAL token mask (scenario token_permissions), varied only on org_members. The idempotence eligibility
   * predicate reads it: a globally denied org gate answers a declared teams section no access and denies its grants even when
   * every per-target mask is empty.
   */
  globalMask: Partial<Record<MaskKey, MaskGrade>>;
  /**
   * The forced-private canary target under redact; undefined under show. Tests address THAT target, since an unforced
   * roll can also produce a redacted target.
   */
  forcedPrivateSlug?: string;
  /**
   * A core-route fault the fuzz iteration injected; generation never sets this. `fatal` means the FIRST target's
   * settings fetch dies, whatever its kind would otherwise report; a non-fatal fault is retried away and changes no prediction.
   *   targets run in generation order -> the probes hit the repository route, consuming none of the fault
   *   -> the hook fires before the missing-file 404 and the permission gate
   */
  coreFault?: { key: "core.contentsGet"; fatal: boolean };
  /**
   * The ScenarioMeta a fileless target runs under: the defaults document's sections with an empty per-slug mask.
   * Present exactly when the scenario has a defaults_file; absent, a fileless target is skipped.
   */
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

export function genMultiScenario(
  rng: Rng,
  force?: MultiBatteryForce,
): { scenario: Scenario; meta: MultiScenarioMeta } {
  const count = rng.int(4) + 2;
  const rolledMode = rng.pick(["apply", "check"] as const);
  const mode = force === "idempotence-eligible" ? "apply" : rolledMode;
  const policy = rng.pick(["fail", "warn"] as const);
  const denialStyle: DenialStyle = rng.pick(["fine_grained", 403] as const);
  const rolledPrivateRepos = rng.pick(["redact", "show"] as const);
  const privateRepos =
    force === "issue-report"
      ? "redact"
      : force === "plain-first-target"
        ? "show"
        : rolledPrivateRepos;
  const rolledReport =
    privateRepos === "redact" ? rng.pick(["none", "issue", "artifact"] as const) : "none";
  const privateReport =
    force === "issue-report" ? "issue" : force === "idempotence-eligible" ? "none" : rolledReport;
  const selfSlug = ADMIN_SLUG;
  // Varied ONLY on org_members: the mock grades org routes against the global mask and repo routes against the per-slug
  // overlay (mock/routes.ts), so any other global entry would have mock and oracle grading different masks. The
  // idempotence force clears it: a globally denied org gate leaves a declared teams section granting on every apply, which is no fixpoint.
  const globalMaskRng = rng.fork("global-mask");
  const globalMask: Partial<Record<MaskKey, MaskGrade>> = {};
  if (globalMaskRng.bool(0.3) && force !== "idempotence-eligible") {
    globalMask.org_members = globalMaskRng.pick(["none", "read", "write"] as const);
  }
  const missingIndex = rng.int(count);

  const repos: Record<string, MultiRepo> = {};
  const repoMetas: MultiRepoMeta[] = [];
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
  // Never the missing target (its gate is the contents 404) and never the forced-private one (its canary flow must
  // stay guaranteed for the leak counterfactual).
  const rawCandidates = Array.from({ length: count }, (_, i) => i).filter(
    (i) =>
      i !== missingIndex &&
      i !== forcedPrivateIndex &&
      // The contents-fault battery's victim is always index 0; keep the raw target off it by construction.
      (force !== "plain-first-target" || i !== 0),
  );
  const rolledRawIndex = rawCandidates.length > 0 && rng.bool(0.2) ? rng.pick(rawCandidates) : -1;
  const rawIndex = force === "idempotence-eligible" ? -1 : rolledRawIndex;
  const rawKind = rawIndex >= 0 ? rng.pick(["unparseable", "non-mapping"] as const) : undefined;
  for (let i = 0; i < count; i++) {
    const slug = `e2e-owner/repo-${i}`;
    // Roughly half non-public, so the redaction path is exercised.
    const visibility =
      i === forcedPrivateIndex
        ? rng.pick(["private", "internal"] as const)
        : rng.pick(["public", "public", "private", "internal"] as const);
    if (i === missingIndex) {
      // A fileless target is still probed, so it can still be redacted.
      const probeDenied = false;
      const redacted =
        privateRepos === "redact" && slug !== selfSlug && (visibility !== "public" || probeDenied);
      const repoSpec: MultiRepo = { settings: null };
      if (visibility !== "public") {
        repoSpec.live_state = { repo: { private: true, visibility } };
      }
      repos[slug] = repoSpec;
      repoMetas.push({
        slug,
        target: { kind: "missing" },
        visibility,
        probeDenied,
        redaction: redactionFor(redacted),
      });
      continue;
    }
    if (i === rawIndex && rawKind !== undefined) {
      // Fully granted (no mask), so the contents read succeeds and the parse or top-level-mapping gate, not a permission gate, is what fires.
      const raw =
        rawKind === "unparseable" ? rng.pick(UNPARSEABLE_YAML) : rng.pick(NON_MAPPING_YAML);
      const probeDenied = false;
      const redacted =
        privateRepos === "redact" && slug !== selfSlug && (visibility !== "public" || probeDenied);
      const repoSpec: MultiRepo = { settings_raw: raw };
      if (visibility !== "public") {
        repoSpec.live_state = { repo: { private: true, visibility } };
      }
      repos[slug] = repoSpec;
      repoMetas.push({
        slug,
        target: { kind: "raw-invalid", raw: rawKind },
        visibility,
        probeDenied,
        redaction: redactionFor(redacted),
      });
      continue;
    }
    const child = rng.fork(`repo:${i}`);
    // The secret sections are excluded at the draw: their values are ALWAYS $NAME references, which a target-fetched
    // settings.yml refuses (stripSecretReferences below backstops the webhook secret field and the nested environments secrets).
    const pool = SECTION_KEYS.filter(
      (key) => !(SECRET_LIST_SECTIONS as readonly SectionKey[]).includes(key),
    );
    let sections = pool.filter(() => child.bool(0.5));
    if (sections.length === 0) {
      sections.push(child.pick(pool));
    }
    // The forced-private target's guarantees (never preflight-aborts, always delivers) assume every declared section
    // is fully granted; a globally denied org gate denies org-gated reads whatever the per-slug mask says, so it drops
    // them. The OTHER targets keep them covered.
    if (i === forcedPrivateIndex && globalMask.org_members === "none") {
      sections = sections.filter((key) => !ORG_GATED_SECTIONS.has(key));
      if (sections.length === 0) {
        // A new draw, so it forks off the child stream: the child's downstream draws stay unshifted.
        sections.push(
          child.fork("canary-refill").pick(pool.filter((key) => !ORG_GATED_SECTIONS.has(key))),
        );
      }
    }
    const settings: Json = {};
    for (const key of sections) {
      settings[key] = genSettings(child.fork(`settings:${key}`), key);
    }
    stripSecretReferences(settings);
    const mask: Partial<Record<MaskKey, MaskGrade>> = {};
    for (const resource of MASK_KEYS) {
      if (child.bool(0.3)) {
        mask[resource] = child.pick(["none", "read", "write"] as const);
      }
    }
    // The forced-private target must be a REAL leak test: under apply + fail one denied read preflight-aborts the target
    // and nothing, canary included, is rendered, so its mask is cleared. The idempotence force clears every normal
    // target's mask, since the apply-idempotence gate requires fully-granted targets.
    if (i === forcedPrivateIndex || force === "idempotence-eligible") {
      for (const resource of MASK_KEYS) {
        delete mask[resource];
      }
    }
    suppressMaskedEnvironmentOverrides(settings, mask);
    suppressMaskedCustomProperties(settings, mask, sections);
    const probeDenied = mask.administration === "none";
    const redacted =
      privateRepos === "redact" && slug !== selfSlug && (visibility !== "public" || probeDenied);

    const live: LiveState = presenceLiveState(settings) ?? {};
    if (visibility !== "public") {
      live.repo = { ...(live.repo ?? {}), private: true, visibility };
    }

    // Canaries catch a detail-SUPPRESSION regression, not just a slug leak; a name-matched label keeps the outcome
    // class the labels grade already predicts. Redaction must hide every surface below.
    //   label name (declared = live)      -> the apply change detail
    //   descriptions (declared != live)   -> the check drift detail
    //   repo canary                       -> the live repo description
    const canaries: string[] = [];
    if (redacted) {
      const nameCanary = `CANARY-${rng.seed}-${i}-name`;
      const declaredDescCanary = `CANARY-${rng.seed}-${i}-declared`;
      const liveDescCanary = `CANARY-${rng.seed}-${i}-live`;
      const repoCanary = `CANARY-${rng.seed}-${i}-repo`;
      canaries.push(nameCanary, declaredDescCanary, liveDescCanary, repoCanary);
      const declaredLabels = settings.labels === undefined ? [] : entriesOf(settings.labels);
      declaredLabels.push({ name: nameCanary, color: "abcdef", description: declaredDescCanary });
      if (settings.labels === undefined) {
        settings.labels = declaredLabels;
      }
      const liveLabels = Array.isArray(live.labels) ? (live.labels as Json[]) : [];
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
      redaction: redactionFor(redacted, canaries),
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
          orgMask: globalMask,
        },
      },
    });
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
      ...(privateReport !== "none" ? { private_report: privateReport } : {}),
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
