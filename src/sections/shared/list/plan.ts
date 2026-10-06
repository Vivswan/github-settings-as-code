/**
 * The plan's operations are ordered: the undeclared deletes first, in live order, then one group per
 * declared entry in file order (a recreate is its delete then its create; a mapping's updateConfig
 * precedes the general update). Execution follows the plan, so a delete has freed a name or prefix
 * before the create that needs it is sent.
 */

import { err, ok, Result, safeTry } from "neverthrow";
import {
  type Delta,
  deltas,
  omittedDeltas,
  phantomNote,
  phantomPaths,
  refuseOmitted,
} from "../../../engine/diff.js";
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
  type PlanContext,
  plainData,
  type SectionPlan,
} from "../../contract/plan.js";
import { projectOntoSchema, replaceSweep } from "../snapshot-helpers.js";
import {
  type ErasedDecl,
  type ErasedDeclared,
  type ListComparable,
  type ListEndpoints,
  type ListSectionKey,
  type ListWrite,
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

/** A live item with the comparison it takes part in, less what neither side can show. */
interface Comparison {
  readonly write: Fields;
  readonly live: Fields;
  readonly notes: string[];
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

export async function planList<Key extends string>(
  decl: ErasedDecl<Key>,
  section: SectionMeta<ListSectionKey>,
  ctx: PlanContext<ListEndpoints>,
  declared: ErasedDeclared,
): Promise<Result<SectionPlan, SectionFailure>> {
  return safeTry(async function* () {
    const { key, noun, identity, lens, prose, endpoints, mapping } = decl;
    const { fold } = identity;
    const wire = lens.wire ?? ((write: ListWrite<string>) => write);
    const update = updateRole(endpoints);
    const remedies = update === undefined ? RECREATE_REMEDIES : UPDATE_REMEDIES;
    const sweep = decl.replaces ? replaceSweep(decl.entry) : undefined;
    const defaultPolicy = defaultUndeclaredPolicy(section);
    const { policy, entries } = undeclaredPolicy(declared, defaultPolicy);

    // Every identity an entry claims is its alone: validateList refused the document otherwise.
    const writes = entries.map((entry) => {
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

    const live = yield* readLive(decl, ctx);
    const liveItems = yield* Result.combine(
      live.managed.map((item) =>
        lens.fromLive(item).map((comparable) => {
          const name = nameOf(comparable, identity.field);
          return { item, comparable, name, key: fold(name) };
        }),
      ),
    );
    // The guard runs before the section's own live conflicts: a duplicated live pair makes every other judgment a guess.
    const liveByKey = yield* liveByIdentity(
      section,
      noun,
      liveItems,
      (item) => item.key,
      (item) => liveIdentity(item.name, decl.address(item.item)),
    );
    const liveConflicts =
      decl.conflicts?.live?.(
        writes.map((w) => w.write),
        liveItems.map((l) => l.comparable),
      ) ?? [];
    if (liveConflicts.length > 0) {
      return err(
        sectionFailure(
          "refused",
          `${key}: the settings file conflicts with the live ${plural(noun)}: ${liveConflicts.join("; ")}. Resolve each conflict on GitHub, then re-run`,
        ),
      );
    }
    const claimed = new Set<Key>(writes.flatMap((w) => w.claims));
    const undeclared = liveItems.filter((live) => !claimed.has(live.key));

    const plan: SectionPlan = { ops: [], notes: [], drift: [] };
    // The undeclared deletes come first, in live order: a delete frees what a create below would collide
    // with (an autolink prefix that begins a declared one); the declared entries follow in file order.
    if (policy === "delete") {
      for (const { item, name } of undeclared) {
        plan.ops.push({
          role: "remove",
          params: decl.address(item),
          describe: `deleting undeclared ${noun} "${name}"`,
          drift: [
            undeclaredDrift(defaultPolicy, {
              label: `${key}[${name}]`,
              action: prose.undeclaredAction,
              ...prose.undeclaredDrift,
            }),
          ],
          change: `DELETED undeclared ${noun} "${name}"`,
        });
      }
    }
    for (const { write, name, claims } of writes) {
      const matches = claims.flatMap((claim) => {
        const match = liveByKey.get(claim);
        return match === undefined ? [] : [match];
      });
      if (matches.length > 1) {
        return err(
          sectionFailure(
            "refused",
            `${key}: the entry "${name}" matches ${matches.length} separate live ${plural(noun)} (${matches.map((m) => `"${m.name}"`).join(", ")}), so it cannot converge; delete all but one of them on GitHub, or declare each as its own entry`,
          ),
        );
      }
      const existing = matches[0];
      const label = `${key}[${name}]`;
      const secrets = declaredSecrets(decl, write);
      const wired = wire(write);
      if (existing === undefined) {
        plan.ops.push({
          role: "create",
          payload:
            secrets.length === 0
              ? plainData(wired)
              : (exec: ExecTools) => resolvedWrite(exec, wired, secrets),
          describe: `creating ${noun} "${name}"`,
          drift: facetOr(secrets.length === 0 ? null : secretFacet(decl, label, secrets), [
            missingDrift(label),
          ]),
          change: `created ${noun} "${name}"`,
        });
        continue;
      }
      const body = yield* await readItem(decl, ctx, existing.item);
      const compared = comparison(decl, label, write, body, yield* lens.fromLive(body));
      plan.notes.push(...compared.notes);
      const found = [
        ...deltas(compared.write, compared.live, { matchBy: lens.matchBy }),
        ...(sweep === undefined
          ? []
          : omittedDeltas(compared.write, projectOntoSchema(decl.entry, compared.live), {
              matchBy: lens.matchBy,
              sweep,
            })),
      ];
      const render = (delta: Delta): string =>
        renderEntryDelta(key, identity.field, { want: name, live: existing.name }, delta, remedies);
      const phantom = phantomPaths(found);
      if (phantom.length > 0) {
        plan.notes.push(phantomNote(label, phantom, noun, remedies.phantom));
      }
      if (update === undefined) {
        const drift = found.map(render);
        if (!hasDrift(drift)) {
          continue;
        }
        // The differing fields ride on the recreate; the generic line alone would leave the reader guessing which field forces the replace.
        plan.ops.push(
          {
            role: "remove",
            params: decl.address(existing.item),
            describe: `deleting ${noun} "${name}" before recreating it`,
            drift: [
              `${label}: live settings differ from the settings file, and ${plural(noun)} cannot be edited; apply will delete and recreate it`,
            ],
            change: `deleted ${noun} "${name}" to recreate it with the declared settings`,
          },
          {
            role: "create",
            payload: plainData(wire(decl.recreate?.(existing.item, write) ?? write)),
            describe: `recreating ${noun} "${name}"`,
            drift,
            change: `recreated ${noun} "${name}"`,
          },
        );
        continue;
      }
      const params = decl.address(existing.item);
      // The mapping's deltas go through updateConfig, which sets named fields only; the general update never carries the mapping.
      const inMapping = (field: string): boolean =>
        mapping !== undefined && pathOf(field)[0] === mapping;
      const mappingDrift = found
        .filter((delta) => mapping !== undefined && delta.path[0] === mapping)
        .map(render);
      const mappingSecrets = secrets.filter(inMapping);
      if (mapping !== undefined && (hasDrift(mappingDrift) || mappingSecrets.length > 0)) {
        const config = wired[mapping] as ListWrite<string>;
        plan.ops.push({
          role: "updateConfig",
          params,
          payload:
            mappingSecrets.length === 0
              ? plainData(config)
              : (exec: ExecTools) =>
                  resolvedWrite(
                    exec,
                    config,
                    mappingSecrets.map((field) => pathOf(field).slice(1).join(".")),
                  ),
          describe: `updating ${noun} "${name}" ${mapping}`,
          drift: facetOr(
            mappingSecrets.length === 0 ? null : secretFacet(decl, label, mappingSecrets),
            mappingDrift,
          ),
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
      if (!hasDrift(generalDrift) && generalSecrets.length === 0) {
        continue;
      }
      const general =
        mapping === undefined ? (wired as Fields) : withoutPaths(wired as Fields, [mapping]);
      plan.ops.push({
        role: "update",
        params,
        payload:
          generalSecrets.length === 0
            ? plainData(updateBody(decl, general))
            : (exec: ExecTools) =>
                resolvedWrite(exec, updateBody(decl, general) as ListWrite<string>, generalSecrets),
        before: refuseOmitted(
          label,
          found.flatMap((delta) => (delta.kind === "omitted" ? [render(delta)] : [])),
        ),
        describe: `updating ${noun} "${name}"`,
        drift: facetOr(
          generalSecrets.length === 0 ? null : secretFacet(decl, label, generalSecrets),
          generalDrift,
        ),
        change: `updated ${noun} "${name}"`,
      });
    }

    if (policy === "keep") {
      for (const { name } of undeclared) {
        plan.notes.push(
          undeclaredNote({
            subject: `${noun} "${name}"`,
            action: prose.undeclaredAction,
            ...prose.undeclaredNote,
          }),
        );
      }
    }
    return ok(plan);
  });
}
