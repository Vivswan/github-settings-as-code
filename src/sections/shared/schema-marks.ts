/**
 * The marks the minting helpers (./schema-helpers.ts) leave for schemaNode() (./schema-node.ts) to read, so a knob
 * union is known by what minted it, never by its shape. Imports only zod: both sides import this file.
 */

import type { z } from "zod";

/** The two forms a list section takes, as knobbed(), nestedKnobbed(), or layeredList() minted them. */
export interface Knob {
  readonly kind: "knobbed" | "nestedKnobbed" | "layered";
  readonly list: z.ZodArray;
  readonly wrapper: z.ZodObject;
}

/**
 * Keyed by the minted wrapper, not the union: a union's clones (.meta(), .describe(), .check()) keep its options by
 * reference, so the pair resolves through them. A WeakMap, not z.registry: the registry's metadata type is mapped
 * through zod's `$replace`, which recurses into a schema held as a value until tsc gives up (TS2589).
 */
const KNOBS = new WeakMap<z.core.$ZodType, Knob>();

export function markKnob(knob: Knob): void {
  KNOBS.set(knob.wrapper, knob);
}

/** The knob a union is when its two options are a minted wrapper and that wrapper's list, else undefined. */
export function knobOf(union: z.ZodUnion): Knob | undefined {
  const { options } = union;
  if (options.length !== 2) {
    return undefined;
  }
  for (const option of options) {
    const knob = KNOBS.get(option);
    if (knob !== undefined && options.includes(knob.list)) {
      return knob;
    }
  }
  return undefined;
}
