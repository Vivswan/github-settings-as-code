/**
 * The ONE reading of a zod schema's structure, through zod's public classes and `.def`, for every walk over a
 * section slice or the document schema. A schema kind no walk handles is refused here, once, so a new zod
 * construct is taught its walk before it is authored in a slice.
 *
 *   object.open  -> a catchall other than never admits undeclared keys; a strip object (no catchall) is closed to the
 *                   walks, and loosen() in ../contract/module.ts is what opens it at runtime
 *   union.knob   -> the knobbed()/layeredList() pair (../shared/schema-helpers.ts): the bare entry array beside a
 *                   strict wrapper carrying `entries`, which the canonical walk and loosen() route by container
 *   leaf.values  -> what an enum or literal admits, duplicates included, so a seeded draw over them is stable
 */

import { z } from "zod";

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

/** The two forms a knobbed or layered list section takes: the bare entry array, or the strict wrapper with `entries`. */
interface KnobUnion {
  readonly list: z.ZodArray;
  readonly wrapper: z.ZodObject;
}

export type SchemaNode =
  | {
      readonly kind: "object";
      readonly schema: z.ZodObject;
      readonly shape: Readonly<Record<string, z.ZodType>>;
      readonly catchall: z.ZodType | undefined;
      readonly open: boolean;
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
      readonly knob: KnobUnion | null;
    }
  | { readonly kind: "leaf"; readonly type: LeafType; readonly values: readonly unknown[] };

/** zod types a child by its core supertype; every schema in this tree is built with the classic API, which this restores. */
function classic(schema: z.core.$ZodType): z.ZodType {
  return schema as z.ZodType;
}

function knobUnion(options: readonly z.ZodType[]): KnobUnion | null {
  if (options.length !== 2) {
    return null;
  }
  const list = options.find((option): option is z.ZodArray => option instanceof z.ZodArray);
  const wrapper = options.find(
    (option): option is z.ZodObject =>
      option instanceof z.ZodObject &&
      option.def.catchall instanceof z.ZodNever &&
      option.shape.entries !== undefined,
  );
  return list !== undefined && wrapper !== undefined ? { list, wrapper } : null;
}

export function schemaNode(schema: z.ZodType): SchemaNode {
  if (schema instanceof z.ZodObject) {
    const catchall = schema.def.catchall === undefined ? undefined : classic(schema.def.catchall);
    return {
      kind: "object",
      schema,
      shape: schema.shape,
      catchall,
      open: catchall !== undefined && !(catchall instanceof z.ZodNever),
    };
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
    return { kind: "union", schema, options, knob: knobUnion(options) };
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
