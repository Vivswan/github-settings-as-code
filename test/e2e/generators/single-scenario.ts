import { SECTION_KEYS, type SectionKey } from "../../../src/schema.js";
import { genInvitationsState } from "../../sections/collaborators/generators.js";
import { entriesOf, type Json, type LiveWitnessKind } from "../gen-support.js";
import type { LiveState } from "../mock/state.js";
import type { Rng } from "../prng.js";
import type { DenialStyle, MaskGrade, MaskKey, OwnerKind, Scenario } from "../schema.js";
import {
  genLiveWitness,
  genSettings,
  MASK_KEYS,
  presenceLiveState,
  scenarioSecretEnv,
  suppressMaskedCustomProperties,
  suppressMaskedEnvironmentOverrides,
  validateAgainstPublishedSchema,
  WITNESS_KINDS,
  WITNESS_SECTIONS,
} from "./settings.js";

/**
 * A personal account's repository takes pull, push, admin and 422s the rest (mock/state.ts, grantablePermission), and
 * the runtime cannot refuse a triage or maintain there at parse: the owner is unknown until the repository read. So a
 * generated file never declares one on a personal account; maintain folds to push, GitHub's own default. A post-draw
 * rewrite, not a different draw, so the main stream and every recorded seed stay stable.
 */
function personalizeCollaborators(settings: Json, ownerKind: OwnerKind): void {
  if (ownerKind !== "user" || settings.collaborators === undefined) {
    return;
  }
  for (const entry of entriesOf(settings.collaborators)) {
    if (entry.permission === "maintain") {
      entry.permission = "push";
    }
  }
}

export interface GenScenarioOptions {
  /** Restrict generation to these sections (the `--sections` flag); the default is every registered section. */
  sections?: SectionKey[];
}

/** The generation facts the oracle predicts from, so it never re-parses the scenario. */
export interface ScenarioMeta {
  sections: SectionKey[];
  mask: Partial<Record<MaskKey, MaskGrade>>;
  mode: "apply" | "check";
  policy: "fail" | "warn";
  ownerKind: OwnerKind;
  denialStyle: DenialStyle;
  requiredSections: SectionKey[];
  /**
   * The `sections` allowlist the run was generated under; undefined means every declared section runs. orchestrate.ts
   * reports a declared-but-not-allowlisted section as "excluded" BEFORE its handler runs, so the oracle folds exclusion
   * ahead of grades and witnesses.
   */
  onlySections?: SectionKey[];
  /** The witness seeded per WITNESS_SECTIONS member; a section without an entry has no witness and keeps the loose prediction. */
  liveKinds?: Partial<Record<SectionKey, LiveWitnessKind>>;
  /**
   * The GLOBAL token mask, which differs from `mask` (the effective per-slug mask) only in multi-repo mode: the mock
   * grades teams' org gate against its org_members (mock/routes.ts), so the oracle does too. Undefined single-repo,
   * where the effective mask IS the global one.
   */
  orgMask?: Partial<Record<MaskKey, MaskGrade>>;
}

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

  const presence = presenceLiveState(settings) ?? {};

  // Witnesses pin the exact outcome; without them a false-negative drift detector would pass every iteration.
  // A quarter of the time the section keeps absent live state, so the create path stays covered.
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

  // A forked stream, so recorded seeds keep reproducing. No liveKinds entry: the oracle keeps the loose collaborators
  // prediction; the value is the convergence and idempotence gates walking the PATCH, cancel, and expired-re-invite paths.
  const invitationsRng = rng.fork("invitations");
  if (chosen.includes("collaborators") && invitationsRng.bool(0.5)) {
    const invitations = genInvitationsState(invitationsRng, entriesOf(settings.collaborators));
    if (invitations.length > 0) {
      witnessState.invitations = invitations;
    }
  }

  const combinedLive: LiveState = { ...presence, ...witnessState };
  const liveState = Object.keys(combinedLive).length > 0 ? combinedLive : undefined;

  const mask: Partial<Record<MaskKey, MaskGrade>> = {};
  for (const resource of MASK_KEYS) {
    if (rng.bool(0.4)) {
      mask[resource] = rng.pick(["none", "read", "write"] as const);
    }
  }
  suppressMaskedEnvironmentOverrides(settings, mask);
  suppressMaskedCustomProperties(settings, mask, chosen);

  const mode = rng.pick(["apply", "check"] as const);
  const policy = rng.pick(["fail", "warn"] as const);
  const ownerKind: OwnerKind = rng.pick(["org", "user"] as const);
  personalizeCollaborators(settings, ownerKind);
  // 404 answers every denial with Not Found, but the client still classifies a 404 on a write as a permission denial
  // (src/github/api-error.ts), so its outcome classes equal fine_grained's for every operation generated today; 403 discriminates.
  const denialStyle: DenialStyle = rng.pick(["fine_grained", 403, 404] as const);
  const requiredDraw = chosen.filter(() => rng.bool(0.25));
  // A strict nonempty subset of the declared sections, so the EXCLUDED outcome is always reachable.
  // A forked stream, so the main-stream sequence and every recorded seed stay stable.
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
  // Input validation rejects a required section the allowlist excludes, so required sections are filtered to the
  // allowed set. A post-draw filter, not a different draw, so the main stream stays stable.
  const requiredSections =
    onlySections === undefined
      ? requiredDraw
      : requiredDraw.filter((key) => onlySections.includes(key));

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
    // A GHES-style prefix the mock requires on every request, proving the client joins base URLs without dropping or
    // doubling the path (the curated ghes-prefix scenario pins it). A forked draw.
    ...(rng.fork("base-prefix").bool(0.15) ? { base_prefix: "/api/v3" } : {}),
    ...(liveState ? { live_state: liveState } : {}),
    // A placeholder; the oracle fills expect after generation.
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
