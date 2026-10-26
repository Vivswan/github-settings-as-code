/**
 * The plan's operations are ordered: the undeclared deletes first, in live order, then one group per
 * declared entry in file order (a recreate is its delete then its create; a mapping's updateConfig
 * precedes the general update). Execution follows the plan, so a delete has freed a name or prefix
 * before the create that needs it is sent.
 */

import { err, ok, Result, type ResultAsync } from "neverthrow";
import {
  type Delta,
  deltas,
  omittedDeltas,
  phantomNote,
  phantomPaths,
  type ReplaceSweep,
  refuseOmitted,
} from "../../../engine/diff.js";
import type { UndeclaredPolicy } from "../../../types.js";
import { type DeclaredIssue, declaredEntries, duplicateIssues } from "../../contract/declared.js";
import {
  missingDrift,
  undeclaredDrift,
  undeclaredNote,
  undeclaredPolicy,
} from "../../contract/drift.js";
import { type SectionFailure, sectionFailure } from "../../contract/errors.js";
import { liveByIdentity, liveIdentity, plural } from "../../contract/live.js";
import { defaultUndeclaredPolicy, type SectionMeta } from "../../contract/module.js";
import {
  type ExecTools,
  hasDrift,
  type Late,
  type PlainData,
  type PlanContext,
  plainData,
  type SectionPlan,
  type Unverifiable,
} from "../../contract/plan.js";
import { projectOntoSchema, replaceSweep } from "../snapshot-helpers.js";
import {
  type ErasedDecl,
  type ErasedDeclared,
  type ListComparable,
  type ListEndpoints,
  type ListSectionKey,
  type ListWrite,
  type UpdateDecl,
  updateRole,
} from "./decl.js";
import { readItem, readLive } from "./reads.js";
import {
  declaredSecrets,
  type Fields,
  facetOr,
  identityClaimSites,
  identityClaims,
  leafOf,
  nameOf,
  pathOf,
  RECREATE_REMEDIES,
  renderEntryDelta,
  resolvedWrite,
  secretFacet,
  UPDATE_REMEDIES,
  updateBody,
  valueAt,
  withoutPaths,
} from "./write.js";

type Op = SectionPlan["ops"][number];

/** One declared entry's write with the identities it claims; each claim is its alone, since validateList refused the document otherwise. */
interface DeclaredWrite<Key extends string> {
  readonly write: ListWrite<string>;
  readonly name: string;
  readonly claims: readonly Key[];
}

/** One live item beside its comparable form, keyed as the planner looks it up. */
interface LiveItem<Key extends string> {
  readonly item: object;
  readonly comparable: ListComparable<string>;
  readonly name: string;
  readonly key: Key;
}

/** What every step of one plan shares, resolved once from the declaration and the section. */
interface Planning<Key extends string> {
  readonly decl: ErasedDecl<Key>;
  readonly wire: (write: ListWrite<string>) => ListWrite<string>;
  readonly update: UpdateDecl | undefined;
  readonly remedies: typeof UPDATE_REMEDIES;
  readonly sweep: ReplaceSweep | undefined;
  readonly policy: UndeclaredPolicy;
  readonly defaultPolicy: UndeclaredPolicy;
}

/** A live item with the comparison it takes part in, less what neither side can show. */
interface Comparison {
  readonly write: Fields;
  readonly live: Fields;
  readonly notes: string[];
}

/** The deltas between a declared entry and its live item, rendered by the entry's remedies, with the notes the compare raised. */
interface Compared {
  readonly found: readonly Delta[];
  readonly render: (delta: Delta) => string;
  readonly notes: string[];
}

/** The ops and notes one declared entry contributes, in the order the plan carries them. */
interface EntryGroup {
  readonly ops: readonly Op[];
  readonly notes: readonly string[];
}

function comparison(
  decl: ErasedDecl<string>,
  label: string,
  write: ListWrite<string>,
  body: object,
  comparable: ListComparable<string>,
): Comparison {
  const notes: string[] = [];
  const hidden = (decl.concealed?.(body) ?? []).filter(
    (field) => valueAt(write, pathOf(field.field)) !== undefined,
  );
  for (const { field, reason, remedy } of hidden) {
    notes.push(
      `${label}: ${field} is not visible to this token (${reason}), so drift on it cannot be judged here; ${remedy} to check it`,
    );
  }
  const dropped = [...(decl.secrets ?? []), ...hidden.map((field) => field.field)];
  return {
    write: withoutPaths(write as Fields, dropped),
    live: withoutPaths(comparable as Fields, dropped),
    notes,
  };
}

/**
 * The list's file-only checks, in the order a reader fixes them: two entries claiming one identity (a rename target
 * and a current name included) would fight on every run; the declaration's own entry checks; then the declared
 * conflicts over the writes, which run only over entries the entry checks passed (toWrite treats a failed one as a BUG).
 */
export function validateList<Key extends string>(
  decl: ErasedDecl<Key>,
  declared: ErasedDeclared,
): DeclaredIssue[] {
  const { identity, lens, noun } = decl;
  const { entries, path } = declaredEntries(declared);
  const under = (issue: DeclaredIssue): DeclaredIssue => ({
    ...issue,
    path: `${path}${issue.path}`,
  });
  const claims = entries.flatMap((entry, index) =>
    (identityClaimSites(identity, entry as Fields) ?? []).map((claim) => ({ ...claim, index })),
  );
  const issues = duplicateIssues(
    claims,
    {
      keyOf: (claim) => claim.key,
      describe: (claim) => claim.name,
      at: (claim) => `[${claim.index}].${claim.field}`,
    },
    noun,
  );
  const entryIssues = decl.validate?.(entries) ?? [];
  issues.push(...entryIssues);
  if (entryIssues.length === 0) {
    issues.push(...(decl.conflicts?.declared?.(entries.map((entry) => lens.toWrite(entry))) ?? []));
  }
  return issues.map(under);
}

/** Every entry's write with its claims; the validated document types the identity fields as strings, so a non-string name is a BUG. */
function declaredWrites<Key extends string>(
  decl: ErasedDecl<Key>,
  entries: readonly object[],
): DeclaredWrite<Key>[] {
  const { identity, lens, noun } = decl;
  return entries.map((entry) => {
    const write = lens.toWrite(entry);
    const name = nameOf(write, identity.field);
    const claims = identityClaims(identity, entry as Fields);
    if (claims === null) {
      throw new Error(
        `BUG: the validated ${noun} entry ${JSON.stringify(entry)} claims a non-string name; the slice must type the identity fields as strings`,
      );
    }
    return { write, name, claims };
  });
}

/**
 * The managed live items in comparable form, indexed by key. The duplicate-live guard runs before the section's own
 * live conflicts: a duplicated live pair makes every other judgment a guess.
 */
function indexedLive<Key extends string>(
  decl: ErasedDecl<Key>,
  section: SectionMeta<ListSectionKey>,
  ctx: PlanContext<ListEndpoints>,
): ResultAsync<{ byKey: Map<Key, LiveItem<Key>>; items: LiveItem<Key>[] }, SectionFailure> {
  const { identity, lens, noun } = decl;
  return readLive(decl, ctx).andThen((live) =>
    Result.combine(
      live.managed.map((item) =>
        lens.fromLive(item).map((comparable): LiveItem<Key> => {
          const name = nameOf(comparable, identity.field);
          return { item, comparable, name, key: identity.fold(name) };
        }),
      ),
    ).andThen((items) =>
      liveByIdentity(
        section,
        noun,
        items,
        (live) => live.key,
        (live) => liveIdentity(live.name, decl.address(live.item)),
      ).map((byKey) => ({ byKey, items })),
    ),
  );
}

/** The section's own live conflicts as the refusal that ends the plan, or undefined when there are none. */
function liveConflictRefusal<Key extends string>(
  decl: ErasedDecl<Key>,
  writes: readonly DeclaredWrite<Key>[],
  items: readonly LiveItem<Key>[],
): SectionFailure | undefined {
  const conflicts =
    decl.conflicts?.live?.(
      writes.map((entry) => entry.write),
      items.map((live) => live.comparable),
    ) ?? [];
  if (conflicts.length === 0) {
    return undefined;
  }
  return sectionFailure(
    "refused",
    `${decl.key}: the settings file conflicts with the live ${plural(decl.noun)}: ${conflicts.join("; ")}. Resolve each conflict on GitHub, then re-run`,
  );
}

/**
 * The undeclared deletes, in live order, under a delete policy: a delete frees what a create below would collide
 * with (an autolink prefix that begins a declared one). None under keep.
 */
function undeclaredRemovals<Key extends string>(
  planning: Planning<Key>,
  undeclared: readonly LiveItem<Key>[],
): Op[] {
  const { decl, policy, defaultPolicy } = planning;
  if (policy !== "delete") {
    return [];
  }
  return undeclared.map(({ item, name }) => ({
    role: "remove",
    params: decl.address(item),
    describe: `deleting undeclared ${decl.noun} "${name}"`,
    drift: [
      undeclaredDrift(defaultPolicy, {
        label: `${decl.key}[${name}]`,
        action: decl.prose.undeclaredAction,
        ...decl.prose.undeclaredDrift,
      }),
    ],
    change: `DELETED undeclared ${decl.noun} "${name}"`,
  }));
}

/** The keep-notes for the undeclared items under a keep policy; none under delete. */
function undeclaredKeepNotes<Key extends string>(
  planning: Planning<Key>,
  undeclared: readonly LiveItem<Key>[],
): string[] {
  const { decl, policy } = planning;
  if (policy !== "keep") {
    return [];
  }
  return undeclared.map(({ name }) =>
    undeclaredNote({
      subject: `${decl.noun} "${name}"`,
      action: decl.prose.undeclaredAction,
      ...decl.prose.undeclaredNote,
    }),
  );
}

/** The one live item an entry's claims match, or none; two (a rename onto a taken name) are the refusal that ends the plan. */
function matchedLive<Key extends string>(
  decl: ErasedDecl<Key>,
  entry: DeclaredWrite<Key>,
  liveByKey: ReadonlyMap<Key, LiveItem<Key>>,
): Result<LiveItem<Key> | undefined, SectionFailure> {
  const matches = entry.claims.flatMap((claim) => {
    const match = liveByKey.get(claim);
    return match === undefined ? [] : [match];
  });
  if (matches.length > 1) {
    return err(
      sectionFailure(
        "refused",
        `${decl.key}: the entry "${entry.name}" matches ${matches.length} separate live ${plural(decl.noun)} (${matches.map((m) => `"${m.name}"`).join(", ")}), so it cannot converge; delete all but one of them on GitHub, or declare each as its own entry`,
      ),
    );
  }
  return ok(matches[0]);
}

/** A body as the plan carries it: plain when no secret rides on it, else a thunk resolving the secrets at execution. */
function bodyOf(body: Fields, secrets: readonly string[]): PlainData | Late<PlainData> {
  if (secrets.length === 0) {
    return plainData(body);
  }
  return (exec: ExecTools) => resolvedWrite(exec, body, secrets);
}

/** The drift slot: the lines alone, or under the unverifiable facet when a secret rides on the write. */
function facetDrift(
  decl: ErasedDecl<string>,
  label: string,
  secrets: readonly string[],
  lines: readonly string[],
): Unverifiable | readonly string[] {
  return facetOr(secrets.length === 0 ? null : secretFacet(decl, label, secrets), lines);
}

/** The create of an entry no live item matches. */
function createOp<Key extends string>(
  planning: Planning<Key>,
  entry: DeclaredWrite<Key>,
  label: string,
): Op {
  const { decl, wire } = planning;
  const { write, name } = entry;
  const secrets = declaredSecrets(decl, write);
  const wired = wire(write);
  return {
    role: "create",
    payload: bodyOf(wired, secrets),
    describe: `creating ${decl.noun} "${name}"`,
    drift: facetDrift(decl, label, secrets, [missingDrift(label)]),
    change: `created ${decl.noun} "${name}"`,
  };
}

/**
 * The entry compared with its live item: the item's full body read where a `get` role exists, concealed fields and
 * secrets left out, and the omitted-key sweep of a replace write. The phantom note follows the concealment notes.
 */
async function compareWithLive<Key extends string>(
  planning: Planning<Key>,
  ctx: PlanContext<ListEndpoints>,
  entry: DeclaredWrite<Key>,
  existing: LiveItem<Key>,
  label: string,
): Promise<Result<Compared, SectionFailure>> {
  const { decl, sweep, remedies } = planning;
  const { lens, identity } = decl;
  const body = await readItem(decl, ctx, existing.item);
  if (body.isErr()) {
    return err(body.error);
  }
  const comparable = lens.fromLive(body.value);
  if (comparable.isErr()) {
    return err(comparable.error);
  }
  const compared = comparison(decl, label, entry.write, body.value, comparable.value);
  const found = deltas(compared.write, compared.live, { matchBy: lens.matchBy });
  if (sweep !== undefined) {
    found.push(
      ...omittedDeltas(compared.write, projectOntoSchema(decl.entry, compared.live), {
        matchBy: lens.matchBy,
        sweep,
      }),
    );
  }
  const render = (delta: Delta): string =>
    renderEntryDelta(
      decl.key,
      identity.field,
      { want: entry.name, live: existing.name },
      delta,
      remedies,
    );
  const notes = [...compared.notes];
  const phantom = phantomPaths(found);
  if (phantom.length > 0) {
    notes.push(phantomNote(label, phantom, decl.noun, remedies.phantom));
  }
  return ok({ found, render, notes });
}

/**
 * The delete-then-create replacing a drifted item of a resource GitHub cannot edit; none when nothing drifted. The
 * differing fields ride on the recreate, since the generic line alone would leave the reader guessing which field
 * forces the replace.
 */
function recreateOps<Key extends string>(
  planning: Planning<Key>,
  entry: DeclaredWrite<Key>,
  existing: LiveItem<Key>,
  drift: readonly string[],
  label: string,
): Op[] {
  const { decl, wire } = planning;
  const { write, name } = entry;
  if (!hasDrift(drift)) {
    return [];
  }
  return [
    {
      role: "remove",
      params: decl.address(existing.item),
      describe: `deleting ${decl.noun} "${name}" before recreating it`,
      drift: [
        `${label}: live settings differ from the settings file, and ${plural(decl.noun)} cannot be edited; apply will delete and recreate it`,
      ],
      change: `deleted ${decl.noun} "${name}" to recreate it with the declared settings`,
    },
    {
      role: "create",
      payload: plainData(wire(decl.recreate?.(existing.item, write) ?? write)),
      describe: `recreating ${decl.noun} "${name}"`,
      drift,
      change: `recreated ${decl.noun} "${name}"`,
    },
  ];
}

/**
 * The update of a drifted item: the mapping's deltas and secrets through updateConfig, which sets named fields only,
 * and everything else through the general update, which never carries the mapping. Each op is absent when it has
 * nothing to send.
 */
function updateOps<Key extends string>(
  planning: Planning<Key>,
  entry: DeclaredWrite<Key>,
  existing: LiveItem<Key>,
  compared: Compared,
  label: string,
): Op[] {
  const { decl, wire } = planning;
  const { mapping, noun } = decl;
  const { found, render } = compared;
  const { write, name } = entry;
  const secrets = declaredSecrets(decl, write);
  const wired = wire(write);
  const params = decl.address(existing.item);
  const inMapping = (field: string): boolean =>
    mapping !== undefined && pathOf(field)[0] === mapping;
  const ops: Op[] = [];

  const mappingDrift = found
    .filter((delta) => mapping !== undefined && delta.path[0] === mapping)
    .map(render);
  const mappingSecrets = secrets.filter(inMapping);
  if (mapping !== undefined && (hasDrift(mappingDrift) || mappingSecrets.length > 0)) {
    const config = wired[mapping] as ListWrite<string>;
    const relative = mappingSecrets.map((field) => pathOf(field).slice(1).join("."));
    ops.push({
      role: "updateConfig",
      params,
      payload: bodyOf(config, relative),
      describe: `updating ${noun} "${name}" ${mapping}`,
      drift: facetDrift(decl, label, mappingSecrets, mappingDrift),
      change:
        mappingSecrets.length === 0
          ? `updated ${noun} "${name}" ${mapping}`
          : `updated ${noun} "${name}" ${mapping} (the declared ${mappingSecrets.map(leafOf).join(" and ")} is re-sent every run)`,
    });
  }

  const generalDrift = found
    .filter((delta) => mapping === undefined || delta.path[0] !== mapping)
    .map(render);
  const generalSecrets = secrets.filter((field) => !inMapping(field));
  if (hasDrift(generalDrift) || generalSecrets.length > 0) {
    const general =
      mapping === undefined ? (wired as Fields) : withoutPaths(wired as Fields, [mapping]);
    ops.push({
      role: "update",
      params,
      payload: bodyOf(updateBody(decl, general), generalSecrets),
      before: refuseOmitted(
        label,
        found.flatMap((delta) => (delta.kind === "omitted" ? [render(delta)] : [])),
      ),
      describe: `updating ${noun} "${name}"`,
      drift: facetDrift(decl, label, generalSecrets, generalDrift),
      change: `updated ${noun} "${name}"`,
    });
  }
  return ops;
}

/** One declared entry's group: a create, a recreate pair, or the update ops, with the notes its compare raised. */
async function entryGroup<Key extends string>(
  planning: Planning<Key>,
  ctx: PlanContext<ListEndpoints>,
  entry: DeclaredWrite<Key>,
  liveByKey: ReadonlyMap<Key, LiveItem<Key>>,
): Promise<Result<EntryGroup, SectionFailure>> {
  const { decl, update } = planning;
  const label = `${decl.key}[${entry.name}]`;
  const matched = matchedLive(decl, entry, liveByKey);
  if (matched.isErr()) {
    return err(matched.error);
  }
  const existing = matched.value;
  if (existing === undefined) {
    return ok({ ops: [createOp(planning, entry, label)], notes: [] });
  }
  const compared = await compareWithLive(planning, ctx, entry, existing, label);
  if (compared.isErr()) {
    return err(compared.error);
  }
  const { found, render, notes } = compared.value;
  if (update === undefined) {
    return ok({ ops: recreateOps(planning, entry, existing, found.map(render), label), notes });
  }
  return ok({ ops: updateOps(planning, entry, existing, compared.value, label), notes });
}

export async function planList<Key extends string>(
  decl: ErasedDecl<Key>,
  section: SectionMeta<ListSectionKey>,
  ctx: PlanContext<ListEndpoints>,
  declared: ErasedDeclared,
): Promise<Result<SectionPlan, SectionFailure>> {
  const update = updateRole(decl.endpoints);
  const defaultPolicy = defaultUndeclaredPolicy(section);
  const { policy, entries } = undeclaredPolicy(declared, defaultPolicy);
  const planning: Planning<Key> = {
    decl,
    wire: decl.lens.wire ?? ((write: ListWrite<string>) => write),
    update,
    remedies: update === undefined ? RECREATE_REMEDIES : UPDATE_REMEDIES,
    sweep: decl.replaces ? replaceSweep(decl.entry) : undefined,
    policy,
    defaultPolicy,
  };
  const writes = declaredWrites(decl, entries);

  const live = await indexedLive(decl, section, ctx);
  if (live.isErr()) {
    return err(live.error);
  }
  const { byKey, items } = live.value;
  const refusal = liveConflictRefusal(decl, writes, items);
  if (refusal !== undefined) {
    return err(refusal);
  }
  const claimed = new Set<Key>(writes.flatMap((entry) => entry.claims));
  const undeclared = items.filter((item) => !claimed.has(item.key));

  const plan: SectionPlan = { ops: undeclaredRemovals(planning, undeclared), notes: [], drift: [] };
  for (const entry of writes) {
    const group = await entryGroup(planning, ctx, entry, byKey);
    if (group.isErr()) {
      return err(group.error);
    }
    plan.ops.push(...group.value.ops);
    plan.notes.push(...group.value.notes);
  }
  plan.notes.push(...undeclaredKeepNotes(planning, undeclared));
  return ok(plan);
}
