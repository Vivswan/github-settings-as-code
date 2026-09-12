/**
 * The "setup" section factory: code-scanning default setup and code-quality
 * setup expose the same GET/PATCH pair under different paths, so each section
 * module is ONE setupSection() call over the shared verbatim-PATCH plan.
 */

import { z } from "zod";
import { subsetDiff } from "../../engine/diff.js";
import type { SettingsFile } from "../../schema.js";
import type { MustBeNever } from "../../types.js";
import { CodeQualitySetupConfig } from "../code_quality_setup/schema.js";
import { CodeScanningDefaultSetupConfig } from "../code_scanning_default_setup/schema.js";
import { expand } from "../contract/endpoints.js";
import { parseLive } from "../contract/live.js";
import { loosen, requirePlainMapping, type SectionSnapshot } from "../contract/module.js";
import type { SectionPermission } from "../contract/permissions.js";
import {
  hasDrift,
  type PlanContext,
  type PlannedOp,
  plainData,
  type SectionPlan,
} from "../contract/plan.js";
import { projectOntoSchema } from "./snapshot-helpers.js";

export type SetupKey = "code_scanning_default_setup" | "code_quality_setup";

/** The factory derives routes, shape, and grade from THIS map, so a key paired with another setup's facts is unrepresentable. */
const SETUPS = {
  code_scanning_default_setup: {
    path: "code-scanning/default-setup",
    slice: CodeScanningDefaultSetupConfig,
    read: {},
  },
  code_quality_setup: {
    path: "code-quality/setup",
    slice: CodeQualitySetupConfig,
    // GitHub gates this GET at write (the Codespaces secrets precedent), so a read-only token is denied it.
    read: { accessGrade: "write" },
  },
} as const satisfies Record<
  SetupKey,
  { path: string; slice: z.ZodType; read: { accessGrade?: "write" } }
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
 * SharedPlan can be assigned to it.
 */
type SetupPlan<K extends SetupKey> = {
  [F in SetupKey]: (
    ctx: PlanContext<SetupEndpoints<F>>,
    declared: SetupDeclared<F>,
  ) => Promise<SectionPlan<PlannedOp<SetupEndpoints<F>>>>;
}[K];

type WideEndpoints = SetupEndpoints<SetupKey>;

type SharedPlan = (
  ctx: PlanContext<WideEndpoints>,
  declared: SetupDeclared<SetupKey>,
) => Promise<SectionPlan<PlannedOp<WideEndpoints>>>;

type Invariant<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

type _SharedPlanIsEverySetupPlan = MustBeNever<
  {
    [K in SetupKey]: Invariant<SharedPlan, SetupPlan<K>> extends true ? never : K;
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
  readonly snapshot: (ctx: PlanContext<SetupEndpoints<K>>) => Promise<SectionSnapshot<K>>;
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
  const { path, slice, read }: Setup<K> = SETUPS[key];
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
    const drift = subsetDiff(desired, await ctx.read.get.call(), key);
    if (!hasDrift(drift)) {
      return planned;
    }
    planned.ops.push({
      role: "update",
      payload: plainData(desired),
      drift,
      // 409 is a declared status of the PATCH, so the tolerance can give wait-and-retry advice instead of throwFor's generic text.
      tolerate: {
        statuses: [409],
        outcome: (error) => ({
          failure: `${key}: PATCH ${expand(wide.update, ctx)}: ${error.status} ${error.message}. A ${noun} configuration run is already in progress on the repository; re-run the workflow after it finishes`,
        }),
      },
      change: (response) => {
        const run = parseLive(section, wide.update, LiveConfigurationRun, response);
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
  // the snapshot is that body on the slice's keys; the PATCH takes the same keys back verbatim.
  // SETUPS pairs the slice with its key, so its projection IS the section's declared type; the
  // casts are the wide-port and per-key boundaries.
  const snapshot = async (ctx: PlanContext<SetupEndpoints<K>>): Promise<SectionSnapshot<K>> => {
    const live = await (ctx as PlanContext<WideEndpoints>).read.get.call();
    return { value: projectOntoSchema(slice as z.ZodType, live) as SetupDeclared<K>, notes: [] };
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
