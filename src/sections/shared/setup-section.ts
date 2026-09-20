/**
 * The "setup" section factory: code-scanning default setup and code-quality
 * setup expose the same GET/PATCH pair under different paths, so each section
 * module is ONE setupSection() call over the shared verbatim-PATCH plan.
 */

import { z } from "zod";
import { phantomKeys, phantomNote, subsetDiff } from "../../engine/diff.js";
import type { SettingsFile } from "../../schema.js";
import type { MustBeNever } from "../../types.js";
import { CODE_QUALITY_LANGUAGES, CodeQualitySetupConfig } from "../code_quality_setup/schema.js";
import {
  CODE_SCANNING_LANGUAGES,
  CodeScanningDefaultSetupConfig,
} from "../code_scanning_default_setup/schema.js";
import { expand } from "../contract/endpoints.js";
import { raise } from "../contract/errors.js";
import { parseLive } from "../contract/live.js";
import {
  type GraphqlDict,
  loosen,
  requirePlainMapping,
  type SectionSnapshot,
} from "../contract/module.js";
import type { SectionPermission } from "../contract/permissions.js";
import {
  hasDrift,
  type KeyErasedPlan,
  type PlanContext,
  type PlannedOp,
  plainData,
  type SectionPlan,
  type SnapshotContext,
} from "../contract/plan.js";
import { type SetupLanguages, undeclarableLanguages } from "./setup-schema.js";
import { leftOutOfSnapshot, projectOntoSchema } from "./snapshot-helpers.js";

export type SetupKey = "code_scanning_default_setup" | "code_quality_setup";

/** The factory derives routes, shape, and grade from THIS map, so a key paired with another setup's facts is unrepresentable. */
const SETUPS = {
  code_scanning_default_setup: {
    path: "code-scanning/default-setup",
    slice: CodeScanningDefaultSetupConfig,
    languages: CODE_SCANNING_LANGUAGES,
    read: {},
  },
  code_quality_setup: {
    path: "code-quality/setup",
    slice: CodeQualitySetupConfig,
    languages: CODE_QUALITY_LANGUAGES,
    // GitHub gates this GET at write (the Codespaces secrets precedent), so a read-only token is denied it.
    read: { accessGrade: "write" },
  },
} as const satisfies Record<
  SetupKey,
  { path: string; slice: z.ZodObject; languages: SetupLanguages; read: { accessGrade?: "write" } }
>;

type Setup<K extends SetupKey = SetupKey> = (typeof SETUPS)[K];

/**
 * Routes as LITERAL types, so the registry's SectionEndpointKey union, the typed mock fragments, and
 * USED_PATHS see exactly what a hand-written dictionary would declare.
 */
type SetupEndpoints<K extends SetupKey> = {
  readonly get: {
    readonly route: `GET /repos/{owner}/{repo}/${Setup<K>["path"]}`;
    readonly statuses: { readonly 200: string };
    readonly primaryRead: { readonly notFound: "denied" };
    readonly accessGrade?: "write";
  };
  readonly update: {
    readonly route: `PATCH /repos/{owner}/{repo}/${Setup<K>["path"]}`;
    readonly statuses: { readonly 200: string; readonly 202: string; readonly 409: string };
  };
};

type SetupDeclared<K extends SetupKey> = Exclude<SettingsFile[K], undefined>;

/**
 * One setup's plan() over exactly its own dictionary and declared value (the
 * registry's exactness lockstep); indexed by K so the factory's one
 * SharedPlan serves it.
 */
type SetupPlan<K extends SetupKey> = {
  [F in SetupKey]: (
    ctx: PlanContext<SetupEndpoints<F>, GraphqlDict, F>,
    declared: SetupDeclared<F>,
  ) => Promise<SectionPlan<PlannedOp<SetupEndpoints<F>>>>;
}[K];

type WideEndpoints = SetupEndpoints<SetupKey>;

type SharedPlan = (
  ctx: PlanContext<WideEndpoints>,
  declared: SetupDeclared<SetupKey>,
) => Promise<SectionPlan<PlannedOp<WideEndpoints>>>;

// Assignability, not equality: the shared plan takes the union of both declared values, and the
// two languages vocabularies make that union wider than either key's own.
type _SharedPlanServesEverySetup = MustBeNever<
  {
    [K in SetupKey]: [SharedPlan] extends [KeyErasedPlan<SetupPlan<K>>] ? never : K;
  }[SetupKey]
>;

/** The 202 body's configuration run; the optional fields admit the spec's plain-200 EMPTY object, nullish a null or absent body. */
const LiveConfigurationRun = z
  .looseObject({ run_id: z.number().optional(), run_url: z.string().optional() })
  .nullish();

/** The module shape setupSection() mints (SectionModule<K> at the registry). */
export interface SetupSectionModule<K extends SetupKey> {
  readonly key: K;
  readonly undeclaredDefault: "untouched";
  readonly permission: SectionPermission;
  readonly grantCaveat: string;
  readonly endpoints: SetupEndpoints<K>;
  readonly shape: z.ZodType;
  readonly plan: SetupPlan<K>;
  readonly snapshot: (
    ctx: SnapshotContext<SetupEndpoints<K>, GraphqlDict, K>,
  ) => Promise<SectionSnapshot<K>>;
}

/** The GET body: the whole configuration as a mapping, which subsetDiff compares the declared keys against. */
const LiveSetup = z.looseObject({});

/**
 * The GET body in the PATCH's vocabulary: `languages` with the GET-only names folded onto their
 * declarable name (once each), and the names with none set aside. Every other key rides through
 * untouched.
 */
function inPatchVocabulary(
  live: Record<string, unknown>,
  vocabulary: SetupLanguages,
): { live: Record<string, unknown>; undeclarable: string[] } {
  const reported = live.languages;
  if (!Array.isArray(reported)) {
    return { live, undeclarable: [] };
  }
  const folded = new Set<string>();
  const undeclarable: string[] = [];
  for (const name of reported) {
    const declarable = vocabulary.declarable.includes(name)
      ? name
      : Object.hasOwn(vocabulary.getOnly, name)
        ? vocabulary.getOnly[name]
        : undefined;
    if (typeof declarable === "string") {
      folded.add(declarable);
    } else {
      undeclarable.push(name);
    }
  }
  return { live: { ...live, languages: [...folded] }, undeclarable };
}

/** The verbatim-PATCH plan, the named 202 configuration run, and the 409 advice live here once; routes, shape, and read grade derive from the key. */
export function setupSection<K extends SetupKey>(setup: {
  key: K;
  /** The fine-grained-PAT permission gating both endpoints. */
  permission: SectionPermission;
  /** What else a 403 here can mean (the feature not enabled, an archived repository). */
  grantCaveat: string;
  /** The output noun for change lines ("code scanning default setup"). */
  noun: string;
}): SetupSectionModule<K> {
  const { key, permission, grantCaveat, noun } = setup;
  const { path, slice, languages, read }: Setup<K> = SETUPS[key];
  const readGrade: { accessGrade?: "write" } = read;
  const endpoints: SetupEndpoints<K> = {
    get: {
      route: `GET /repos/{owner}/{repo}/${path}`,
      statuses: { 200: `the current ${noun} configuration` },
      // A fine-grained token conceals a denied GET as 404; reading it as "not configured" would be wrong, so it is a denial.
      primaryRead: { notFound: "denied" },
      ...readGrade,
    },
    update: {
      route: `PATCH /repos/{owner}/{repo}/${path}`,
      statuses: {
        200: "setup updated",
        202: "GitHub started an async configuration run; the body carries run_id",
        409: "a configuration run is already in progress",
      },
    },
  };

  const wide: WideEndpoints = endpoints;
  const plan: SharedPlan = async (ctx, declared) => {
    const desired: Record<string, unknown> = declared;
    const planned: SectionPlan<PlannedOp<WideEndpoints>> = { ops: [], notes: [], drift: [] };
    const reported = await ctx.read.get.call(LiveSetup);
    // The keys pass through, so a key GitHub never echoes would re-PATCH on every apply without
    // converging. A slice key the GET lacks is drift the PATCH resolves (the GET reports every PATCH
    // field), so only a key outside the slice is noted.
    const phantom = phantomKeys(desired, reported).filter(
      (name) => !Object.hasOwn(slice.shape, name),
    );
    if (phantom.length > 0) {
      planned.notes.push(phantomNote(key, phantom, noun, "this PATCH will re-run"));
    }
    const { live, undeclarable } = inPatchVocabulary(reported, languages);
    if (undeclarable.length > 0) {
      planned.notes.push(
        `${key}.languages: left out of the compare - ${undeclarableLanguages(undeclarable)}`,
      );
    }
    const drift = subsetDiff(desired, live, key);
    if (!hasDrift(drift)) {
      return planned;
    }
    planned.ops.push({
      role: "update",
      payload: plainData(desired),
      drift,
      // 409 is a declared status of the PATCH, so the tolerance can give wait-and-retry advice instead of failureFor's generic text.
      tolerate: {
        statuses: [409],
        outcome: (error) => ({
          failure: `${key}: PATCH ${expand(wide.update, ctx)}: ${error.status} ${error.message}. A ${noun} configuration run is already in progress on the repository; re-run the workflow after it finishes`,
        }),
      },
      change: (response) => {
        const run = raise(parseLive(section, wide.update, LiveConfigurationRun, response));
        if (run?.run_id === undefined) {
          return `applied ${noun}`;
        }
        const url = run.run_url ? ` (${run.run_url})` : "";
        return `applied ${noun}; GitHub started configuration run ${run.run_id}${url} to roll it out, and the settings take effect when it finishes`;
      },
    });
    return planned;
  };

  // The GET always answers with the whole configuration (a not-configured setup included), so
  // the snapshot is that body, in the PATCH's vocabulary, on the slice's keys; the PATCH takes the
  // same keys back verbatim. SETUPS pairs the slice with its key, so its projection IS the section's
  // declared type; the casts are the wide-port and per-key boundaries.
  const snapshot = async (
    ctx: SnapshotContext<SetupEndpoints<K>, GraphqlDict, K>,
  ): Promise<SectionSnapshot<K>> => {
    const reported = await (ctx as SnapshotContext<WideEndpoints, GraphqlDict, K>).read.get.call(
      LiveSetup,
    );
    const { live, undeclarable } = inPatchVocabulary(reported, languages);
    const notes =
      undeclarable.length > 0
        ? [leftOutOfSnapshot(`${key}.languages`, undeclarableLanguages(undeclarable))]
        : [];
    return { value: projectOntoSchema(slice, live) as SetupDeclared<K>, notes };
  };

  const section: SetupSectionModule<K> = {
    key,
    undeclaredDefault: "untouched",
    permission,
    grantCaveat,
    endpoints,
    shape: requirePlainMapping(loosen(slice)),
    plan,
    snapshot,
  };
  return section;
}
