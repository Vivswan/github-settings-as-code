/**
 * The helpers every snapshot() shares: the projection of a live object onto a section's schema
 * slice (server-assigned fields fall away because the slice never names them), and the knobbed
 * wrapper a list section's snapshot emits.
 */

import type { z } from "zod";
import type { ReplaceSweep } from "../../engine/diff.js";
import type { UndeclaredPolicySection } from "../../schema.js";
import type { UndeclaredPolicyList } from "../../types.js";
import { PermissionDenied } from "../contract/errors.js";
import { defaultUndeclaredPolicy, type SectionMeta } from "../contract/module.js";
import type { SnapshotContext } from "../contract/plan.js";

/** The zod internals the projection walks: the def discriminator and its children. */
interface ProjectionDef {
  type: string;
  shape?: Record<string, z.ZodType>;
  catchall?: z.ZodType;
  element?: z.ZodType;
  innerType?: z.ZodType;
  options?: readonly z.ZodType[];
  valueType?: z.ZodType;
}

function defOf(schema: z.ZodType): ProjectionDef {
  return (schema as unknown as { _zod: { def: ProjectionDef } })._zod.def;
}

/** The schema types the projection treats as leaves: the live value passes through verbatim. */
const LEAF_TYPES: ReadonlySet<string> = new Set([
  "string",
  "number",
  "int",
  "boolean",
  "enum",
  "literal",
  "unknown",
  "null",
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A live value projected onto a schema slice, so server-assigned fields fall away without a hand
 * list per section. A nested `null` the slice cannot hold is GitHub's "no value" (a not-configured
 * setup's runner_type) and its key is omitted; a value the slice rejects at the root stays, so the
 * engine's validation names a body outside the shape instead of the section vanishing. A
 * passthrough slice (a catchall other than never) keeps every live key by design, so a section on
 * one names the keys it reads back itself. The casts are the boundary the engine validates behind.
 */
export function projectOntoSchema<T>(schema: z.ZodType<T>, live: unknown): T {
  if (live === null && !schema.safeParse(null).success) {
    return live as T;
  }
  return project(schema, live) as T;
}

function project(schema: z.ZodType, live: unknown): unknown {
  if (live === undefined) {
    return undefined;
  }
  if (live === null) {
    return schema.safeParse(null).success ? null : undefined;
  }
  const def = defOf(schema);
  switch (def.type) {
    case "optional":
    case "nullable":
    case "default":
      return project(def.innerType as z.ZodType, live);
    case "object": {
      if (!isPlainObject(live)) {
        return live;
      }
      const shape = def.shape ?? {};
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(shape)) {
        const projected = project(child, live[key]);
        if (projected !== undefined) {
          out[key] = projected;
        }
      }
      // A catchall other than never is a passthrough object: its extra keys are declarable.
      if (def.catchall !== undefined && defOf(def.catchall).type !== "never") {
        for (const [key, value] of Object.entries(live)) {
          if (!(key in shape) && value !== undefined) {
            out[key] = value;
          }
        }
      }
      return out;
    }
    case "array":
      return Array.isArray(live)
        ? live.map((item) => project(def.element as z.ZodType, item))
        : live;
    case "record":
      return isPlainObject(live)
        ? Object.fromEntries(
            Object.entries(live).map(([key, value]) => [
              key,
              project(def.valueType as z.ZodType, value),
            ]),
          )
        : live;
    case "union": {
      const option = (def.options ?? []).find((candidate) => candidate.safeParse(live).success);
      return option === undefined ? live : project(option, live);
    }
    default:
      if (!LEAF_TYPES.has(def.type)) {
        throw new Error(
          `BUG: projectOntoSchema(): unhandled schema type "${def.type}" - teach the projection its walk before authoring it in a section slice`,
        );
      }
      return live;
  }
}

/**
 * What a replace-write comparison's omission sweep needs to know about a slice: the dotted paths where it stops
 * typing keys (a record, an unknown, or an object with a catchall, a list item spelled `[]`: `rules[].parameters`,
 * `bypass_actors[]`), which the sweep skips while the typed list key itself still counts, and the paths that accept
 * `null`, whose clearing spelling is `null`.
 */
export function replaceSweep(schema: z.ZodType): ReplaceSweep {
  const passthrough: string[] = [];
  const nullable: string[] = [];
  collectSweep(schema, "", passthrough, nullable);
  return { passthrough, nullable };
}

function collectSweep(
  schema: z.ZodType,
  path: string,
  passthrough: string[],
  nullable: string[],
): void {
  const def = defOf(schema);
  switch (def.type) {
    case "optional":
    case "default":
      collectSweep(def.innerType as z.ZodType, path, passthrough, nullable);
      return;
    case "nullable":
      nullable.push(path);
      collectSweep(def.innerType as z.ZodType, path, passthrough, nullable);
      return;
    case "array":
      collectSweep(def.element as z.ZodType, `${path}[]`, passthrough, nullable);
      return;
    case "union":
      for (const option of def.options ?? []) {
        collectSweep(option, path, passthrough, nullable);
      }
      return;
    case "object": {
      if (def.catchall !== undefined && defOf(def.catchall).type !== "never") {
        passthrough.push(path);
        return;
      }
      for (const [key, child] of Object.entries(def.shape ?? {})) {
        collectSweep(child, path === "" ? key : `${path}.${key}`, passthrough, nullable);
      }
      return;
    }
    case "record":
    case "unknown":
      passthrough.push(path);
      return;
    default:
      return;
  }
}

/**
 * The ONE wording for a live resource, key, or entry a snapshot reads but does not declare: the label,
 * then the reason (a denied read, an inherited ruleset, a role no declaration plans as), then what the
 * operator can do about it when there is something.
 */
export function leftOutOfSnapshot(label: string, reason: string): string {
  return `${label}: left out of the snapshot - ${reason}`;
}

/**
 * One read of a snapshot whose denial is that read's alone, for a section whose keys sit behind
 * different grants (repository, actions, environments). Under `warn` a PermissionDenied becomes a
 * note naming the key left out and the grant advice; under `fail` it propagates, so the engine
 * fails the section exactly as it does a primary read's denial. Anything else propagates. The
 * policy arrives as the carrier only snapshotContext() mints, so a section cannot pick "warn".
 */
export async function readOrNote<T>(
  ctx: Pick<SnapshotContext, "onMissingPermission">,
  notes: string[],
  label: string,
  read: () => Promise<T>,
): Promise<{ value: T } | { denied: true }> {
  try {
    return { value: await read() };
  } catch (error) {
    if (error instanceof PermissionDenied && ctx.onMissingPermission.notesDenials) {
      notes.push(leftOutOfSnapshot(label, error.detail));
      return { denied: true };
    }
    throw error;
  }
}

/** A knobbed section's snapshot value: its entries under the section's own default policy, spelled out. */
export function knobbedSnapshot<E>(
  section: SectionMeta<UndeclaredPolicySection>,
  entries: E[],
): UndeclaredPolicyList<E> {
  return { _undeclared: defaultUndeclaredPolicy(section), entries };
}

/**
 * The ONE wording for a secret a snapshot declares as a `$NAME` reference because GitHub never reveals
 * its value: `what` names it ("DEPLOY_TOKEN", "the webhook secret").
 */
export function unreadableSecretNote(label: string, what: string, variable: string): string {
  return `${label}: value of ${what} is not readable; export it into the environment as ${variable} before apply`;
}
