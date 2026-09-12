/**
 * The helpers every snapshot() shares: the projection of a live object onto a section's schema
 * slice (server-assigned fields fall away because the slice never names them), and the knobbed
 * wrapper a list section's snapshot emits.
 */

import type { z } from "zod";
import type { UndeclaredPolicySection } from "../../schema.js";
import type { UndeclaredPolicyList } from "../../types.js";
import { PermissionDenied } from "../contract/errors.js";
import { defaultUndeclaredPolicy, type SectionMeta } from "../contract/module.js";
import { collidingPairs } from "../contract/requests.js";

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
 * A live value projected onto a schema slice: an object keeps exactly the keys the slice's shape
 * names (a loose object keeps its passthrough keys too), each child projected in turn; a list
 * projects its items; a union projects through its first option accepting the value.
 * A `null` the slice cannot hold is GitHub's "no value" (a not-configured setup's null
 * runner_type), so the key is omitted rather than emitted as an invalid declaration; every other
 * value the slice rejects is left in place for the document validation to name.
 * A passthrough slice (a catchall other than never) keeps every live key by design, so server
 * fields cannot fall away there: a section on such a slice names the keys it reads back itself.
 * The one cast is the boundary: the engine validates the assembled document before returning it.
 */
export function projectOntoSchema<T>(schema: z.ZodType<T>, live: unknown): T {
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
          `projectOntoSchema(): unhandled schema type "${def.type}" - teach the projection its walk before authoring it in a section slice`,
        );
      }
      return live;
  }
}

/**
 * Refuse a live list holding two resources under one identity (GitHub allows repeated deploy-key
 * titles and hook urls): the planner manages one resource per identity and would refuse the
 * snapshot's own file, so the snapshot fails here, naming the pairs, instead of emitting it.
 */
export function rejectLiveDuplicates<T>(
  section: SectionMeta,
  noun: string,
  items: readonly T[],
  keyOf: (item: T) => string,
  describe: (item: T) => string,
): void {
  const collisions = collidingPairs(items, keyOf, describe);
  if (collisions.length > 0) {
    throw new Error(
      `${section.key}: GitHub holds ${noun}s that resolve to one identity: ${collisions.join("; ")}. This section manages one ${noun} per identity, so the snapshot cannot declare them; delete all but one of each on GitHub, then snapshot again`,
    );
  }
}

/**
 * One read of a snapshot that a denial may take out without failing the section: a
 * PermissionDenied becomes a note naming the key left out and the grant advice, anything else
 * propagates. For a section whose keys sit behind different grants (repository, actions).
 * @public
 */
export async function readOrNote<T>(
  notes: string[],
  label: string,
  read: () => Promise<T>,
): Promise<{ value: T } | { denied: true }> {
  try {
    return { value: await read() };
  } catch (error) {
    if (error instanceof PermissionDenied) {
      notes.push(`${label}: left out of the snapshot - ${error.detail}`);
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
