/**
 * A handler's data as GitHub's schema serves it: graphql-js completes it under the request's own document. Without it
 * the mock answers what GitHub cannot, a null in a non-null field or a key the document never selected, and every
 * scenario passes on it.
 */

import { executeRootSelectionSet, type GraphQLFieldResolver } from "graphql";
import { isPlainObject } from "../../../src/plain-data.js";
import type { AcceptedGraphqlRequest } from "./graphql-request.js";
import type { Json } from "./support.js";

/** A handler's data is keyed as the response is, so a field is read under its response key, an alias included. */
const answeredField: GraphQLFieldResolver<unknown, unknown> = (source, _args, _context, info) =>
  isPlainObject(source) ? source[info.path.key] : undefined;

/**
 * `data` as GitHub would serialize it for `request`: the selection and nothing beside it, a selected nullable field the
 * data lacks as null. Data the schema could never serialize returns one line per error instead, the response path and
 * graphql-js's message.
 */
export function completedGraphqlAnswer(
  request: AcceptedGraphqlRequest,
  data: Json,
): { data: Json } | { errors: readonly string[] } {
  const completed = executeRootSelectionSet({
    ...request,
    rootValue: data,
    fieldResolver: answeredField,
  });
  if (completed instanceof Promise) {
    throw new Error("BUG: graphql-js completed plain data asynchronously");
  }

  const errors = completed.errors ?? [];
  if (errors.length > 0) {
    return {
      errors: errors.map((error) => {
        const path = ["data", ...(error.path ?? [])].join(".");
        return `${path}: ${error.message}`;
      }),
    };
  }

  // graphql-js leaves `data` unset only beside errors.
  return { data: completed.data as Json };
}
