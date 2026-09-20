/**
 * Imports only zod, renamed-key.ts, and the text leaf: a section schema importing src/schema.ts back would be a cycle
 * whose top-level consts TDZ-crash at import time, so everything both sides need lives here.
 * The smoke selector (.github/scripts/changed-sections.ts) derives this file's section fan-out from the import graph.
 */

import { z } from "zod";
import { agree } from "../../text.js";
import { renamedKeyError } from "./renamed-key.js";

const UndeclaredPolicySchema = z.enum(["keep", "delete"]).meta({ id: "UndeclaredPolicy" });

/**
 * engine/layers.ts declares the same value set in its own Layering type and acts on the parsed value, so a
 * new value lands in both. Described in shared.docs.yml and src/schema.docs.yml.
 */
export const LayeringSchema = z.enum(["merge", "replace"]);

const renamedPolicyKeyError = renamedKeyError(
  "wrapper's policy",
  "undeclared",
  "_undeclared",
  "in v3 (a directive, like _layering) - write _undeclared: keep or _undeclared: delete",
);

/**
 * The wrapper's unrecognized keys, one clause per kind, joined: the pre-v3 policy spelling names its rename, and
 * any other underscore key names the two directives, since a wrapper takes no private notes either (the document
 * level says the same in src/problem.ts). A misspelled entry field beside them stays on zod's own line, so the
 * directives clause names the underscore keys it is about whenever the list holds anything else.
 */
function wrapperKeyError(issue: z.core.$ZodRawIssue): string | undefined {
  if (issue.code !== "unrecognized_keys") {
    return undefined;
  }
  const renamed = renamedPolicyKeyError(issue);
  const directives = issue.keys.filter((key) => key.startsWith("_"));
  if (directives.length === 0) {
    return renamed;
  }
  const quoted = (keys: readonly string[]) => keys.map((key) => JSON.stringify(key)).join(", ");
  const clause =
    `${directives.length < issue.keys.length ? `${quoted(directives)}: ` : ""}the wrapper's directives are ` +
    '"_undeclared" and, on a top-level section, "_layering", and nothing else - there are no ' +
    "private-note keys. Remove the key, or keep the note as a YAML comment";
  return renamed === undefined
    ? `${agree(issue.keys.length, "Unrecognized key", "Unrecognized keys")}: ${quoted(issue.keys)}; ${clause}`
    : `${renamed}; ${clause}`;
}

/**
 * loosen() (../contract/module.ts) recognizes this union and rewraps it with the routed check that keeps
 * per-entry issue paths. The wrapper's definition name derives from the entry's own .meta({id}), so the
 * document composition and a section's runtime derivation can never label one entry differently.
 *
 *   entry without an id                        -> throws at MODULE LOAD, not typecheck
 *   z.toJSONSchema(SettingsFile)               -> fine: it resolves metadata by schema identity
 *   a generator over z.globalRegistry's ids    -> sees only the last-registered wrapper (each call mints a fresh one under the same id)
 */
function knobbedList<T extends z.ZodType, S extends z.core.$ZodShape>(
  entry: T,
  shape: (knobs: {
    _undeclared: z.ZodOptional<typeof UndeclaredPolicySchema>;
    entries: z.ZodArray<T>;
  }) => S,
) {
  const entryName = z.globalRegistry.get(entry)?.id;
  if (entryName === undefined) {
    throw new Error(
      "knobbed(): the entry schema carries no .meta({id}) name to derive the wrapper's definition name from; give the entry config a .meta({id})",
    );
  }
  const wrapper = z
    .strictObject(
      shape({ _undeclared: UndeclaredPolicySchema.optional(), entries: z.array(entry) }),
      { error: wrapperKeyError },
    )
    .meta({ id: `UndeclaredPolicyList<${entryName}>` });
  return z.union([z.array(entry), wrapper]);
}

/**
 * Only a TOP-LEVEL wrapper takes `_layering`: the layered merge combines sections, so only a
 * section-level wrapper has layers below it to address.
 */
export function knobbed<T extends z.ZodType>(entry: T) {
  return knobbedList(entry, (knobs) => ({ ...knobs, _layering: LayeringSchema.optional() }));
}

/**
 * A nested list (environments[].variables) is replaced wholesale by a higher layer, so `_layering`
 * would be accepted and never act; the wrapper rejects it.
 */
export function nestedKnobbed<T extends z.ZodType>(entry: T) {
  return knobbedList(entry, (knobs) => knobs);
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
 * GitHub measures a value in bytes, so the refinement encodes the string as UTF-8 and compares that size. JSON Schema's
 * maxLength counts code points and cannot say bytes; a code point is at least one byte, so the same number is the
 * tightest bound an editor can check without refusing a value GitHub accepts.
 */
function utf8BoundedString(maximumBytes: number, message: (bytes: number) => string) {
  const utf8 = new TextEncoder();
  const byteLength = (value: string) => utf8.encode(value).byteLength;
  return z
    .string()
    .refine((value) => byteLength(value) <= maximumBytes, {
      error: (issue: z.core.$ZodRawIssue) => message(byteLength(issue.input as string)),
    })
    .meta({ maxLength: maximumBytes });
}

/** GitHub's documented cap on one variable's value, 48 KB, counted in UTF-8 bytes as GitHub does. */
export const MAX_VARIABLE_VALUE_BYTES = 48 * 1024;

const variableValue = utf8BoundedString(
  MAX_VARIABLE_VALUE_BYTES,
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
