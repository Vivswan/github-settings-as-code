/**
 * GitHub's GraphQL schema as the e2e mock and the declared-query tests read it: the SDL the @octokit/graphql-schema
 * package ships, extended by the SDL of the upstream gaps the package lags.
 */

import { schema as published } from "@octokit/graphql-schema";
import { buildSchema, extendSchema, GraphQLSchema, parse } from "graphql";
import { UNSHIPPED_GRAPHQL_SDL } from "../../../src/generated/upstream-gaps.js";
import type { UnshippedGraphqlSdl } from "../../../src/upstream-gaps/gap.js";

/** Built once per process: parsing GitHub's SDL is the slow part, and run.ts and fuzz.ts check every GraphQL request against it. */
let shared: GraphQLSchema | undefined;

/**
 * The published schema plus every graphql-schema gap's SDL. assumeValid skips graphql-js's schema-level validation,
 * which rejects GitHub's SDL as-is (it deprecates implementation fields whose interface fields are not deprecated).
 * Each extension is validated without the flag, so a type or field the package now ships is refused (the gap's
 * tripwire); the result is rebuilt as assumeValid for the query validation.
 */
export function schemaWithGaps(
  gaps: readonly UnshippedGraphqlSdl[] = UNSHIPPED_GRAPHQL_SDL,
): GraphQLSchema {
  let schema = buildSchema(published.idl, { assumeValid: true });
  for (const { file, sdl } of gaps) {
    try {
      schema = new GraphQLSchema({
        ...extendSchema(schema, parse(sdl)).toConfig(),
        assumeValid: true,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        `the pinned @octokit/graphql-schema refuses the SDL of ${file}, so it now ships what that gap declares: ` +
          `delete the file and regenerate the index (bun .github/scripts/gen-gaps-index.ts). ${reason}`,
      );
    }
  }
  return schema;
}

export function sharedGraphqlSchema(): GraphQLSchema {
  shared ??= schemaWithGaps();
  return shared;
}
