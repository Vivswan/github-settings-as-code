/**
 * Every declared GraphQL operation's query, validated at two depths:
 *   - structural checks that need only the query TEXT (a single named
 *     operation whose name and kind match the declaration, $owner/$repo on
 *     repo-addressed reads) run always;
 *   - full schema validation (graphql.validate against GitHub's published
 *     schema) runs when the fetched, gitignored schema artifact is present.
 *     Locally its absence skips with the fetch command (a fresh clone should
 *     not fail on a missing artifact); in CI the artifact is cache-restored
 *     or re-fetched before `bun test`, so absence there is a broken pipeline
 *     and FAILS - the same missing-artifact posture as the trimmed OpenAPI
 *     spec, where CI always materializes the file and only local runs may
 *     lack it.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildSchema, type OperationDefinitionNode, parse, validate } from "graphql";
import { allGraphqlOps } from "../../src/sections/registry.js";

const SCHEMA_PATH = join(import.meta.dir, "..", "e2e", "graphql", "schema.docs.graphql");
const FETCH_COMMAND = "bun .github/scripts/fetch-graphql-schema.ts";

const schemaAvailable = existsSync(SCHEMA_PATH);
if (!schemaAvailable) {
  if (process.env.CI) {
    throw new Error(
      `the GraphQL schema is missing at ${SCHEMA_PATH} in CI. The checks workflow must restore it from cache or fetch it (${FETCH_COMMAND}) before running tests`,
    );
  }
  console.warn(
    `graphql-queries: schema validation skipped - the fetched artifact is missing at ${SCHEMA_PATH}. Generate it with: ${FETCH_COMMAND}`,
  );
}

/** The single operation definition of a declared query, asserted to exist. */
function operationOf(key: string, query: string): OperationDefinitionNode {
  const document = parse(query);
  const operations = document.definitions.filter(
    (definition): definition is OperationDefinitionNode =>
      definition.kind === "OperationDefinition",
  );
  expect(operations, `${key}: a query must be a single operation`).toHaveLength(1);
  return operations[0] as OperationDefinitionNode;
}

describe("declared GraphQL queries", () => {
  test("every query is one named operation matching its declaration", () => {
    for (const [key, op] of Object.entries(allGraphqlOps())) {
      const operation = operationOf(key, op.query);
      expect(operation.name?.value, `${key}: the operation name must equal op.name`).toBe(op.name);
      // The declared kind and the query's operation type must agree: kind is
      // the explicit gating truth (never derived from POST), so a mutation
      // declared "read" would silently pass the preflight write guard.
      const expectedType = op.kind === "write" ? "mutation" : "query";
      expect(operation.operation, `${key}: a ${op.kind} op must be a ${expectedType}`).toBe(
        expectedType,
      );
      if (op.kind === "read") {
        // Repo-addressed reads carry $owner/$repo, which is also how the e2e
        // mock resolves their multi-repo target.
        const variables = (operation.variableDefinitions ?? []).map(
          (definition) => definition.variable.name.value,
        );
        expect(variables, `${key}: a read must take $owner and $repo`).toContain("owner");
        expect(variables, `${key}: a read must take $owner and $repo`).toContain("repo");
      }
    }
  });

  test.skipIf(!schemaAvailable)("every query validates against GitHub's published schema", () => {
    const schema = buildSchema(readFileSync(SCHEMA_PATH, "utf8"));
    for (const [key, op] of Object.entries(allGraphqlOps())) {
      const errors = validate(schema, parse(op.query));
      expect(
        errors.map((error) => `${key}: ${error.message}`),
        `${key}: the query must validate against the schema`,
      ).toEqual([]);
    }
  });
});
