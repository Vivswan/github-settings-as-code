/**
 * The control for the live-shape pins (src/sections/contract/pin.ts). A pin that accepted every schema would
 * drift silently: each `Pinned` alias and pinned factory parameter would go on compiling against a renamed
 * field. Each line below is a pin that must not compile, one per way of refusing, so `typecheck` fails here,
 * on an unused `@ts-expect-error`, the day the pin stops refusing it.
 */

import { test } from "bun:test";
import { z } from "zod";
import type { actionsSecretsSection } from "../../src/sections/actions_secrets/index.js";
import type { Body, EnvelopedItem, Item, Pinned } from "../../src/sections/contract/pin.js";
import type { labelsSection } from "../../src/sections/labels/index.js";
import type { rulesetsSection } from "../../src/sections/rulesets/index.js";

type LabelItem = Item<typeof labelsSection.endpoints.list>;

type RulesetBody =
  | Item<typeof rulesetsSection.endpoints.list>
  | Body<typeof rulesetsSection.endpoints.get>;

type SecretItem = EnvelopedItem<typeof actionsSecretsSection.endpoints.list, "secrets">;

test("a live schema that parts ways with Octokit's response type does not compile", () => {
  const misspelled = z.looseObject({ name: z.string(), colour: z.string() });
  const nestedWrongType = z.looseObject({
    rules: z.array(z.looseObject({ type: z.number() })).optional(),
  });
  const renamed = z.looseObject({ secret_name: z.string() });
  const optionalStranger = z.looseObject({ name: z.string(), colour: z.string().optional() });
  const erased: z.ZodType<{ name: string }> = z.looseObject({ name: z.string() });
  const agreeing = z.looseObject({ name: z.string(), description: z.string().nullable() });

  // @ts-expect-error `colour` is no field of a label
  type _Misspelled = Pinned<typeof misspelled, LabelItem>;
  // @ts-expect-error a rule's `type` is a string
  type _NestedWrongType = Pinned<typeof nestedWrongType, RulesetBody>;
  // @ts-expect-error a listed secret carries `name`
  type _Renamed = Pinned<typeof renamed, SecretItem>;
  // @ts-expect-error assignability admits an optional key Octokit lacks; only the key walk refuses it
  type _OptionalStranger = Pinned<typeof optionalStranger, LabelItem>;
  // @ts-expect-error an annotation erased the input type, so nothing was compared
  type _Erased = Pinned<typeof erased, LabelItem>;
  // biome-ignore lint/suspicious/noExplicitAny: the control is that `any` is refused
  type Anything = any;
  // @ts-expect-error `any` is no response type
  type _Untyped = Pinned<typeof agreeing, Anything>;
  type _Agreeing = Pinned<typeof agreeing, LabelItem>;
});
