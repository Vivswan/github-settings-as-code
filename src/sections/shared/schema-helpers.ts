/**
 * Imports only zod, renamed-key.ts, and the text leaf: a section schema importing src/schema.ts back would be a cycle
 * whose top-level consts TDZ-crash at import time, so everything both sides need lives here.
 */

import { z } from "zod";
import { agree } from "../../text.js";
import { renamedKeyError } from "./renamed-key.js";

/**
 * The one value set of the `_undeclared` knob (a wrapper's, a file's top level) and the `undeclared` run input;
 * engine/layers.ts resolves it and re-exports it to the flows. Described in docs/sections/shared.docs.yml and docs/schema.docs.yml.
 */
export const UNDECLARED_POLICIES = ["keep", "delete"] as const;

export const UndeclaredPolicySchema = z.enum(UNDECLARED_POLICIES).meta({ id: "UndeclaredPolicy" });

/**
 * A JSON Schema conditional for the published schema, the one place the keyword pair is spelled. zod refinements
 * do not reach z.toJSONSchema, so a cross-field refinement gets a twin built here and attached through .meta(),
 * and test/published-schema.test.ts holds the two sides to the same verdicts.
 */
export function conditional(
  condition: Record<string, unknown>,
  consequence: Record<string, unknown>,
  otherwise?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    if: condition,
    // biome-ignore lint/suspicious/noThenProperty: `then` is the JSON Schema keyword paired with `if`, not a thenable
    then: consequence,
    ...(otherwise === undefined ? {} : { else: otherwise }),
  };
}

/**
 * The one value set of the `_layering` directive and the `layering` run input; engine/layers.ts acts on it and
 * re-exports it to the flows. Described in docs/sections/shared.docs.yml and docs/schema.docs.yml.
 *
 *   replace  -> the higher list replaces the whole lower list
 *   shallow  -> union by key; a same-key entry is swapped for the higher one
 *   deep     -> union by key; a same-key pair merges field by field, nested keyed lists included
 */
export const LAYERINGS = ["replace", "shallow", "deep"] as const;

export type Layering = (typeof LAYERINGS)[number];

export const LayeringSchema = z.enum(LAYERINGS);

const renamedPolicyKeyError = renamedKeyError(
  "wrapper's policy",
  "undeclared",
  "_undeclared",
  "in v3 (a directive, like _layering) - write _undeclared: keep or _undeclared: delete",
);

/**
 * The two wrapper kinds, each named as its published definition is (`<name><Entry>`) and with the directives its key
 * error names. Only the knobbed wrapper ever spelled the policy without its underscore, so only it names the rename.
 */
const WRAPPER_KINDS = {
  knobbed: {
    name: "UndeclaredPolicyList",
    directives: '"_undeclared" and, on a top-level section, "_layering"',
    renamed: true,
  },
  layered: {
    name: "LayeredList",
    directives:
      '"_layering" alone (this section applies no undeclared policy, so its wrapper takes no "_undeclared")',
    renamed: false,
  },
} as const;
type WrapperKind = (typeof WRAPPER_KINDS)[keyof typeof WRAPPER_KINDS];

/**
 * The wrapper's unrecognized keys, one clause per kind, joined: the pre-v3 policy spelling names its rename, and
 * any other underscore key names the wrapper's directives, since a wrapper takes no private notes either (the
 * document level says the same in src/problem.ts). A misspelled entry field beside them stays on zod's own line, so
 * the directives clause names the underscore keys it is about whenever the list holds anything else.
 */
function wrapperKeyError(issue: z.core.$ZodRawIssue, kind: WrapperKind): string | undefined {
  if (issue.code !== "unrecognized_keys") {
    return undefined;
  }
  const renamed = kind.renamed ? renamedPolicyKeyError(issue) : undefined;
  const directives = issue.keys.filter((key) => key.startsWith("_"));
  if (directives.length === 0) {
    return renamed;
  }
  const quoted = (keys: readonly string[]) => keys.map((key) => JSON.stringify(key)).join(", ");
  const clause =
    `${directives.length < issue.keys.length ? `${quoted(directives)}: ` : ""}the wrapper's directives are ` +
    `${kind.directives}, and nothing else - there are no ` +
    "private-note keys. Remove the key, or keep the note as a YAML comment";
  return renamed === undefined
    ? `${agree(issue.keys.length, "Unrecognized key", "Unrecognized keys")}: ${quoted(issue.keys)}; ${clause}`
    : `${renamed}; ${clause}`;
}

/**
 * The bare list beside its strict wrapper, whose keys `shape` chooses around `entries`. loosen() (../contract/module.ts)
 * and engine/canonical.ts recognize the union by the wrapper's `entries`. The wrapper's definition name derives from
 * the list element's own .meta({id}), so the document composition and a section's runtime derivation can never label
 * one entry differently.
 *
 *   element without an id                      -> throws at MODULE LOAD, not typecheck
 *   z.toJSONSchema(SettingsFile)               -> fine: it resolves metadata by schema identity
 *   a generator over z.globalRegistry's ids    -> sees only the last-registered wrapper (each call mints a fresh one under the same id)
 */
function wrappedList<L extends z.ZodArray<z.ZodType>, S extends z.core.$ZodShape>(
  list: L,
  kind: WrapperKind,
  shape: (entries: L) => S,
) {
  const entryName = z.globalRegistry.get(list.element)?.id;
  if (entryName === undefined) {
    throw new Error(
      `BUG: ${kind.name}: the list's element schema carries no .meta({id}) name to derive the wrapper's definition name from; give the entry config a .meta({id})`,
    );
  }
  const wrapper = z
    .strictObject(shape(list), { error: (issue) => wrapperKeyError(issue, kind) })
    .meta({ id: `${kind.name}<${entryName}>` });
  return z.union([list, wrapper]);
}

function knobbedList<T extends z.ZodType, S extends z.core.$ZodShape>(
  entry: T,
  shape: (knobs: {
    _undeclared: z.ZodOptional<typeof UndeclaredPolicySchema>;
    entries: z.ZodArray<T>;
  }) => S,
) {
  return wrappedList(z.array(entry), WRAPPER_KINDS.knobbed, (entries) =>
    shape({ _undeclared: UndeclaredPolicySchema.optional(), entries }),
  );
}

/**
 * Only a TOP-LEVEL wrapper takes `_layering`: the layered merge combines sections, so only a
 * section-level wrapper has layers below it to address.
 */
export function knobbed<T extends z.ZodType>(entry: T) {
  return knobbedList(entry, (knobs) => ({ ...knobs, _layering: LayeringSchema.optional() }));
}

/**
 * A nested list (environments[].variables) unions by its own key under the directive its entry inherits, so
 * `_layering` on its wrapper would be accepted and never act; the wrapper rejects it.
 */
export function nestedKnobbed<T extends z.ZodType>(entry: T) {
  return knobbedList(entry, (knobs) => knobs);
}

/**
 * The wrapper of a list section that applies no undeclared policy (environments, branches, workflows): the bare list
 * beside `{_layering, entries}`. The directive is the only reason the wrapper exists, so the fold consumes it and
 * writes the bare list, and a planner reads either form through listEntries() (../contract/module.ts). The list's own
 * refinements (the pinned-environments cap) ride along as the wrapper's `entries`.
 */
export function layeredList<L extends z.ZodArray<z.ZodType>>(list: L) {
  return wrappedList(list, WRAPPER_KINDS.layered, (entries) => ({
    _layering: LayeringSchema.optional(),
    entries,
  }));
}

/** A repository-scope sealed secret entry (name + `$NAME` reference value). */
export function sealedSecretConfig(id: string) {
  return z
    .object({
      name: secretName,
      value: z.string(),
    })
    .meta({ id });
}

/** A repository-scope plain-text variable entry; the environments section's nested list is the same shape. */
export function variableConfig(id: string) {
  return z
    .object({
      name: variableName,
      value: variableValue,
    })
    .meta({ id });
}

/**
 * A string GitHub caps by size, refused past the cap with the measured size in the message. The check runs on
 * strings alone: zod's own `.max()` runs on any value with a `length`, so a YAML mapping `{length: 101}` reached the
 * comparison and threw, while a refinement is skipped once the type check has failed. JSON Schema's maxLength counts
 * code points, so the published bound is exact for a code-point cap and, for a byte cap, the loosest bound an editor
 * can check without refusing a value GitHub accepts (a code point is at least one byte).
 */
export function boundedString(
  maximum: number,
  measure: "code points" | "utf8 bytes",
  message: (size: number) => string,
) {
  const utf8 = new TextEncoder();
  const sizeOf =
    measure === "utf8 bytes"
      ? (value: string) => utf8.encode(value).byteLength
      : (value: string) => [...value].length;
  return z
    .string()
    .refine((value) => sizeOf(value) <= maximum, {
      error: (issue: z.core.$ZodRawIssue) => message(sizeOf(issue.input as string)),
    })
    .meta({ maxLength: maximum });
}

/** GitHub's documented cap on one variable's value, 48 KB, counted in UTF-8 bytes as GitHub does. */
export const MAX_VARIABLE_VALUE_BYTES = 48 * 1024;

const variableValue = boundedString(
  MAX_VARIABLE_VALUE_BYTES,
  "utf8 bytes",
  (bytes) =>
    `the variable value is ${bytes} bytes of UTF-8; GitHub caps a variable at 48 KB (${MAX_VARIABLE_VALUE_BYTES} bytes). Shorten it, or move the content into a file the workflow reads`,
);

/**
 * The pattern doubles as the published schema's `pattern`, so it spells the case-insensitive prefix without a flag;
 * the API uppercases before it compares, so `github_token` is the reserved GITHUB_TOKEN.
 */
const GITHUB_NAME_PATTERN = /^(?![Gg][Ii][Tt][Hh][Uu][Bb]_)[A-Za-z_][A-Za-z0-9_]*$/;
const GITHUB_NAME_RULE =
  "GitHub accepts ASCII letters, digits, and underscores, not starting with a digit or with the reserved GITHUB_ prefix (in any case: names are stored uppercased)";

function githubName(noun: "secret" | "variable") {
  const reasonFor = (name: string): string => {
    if (name === "") {
      return "is empty";
    }
    if (/^github_/i.test(name)) {
      return "starts with the reserved GITHUB_ prefix";
    }
    if (/^[0-9]/.test(name)) {
      return "starts with a digit";
    }
    return "has characters outside ASCII letters, digits, and underscore";
  };
  return z.string().regex(GITHUB_NAME_PATTERN, {
    error: (issue: z.core.$ZodRawIssue) =>
      `the ${noun} name ${JSON.stringify(issue.input)} ${reasonFor(issue.input as string)} - ${GITHUB_NAME_RULE}`,
  });
}

/** Secret and variable names share GitHub's one rule; the noun only tells the problem line which it is reading. */
export const secretName = githubName("secret");
const variableName = githubName("variable");
