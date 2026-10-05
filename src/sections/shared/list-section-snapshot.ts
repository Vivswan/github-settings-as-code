import { ok, Result, safeTry } from "neverthrow";
import { snapshotSecretReference } from "../../engine/secrets.js";
import type { UndeclaredPolicyList } from "../../types.js";
import type { SectionFailure } from "../contract/errors.js";
import { liveByIdentity, liveIdentity } from "../contract/live.js";
import type { SectionMeta } from "../contract/module.js";
import type { PlanContext } from "../contract/plan.js";
import type { ErasedDecl, ListEndpoints, ListSectionKey } from "./list-section-decl.js";
import { readItem, readLive } from "./list-section-reads.js";
import {
  declaredSecrets,
  type Fields,
  leafOf,
  nameOf,
  pathOf,
  withValueAt,
} from "./list-section-write.js";
import {
  knobbedSnapshot,
  leftOutOfSnapshot,
  projectOntoSchema,
  unreadableSecretNote,
} from "./snapshot-helpers.js";

/**
 * Items are normalized as GitHub stores them before the projection onto the entry slice, so the
 * read-back compares equal to the declaration that produced it. An item a concealed field hides from
 * the token is left out (an entry without the field would clear it on the next update), and a secret
 * field reads back as a `$NAME` reference keyed by the item's address, so a reordering never rebinds it.
 */
export async function snapshotList(
  decl: ErasedDecl<string>,
  section: SectionMeta<ListSectionKey>,
  ctx: PlanContext<ListEndpoints>,
): Promise<
  Result<{ value: UndeclaredPolicyList<object> | undefined; notes: string[] }, SectionFailure>
> {
  return safeTry(async function* () {
    const { key, noun, identity, lens } = decl;
    const live = yield* readLive(decl, ctx);
    const notes = live.foreign.map(({ name, reason }) =>
      leftOutOfSnapshot(`${key}[${name}]`, reason),
    );
    if (live.managed.length === 0) {
      return ok({ value: undefined, notes });
    }
    const items = yield* Result.combine(
      live.managed.map((item) =>
        lens.fromLive(item).map((comparable) => {
          const name = nameOf(comparable, identity.field);
          return { item, name, key: identity.fold(name) };
        }),
      ),
    );
    yield* liveByIdentity(
      section,
      noun,
      items,
      (item) => item.key,
      (item) => liveIdentity(item.name, decl.address(item.item)),
    );
    const entries: object[] = [];
    for (const { item, name } of items) {
      const label = `${key}[${name}]`;
      const body = yield* await readItem(decl, ctx, item);
      const hidden = decl.concealed?.(body) ?? [];
      if (hidden.length > 0) {
        for (const { field, reason, remedy } of hidden) {
          notes.push(
            leftOutOfSnapshot(
              label,
              `${field} is not visible to this token (${reason}), and an entry without it would clear it on the next update; ${remedy} to read it back`,
            ),
          );
        }
        continue;
      }
      let entry = projectOntoSchema(decl.entry, yield* lens.fromLive(body)) as Fields;
      for (const field of declaredSecrets(decl, entry)) {
        const id = Object.values(decl.address(item)).join("_");
        const { variable, reference } = snapshotSecretReference(noun, id);
        notes.push(
          unreadableSecretNote(`${label}.${field}`, `the ${noun} ${leafOf(field)}`, variable),
        );
        entry = withValueAt(entry, pathOf(field), reference);
      }
      entries.push(entry);
    }
    return ok({ value: knobbedSnapshot(section, entries), notes });
  });
}
