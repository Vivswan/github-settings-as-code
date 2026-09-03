/**
 * The mock fragment of a list section, derived from its declaration: the state transformers read
 * the identity, address, listing, and rename key the section plans with, so the mock cannot pair
 * or locate a resource differently. A section supplies only what the server owns.
 */

import {
  type ListEndpoints,
  type ListRoleName,
  type ListSectionKey,
  type ListSectionModule,
  updateRole,
} from "../../../src/sections/shared/list-section.js";
import type { MockState } from "./state.js";
import { asObject, type Handler, type Json, noContent, ok, slicePage } from "./support.js";

export interface ListMockSpec {
  /** The MockState collection the section's live list is served from. */
  readonly collection: (state: MockState) => Json[];
  /** GET-shape fields the server fills on create when the body omits them (a label's color, its null description). */
  readonly defaults: Json;
  /** The server-owned fields of one item (minted on create, re-applied after every update); a body can never set them. */
  readonly owned: (id: number, slug: string, item: Json) => Json;
  /**
   * What the server holds unique per repository, so a create repeating it answers GitHub's 422:
   * the folded identity field, or another key (deploy keys repeat titles but never material).
   */
  readonly unique: "identity" | ((item: Json) => string);
}

/** The roles a dictionary declares, which the derived fragment serves - no update handler without an update role. */
type ListRole<Ends extends ListEndpoints> = keyof Ends & ListRoleName;

export function mockFragmentFor<
  K extends ListSectionKey,
  Ends extends ListEndpoints,
  Live extends object,
  F extends string,
>(
  section: ListSectionModule<K, Ends, Live, F>,
  spec: ListMockSpec,
): Record<`${K}.${ListRole<Ends>}`, Handler> {
  const { identity, address, endpoints, listing } = section.decl;
  const fold = identity.fold ?? ((name: string) => name);
  const keyOf = (item: Json): string => fold(String(item[identity.field]));
  const uniqueOf = spec.unique === "identity" ? keyOf : spec.unique;
  // The collection holds the GET shape the section parses, so the address
  // reads the same fields off a raw item.
  const addressOf = (item: Json): Readonly<Record<string, string>> => address(item as Live);
  const locate = (state: MockState, param: (name: string) => string): Json | undefined =>
    spec
      .collection(state)
      .find((item) =>
        Object.entries(addressOf(item)).every(([name, value]) => param(name) === value),
      );
  const update: Handler = ({ state, param, body }) => {
    const item = locate(state, param);
    if (item === undefined) {
      return { status: 404, body: { message: "Not Found" } };
    }
    const id = Number(item.id);
    // Only the rename key may move the identity; a body naming the identity
    // field directly is ignored, as are the server-owned fields (re-minted last).
    const { [identity.renameKey ?? identity.field]: name, ...fields } = asObject(body);
    if (identity.renameKey !== undefined) {
      delete fields[identity.field];
    }
    Object.assign(item, fields);
    if (name !== undefined) {
      item[identity.field] = name;
    }
    Object.assign(item, spec.owned(id, state.slug, item));
    return ok(item);
  };
  const roles: Readonly<Record<string, Handler>> = {
    list: ({ state, query }) =>
      ok(
        listing?.unpaginated === true
          ? spec.collection(state)
          : slicePage(spec.collection(state), query, endpoints.list.pageSize),
      ),
    create: ({ state, body }) => {
      const payload = asObject(body);
      if (spec.collection(state).some((item) => uniqueOf(item) === uniqueOf(payload))) {
        // The section never creates one (an existing identity is updated or replaced, and
        // deploy_keys rejects reused material upfront), so this answers only other callers,
        // such as the private report's marker-label ensure.
        return { status: 422, body: { message: "Validation Failed" } };
      }
      const id = state.nextId++;
      const item: Json = { ...spec.defaults, ...payload };
      Object.assign(item, spec.owned(id, state.slug, item));
      spec.collection(state).push(item);
      return { status: 201, body: item };
    },
    ...(updateRole(endpoints) === undefined ? {} : { update }),
    remove: ({ state, param }) => {
      const item = locate(state, param);
      if (item === undefined) {
        return { status: 404, body: { message: "Not Found" } };
      }
      const items = spec.collection(state);
      items.splice(items.indexOf(item), 1);
      return noContent();
    },
  };
  // Object.fromEntries erases the key type; the record was built from exactly the declared roles.
  return Object.fromEntries(
    Object.entries(roles).map(([role, handler]) => [`${section.key}.${role}`, handler]),
  ) as Record<`${K}.${ListRole<Ends>}`, Handler>;
}
