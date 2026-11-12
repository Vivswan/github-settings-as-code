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
  type ValidatedExecutionArgs,
  validate,
  validateExecutionArgs,
} from "graphql";
import { sharedGraphqlSchema } from "./graphql-schema.js";

/** A request GitHub's schema accepts, as graphql-js prepared it to run: the parsed document, its operation, the coerced variables. */
export type AcceptedGraphqlRequest = ValidatedExecutionArgs;

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
 * `operationName` of `query` under `variables` as GitHub accepts it, or the errors GitHub answers it with. graphql-js
 * words them; api.github.com words the same refusals its own way. Coercion only judges: a caller keeps handing on the
 * variables as sent.
 */
export function acceptedGraphqlRequest(
  query: string,
  operationName: string,
  variables: Readonly<Record<string, unknown>>,
): AcceptedGraphqlRequest | { errors: readonly GraphQLFormattedError[] } {
  const document = parsedDocument(query);
  if (document instanceof GraphQLError) {
    return { errors: [document.toJSON()] };
  }

  const schema = sharedGraphqlSchema();
  const documentErrors = validate(schema, document);
  if (documentErrors.length > 0) {
    return { errors: documentErrors.map((error) => error.toJSON()) };
  }

  const prepared = validateExecutionArgs({
    schema,
    document,
    operationName,
    variableValues: variables,
  });
  return "operation" in prepared ? prepared : { errors: prepared.map((error) => error.toJSON()) };
}

/** The errors of acceptedGraphqlRequest(), or null when GitHub accepts the request. */
export function graphqlRequestErrors(
  query: string,
  operationName: string,
  variables: Readonly<Record<string, unknown>>,
): readonly GraphQLFormattedError[] | null {
  const request = acceptedGraphqlRequest(query, operationName, variables);
  return "errors" in request ? request.errors : null;
}
