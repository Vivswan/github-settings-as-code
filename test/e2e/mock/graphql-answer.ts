/**
 * A handler's data as GitHub's schema serves it: graphql-js completes it under the request's own document, and the
 * completed data must be the handler's own at every selected position, except null under a nullable key the handler
 * left out. Without it a key the document never selected reaches the product, and an answer off the schema is judged
 * only where the product parses it, as the product's error.
 */

import { executeRootSelectionSet, type GraphQLFieldResolver } from "graphql";
import { isPlainObject } from "../../../src/plain-data.js";
import type { AcceptedGraphqlRequest } from "./graphql-request.js";
import type { Json } from "./support.js";

/** A handler's data is keyed as the response is, so a field is read under its response key, an alias included. */
const answeredField: GraphQLFieldResolver<unknown, unknown> = (source, _args, _context, info) =>
  isPlainObject(source) ? source[info.path.key] : undefined;

/**
 * Where `completed` is not what the handler `answered`, one line per position: the path and both values. Completion
 * alone lets these through: a string where an object belongs completes to an object of nulls, `true` in an Int field
 * to 1. The one difference allowed is null under a nullable key the handler left out.
 */
function differences(answered: unknown, completed: unknown, path: string): string[] {
  if (completed === null && answered === undefined) {
    return [];
  }

  if (Array.isArray(completed) && Array.isArray(answered) && answered.length === completed.length) {
    return completed.flatMap((item, index) =>
      differences(answered[index], item, `${path}.${index}`),
    );
  }

  if (isPlainObject(completed) && isPlainObject(answered)) {
    return Object.entries(completed).flatMap(([key, value]) =>
      differences(answered[key], value, `${path}.${key}`),
    );
  }

  if (answered === completed) {
    return [];
  }
  return [
    `${path}: answered ${JSON.stringify(answered)}, the schema serves ${JSON.stringify(completed)}`,
  ];
}

/**
 * `data` as GitHub would serialize it for `request`: the selection and nothing beside it, a selected nullable field the
 * data lacks as null. Data GitHub's schema could never have produced returns one line per fault instead: graphql-js's
 * error at its response path, or a position where the completed value is not the handler's own.
 */
export function completedGraphqlAnswer(
  request: AcceptedGraphqlRequest,
  data: unknown,
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

  const differing = differences(data, completed.data, "data");
  if (differing.length > 0) {
    return { errors: differing };
  }

  // graphql-js leaves `data` unset only beside errors.
  return { data: completed.data as Json };
}
