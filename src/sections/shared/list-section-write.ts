import { ok, type Result } from "neverthrow";
import { type Delta, renderDelta } from "../../engine/diff.js";
import type { SectionFailure } from "../contract/errors.js";
import { cannotVerifyNote, valueDrift } from "../contract/module.js";
import { type ExecTools, type PlainData, plainData, type Unverifiable } from "../contract/plan.js";
import type { ErasedDecl } from "./list-section-decl.js";

/** A write or comparable seen as plain fields. */
export type Fields = Readonly<Record<string, unknown>>;

/** A recreate names its remedy once on the generic line, so its field lines carry none. */
interface Remedies {
  readonly value: string | null;
  readonly rename: string;
  readonly phantom: string;
}

export const UPDATE_REMEDIES: Remedies = {
  value: "apply will set the declared value",
  rename: "apply will rename it",
  phantom: "this update will re-run",
};

export const RECREATE_REMEDIES: Remedies = {
  value: null,
  rename: "apply will delete and recreate it",
  phantom: "this delete-and-recreate will repeat",
};

// --- Dotted paths into a write ----------------------------------------------

export function pathOf(field: string): string[] {
  return field.split(".");
}

/** The own value at `path`; undefined once a step is missing, so a null the author wrote reads as null, not as absent. */
export function valueAt(record: unknown, path: readonly PropertyKey[]): unknown {
  let node: unknown = record;
  for (const step of path) {
    if (typeof node !== "object" || node === null || !Object.hasOwn(node, step)) {
      return undefined;
    }
    node = (node as Record<PropertyKey, unknown>)[step];
  }
  return node;
}

/** A copy with the value at `path` replaced (present) or removed (undefined); a missing parent is left alone. */
export function withValueAt<T extends Fields>(
  record: T,
  path: readonly string[],
  value: unknown,
): T {
  const [step, ...rest] = path;
  if (step === undefined || !Object.hasOwn(record, step)) {
    return record;
  }
  if (rest.length === 0) {
    const { [step]: _replaced, ...others } = record;
    return (value === undefined ? others : { ...others, [step]: value }) as T;
  }
  const child = record[step];
  if (typeof child !== "object" || child === null || Array.isArray(child)) {
    return record;
  }
  return { ...record, [step]: withValueAt(child as Fields, rest, value) };
}

export function withoutPaths<T extends Fields>(record: T, paths: readonly string[]): T {
  return paths.reduce((out, field) => withValueAt(out, pathOf(field), undefined), record);
}

// --- Identity ---------------------------------------------------------------

/** One identity an entry claims, with the entry field it was read from (the issue path of a collision). */
interface IdentityClaim<Key extends string> {
  readonly key: Key;
  readonly name: string;
  readonly field: string;
}

/**
 * The ONE derivation behind the duplicate check and the layered merge's pairing. Total over raw records
 * because the merge reads layers before validation: null when a claimed name is not a string, which the
 * merge refuses and a validated entry never is. A rename claims the written name under `renameKey`; an
 * alias (the pre-rename name) is read from `field`.
 */
export function identityClaimSites<Key extends string>(
  identity: ErasedDecl<Key>["identity"],
  entry: Fields,
): readonly IdentityClaim<Key>[] | null {
  const { field, renameKey, fold } = identity;
  const written = renameKey === undefined ? undefined : entry[renameKey];
  const sites: { name: unknown; field: string }[] = [
    written === undefined
      ? { name: valueAt(entry, pathOf(field)), field }
      : { name: written, field: renameKey as string },
    ...(identity.aliases?.(entry) ?? []).map((name) => ({ name, field })),
  ];
  if (
    !sites.every((site): site is { name: string; field: string } => typeof site.name === "string")
  ) {
    return null;
  }
  const seen = new Set<Key>();
  return sites.flatMap((site) => {
    const key = fold(site.name);
    if (seen.has(key)) {
      return [];
    }
    seen.add(key);
    return [{ key, name: site.name, field: site.field }];
  });
}

export function identityClaims<Key extends string>(
  identity: ErasedDecl<Key>["identity"],
  entry: Fields,
): readonly Key[] | null {
  return identityClaimSites(identity, entry)?.map((claim) => claim.key) ?? null;
}

/** The erased view lost the declaration's string typing, so the check happens once here. */
export function nameOf(record: Fields, field: string): string {
  const value = valueAt(record, pathOf(field));
  if (typeof value !== "string") {
    throw new Error(
      `BUG: the identity field "${field}" is not a string in ${JSON.stringify(record)}; the lens must carry it verbatim`,
    );
  }
  return value;
}

// --- Secret fields ----------------------------------------------------------

/** The secret paths of `decl` a write declares (holds a string at). */
export function declaredSecrets(decl: ErasedDecl<string>, write: Fields): string[] {
  return (decl.secrets ?? []).filter((field) => typeof valueAt(write, pathOf(field)) === "string");
}

/** The write with every declared secret reference resolved, for the request body. */
export function resolvedWrite(
  exec: ExecTools,
  write: Fields,
  fields: readonly string[],
): Result<PlainData, SectionFailure> {
  const resolved = fields.reduce(
    (out: Fields, field) =>
      withValueAt(out, pathOf(field), exec.resolveSecret(String(valueAt(out, pathOf(field))))),
    write as Fields,
  );
  return ok(plainData(resolved));
}

export function leafOf(field: string): string {
  const path = pathOf(field);
  return path[path.length - 1] ?? field;
}

/** The unverifiable facet an op re-sending secret fields carries, one clause per field. */
export function secretFacet(
  decl: ErasedDecl<string>,
  label: string,
  fields: readonly string[],
): string {
  return fields
    .map((field) =>
      cannotVerifyNote(`${label}.${field}`, {
        why: `GitHub never reveals a ${decl.noun} ${leafOf(field)}`,
        what: "the declared value",
        reasserts: "re-sends it",
      }),
    )
    .join("; ");
}

export function facetOr(
  facet: string | null,
  lines: readonly string[],
): Unverifiable | readonly string[] {
  return facet === null ? lines : { unverifiable: facet, lines };
}

// --- Rendering --------------------------------------------------------------

export function renderEntryDelta(
  sectionKey: string,
  field: string,
  names: { readonly want: string; readonly live: string },
  delta: Delta,
  remedies: Remedies,
): string {
  const label = `${sectionKey}[${names.want}]`;
  const path = pathOf(field);
  if (
    delta.kind === "mismatch" &&
    delta.path.length === path.length &&
    delta.path.every((step, index) => step === path[index])
  ) {
    return `${sectionKey}[${names.live}]: should be named "${names.want}" per the settings file; ${remedies.rename}`;
  }
  if (
    delta.kind === "mismatch" &&
    delta.path.length > 0 &&
    delta.path.every((step) => typeof step === "string") &&
    (typeof delta.desired !== "object" || delta.desired === null)
  ) {
    return valueDrift(
      `${label}.${delta.path.join(".")}`,
      JSON.stringify(delta.desired),
      JSON.stringify(delta.live),
      { remedy: remedies.value },
    );
  }
  return renderDelta(label, delta);
}

export function updateBody(decl: ErasedDecl<string>, write: Fields): Fields {
  const { renameKey, field } = decl.identity;
  if (renameKey === undefined) {
    return write;
  }
  const { [field]: _name, ...rest } = write;
  return { [renameKey]: nameOf(write, field), ...rest };
}
