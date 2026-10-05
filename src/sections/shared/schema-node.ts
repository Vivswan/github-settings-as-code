/**
 * The ONE reading of a zod schema's structure, through zod's public classes and `.def`, for every walk over a
 * section slice or the document schema. A schema kind no walk handles is refused here, once, so a new zod
 * construct is taught its walk before it is authored in a slice.
 *
 *   object.openness  -> what undeclared keys are to the mapping's contract: refused (strictObject), outside it
 *                       (open() and a bare z.object: the walks project the declared keys, the published schema says
 *                       nothing about the rest), or part of it (z.looseObject: kept everywhere)
 *   union.knob       -> the pair knobbed()/nestedKnobbed()/layeredList() minted (./schema-helpers.ts), known by the
 *                       marks they left (./schema-marks.ts), never by the options' shape; routed() routes it
 *   leaf.values  -> what an enum or literal admits, duplicates included, so a seeded draw over them is stable
 */

import { z } from "zod";
import { type Knob, knobOf, OPEN_CATCHALL } from "./schema-marks.js";

const WRAPPERS = [
  [z.ZodOptional, "optional"],
  [z.ZodNullable, "nullable"],
  [z.ZodDefault, "default"],
  [z.ZodPrefault, "prefault"],
  [z.ZodCatch, "catch"],
  [z.ZodNonOptional, "nonoptional"],
  [z.ZodReadonly, "readonly"],
] as const;

type Wrapper = InstanceType<(typeof WRAPPERS)[number][0]>;

type WrapperKind = (typeof WRAPPERS)[number][1];

type LeafType = "string" | "number" | "boolean" | "null" | "unknown" | "never" | "enum" | "literal";

type Openness = "strict" | "declared" | "open";

export type SchemaNode =
  | {
      readonly kind: "object";
      readonly schema: z.ZodObject;
      readonly shape: Readonly<Record<string, z.ZodType>>;
      readonly openness: Openness;
    }
  | { readonly kind: "array"; readonly schema: z.ZodArray; readonly element: z.ZodType }
  | { readonly kind: "record"; readonly schema: z.ZodRecord; readonly value: z.ZodType }
  | {
      readonly kind: "wrapper";
      readonly schema: Wrapper;
      readonly wrap: WrapperKind;
      readonly inner: z.ZodType;
    }
  | {
      readonly kind: "union";
      readonly schema: z.ZodUnion;
      readonly options: readonly z.ZodType[];
      readonly knob: Knob | null;
    }
  | { readonly kind: "leaf"; readonly type: LeafType; readonly values: readonly unknown[] };

/** zod types a child by its core supertype; every schema in this tree is built with the classic API, which this restores. */
function classic(schema: z.core.$ZodType): z.ZodType {
  return schema as z.ZodType;
}

function openness(catchall: z.core.$ZodType | undefined): Openness {
  if (catchall instanceof z.ZodNever) {
    return "strict";
  }
  return catchall === undefined || catchall === OPEN_CATCHALL ? "declared" : "open";
}

export function schemaNode(schema: z.ZodType): SchemaNode {
  if (schema instanceof z.ZodObject) {
    return { kind: "object", schema, shape: schema.shape, openness: openness(schema.def.catchall) };
  }
  if (schema instanceof z.ZodArray) {
    return { kind: "array", schema, element: classic(schema.element) };
  }
  if (schema instanceof z.ZodRecord) {
    return { kind: "record", schema, value: classic(schema.valueType) };
  }
  for (const [wrapperClass, wrap] of WRAPPERS) {
    if (schema instanceof wrapperClass) {
      return { kind: "wrapper", schema, wrap, inner: classic(schema.unwrap()) };
    }
  }
  if (schema instanceof z.ZodUnion) {
    const options = schema.options.map(classic);
    return { kind: "union", schema, options, knob: knobOf(schema) ?? null };
  }
  if (schema instanceof z.ZodEnum) {
    return { kind: "leaf", type: "enum", values: Object.values(schema.enum) };
  }
  if (schema instanceof z.ZodLiteral) {
    return { kind: "leaf", type: "literal", values: schema.def.values };
  }
  switch (schema.type) {
    case "string":
    case "number":
    case "boolean":
    case "null":
    case "unknown":
    case "never":
      return { kind: "leaf", type: schema.type, values: [] };
    default:
      throw new Error(
        `BUG: schemaNode(): unhandled schema type "${schema.type}" - teach schema-node.ts its walk before authoring it in a section slice`,
      );
  }
}
