/**
 * What GitHub refuses of a GraphQL request before it runs any of it: a document that does not validate against its
 * schema, and variables that do not coerce to the types the operation declares. A handler handed such a request
 * would store an input field GitHub's schema does not have, and every scenario would pass on it.
 */

import {
  type DocumentNode,
  GraphQLError,
  type GraphQLFormattedError,
  parse,
  validate,
  validateExecutionArgs,
} from "graphql";
import { sharedGraphqlSchema } from "./graphql-schema.js";

/** The document, or the syntax error graphql-js reports by throwing it. */
function parsedDocument(query: string): DocumentNode | GraphQLError {
  try {
    return parse(query);
  } catch (error) {
    if (error instanceof GraphQLError) {
      return error;
    }
    throw error;
  }
}

/**
 * The errors GitHub answers `operationName` of `query` with under `variables`, or null when it accepts the request.
 * graphql-js words them; api.github.com words the same refusals its own way. Coercion only judges: a caller keeps
 * handing on the variables as sent.
 */
export function graphqlRequestErrors(
  query: string,
  operationName: string,
  variables: Readonly<Record<string, unknown>>,
): readonly GraphQLFormattedError[] | null {
  const document = parsedDocument(query);
  if (document instanceof GraphQLError) {
    return [document.toJSON()];
  }

  const schema = sharedGraphqlSchema();
  const documentErrors = validate(schema, document);
  if (documentErrors.length > 0) {
    return documentErrors.map((error) => error.toJSON());
  }

  const prepared = validateExecutionArgs({
    schema,
    document,
    operationName,
    variableValues: variables,
  });
  return "operation" in prepared ? null : prepared.map((error) => error.toJSON());
}
