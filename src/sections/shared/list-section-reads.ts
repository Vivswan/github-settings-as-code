/**
 * The list read split by `foreign`, and the item read behind the optional `get` role, shared by plan()
 * and snapshot() so both judge the same live set.
 */

import { ok, type Result } from "neverthrow";
import { z } from "zod";
import type { SectionFailure } from "../contract/errors.js";
import type { PlanContext, Read } from "../contract/plan.js";
import type { ErasedDecl, ListEndpoints } from "./list-section-decl.js";

function readList(decl: ErasedDecl<string>, ctx: PlanContext<ListEndpoints>): Read<object[]> {
  const query = decl.listing?.query;
  return decl.listing?.unpaginated === true
    ? ctx.read.list.call(z.array(decl.live), { query })
    : ctx.read.list.listAll(decl.live, { query });
}

interface LiveItems {
  readonly managed: object[];
  readonly foreign: { readonly name: string; readonly reason: string }[];
}

/** The parsed list split by `foreign`, in live order on both sides. */
export function readLive(
  decl: ErasedDecl<string>,
  ctx: PlanContext<ListEndpoints>,
): Read<LiveItems> {
  return readList(decl, ctx).map((live) => {
    const out: LiveItems = { managed: [], foreign: [] };
    for (const item of live) {
      const foreign = decl.foreign?.(item) ?? null;
      if (foreign === null) {
        out.managed.push(item);
      } else {
        out.foreign.push(foreign);
      }
    }
    return out;
  });
}

/** The read port of the optional `get` role; the erased dictionary cannot type it, so the shape is spelled here. */
interface ItemReadPort {
  call<T>(schema: z.ZodType<T>, opts: { params: Readonly<Record<string, string>> }): Read<T>;
}

/** The item's full body when the dictionary declares a `get`, the list item otherwise. */
export async function readItem(
  decl: ErasedDecl<string>,
  ctx: PlanContext<ListEndpoints>,
  item: object,
): Promise<Result<object, SectionFailure>> {
  if (!("get" in decl.endpoints)) {
    return ok(item);
  }
  const port = (ctx.read as unknown as { readonly get: ItemReadPort }).get;
  return port.call(decl.live, { params: decl.address(item) });
}
