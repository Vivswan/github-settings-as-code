/**
 * Structural checks need only the query TEXT; full validation runs against GitHub's published schema as the
 * @octokit/graphql-schema package ships it, extended by the SDL of the upstream gaps the package lags. A
 * Dependabot bump that retires a field a query selects fails here, and one that ships a gap's field fails the
 * extension, naming the gap file to retire.
 */

import { describe, expect, test } from "bun:test";
import { schema as published } from "@octokit/graphql-schema";
import {
  buildSchema,
  extendSchema,
  GraphQLSchema,
  type OperationDefinitionNode,
  parse,
  validate,
  visit,
} from "graphql";
import {
  GRAPHQL_BOOLEAN_TWINS,
  GRAPHQL_REVIEW_TWINS,
  GRAPHQL_STATUS_CHECK_TWINS,
} from "../../src/sections/branches/graphql-rules.js";
import { allGraphqlOps } from "../../src/sections/registry.js";
import type { UnshippedGraphqlSdl } from "../../src/upstream-gaps/gap.js";
import { UNSHIPPED_GRAPHQL_SDL } from "../../src/upstream-gaps/index.js";

/**
 * The published schema plus every graphql-schema gap's SDL. assumeValid skips graphql-js's schema-level validation,
 * which rejects GitHub's SDL as-is (it deprecates implementation fields whose interface fields are not deprecated).
 * Each extension is validated without the flag, so a type or field the package now ships is refused (the gap's
 * tripwire); the result is rebuilt as assumeValid for the query validation.
 */
function schemaWithGaps(
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
      // kind is the explicit gating truth (never derived from POST), so a mutation declared "read" would silently pass the preflight write guard.
      const expectedType = op.kind === "write" ? "mutation" : "query";
      expect(operation.operation, `${key}: a ${op.kind} op must be a ${expectedType}`).toBe(
        expectedType,
      );
      if (op.kind === "read") {
        // Repo-addressed reads carry $owner/$repo, which is also how the e2e mock resolves their multi-repo target.
        const variables = (operation.variableDefinitions ?? []).map(
          (definition) => definition.variable.name.value,
        );
        expect(variables, `${key}: a read must take $owner and $repo`).toContain("owner");
        expect(variables, `${key}: a read must take $owner and $repo`).toContain("repo");
      }
    }
  });

  test("every query validates against GitHub's published schema, extended by the upstream gaps", () => {
    const schema = schemaWithGaps();
    for (const [key, op] of Object.entries(allGraphqlOps())) {
      const errors = validate(schema, parse(op.query));
      expect(
        errors.map((error) => `${key}: ${error.message}`),
        `${key}: the query must validate against the schema`,
      ).toEqual([]);
    }
  });

  test("a gap whose SDL the package already ships fails the extension naming the gap file (negative control)", () => {
    const shipped = {
      file: "src/upstream-gaps/example.ts",
      sdl: "extend type Repository { id: ID! }",
    };
    expect(() => schemaWithGaps([shipped])).toThrow(
      /refuses the SDL of src\/upstream-gaps\/example\.ts[\s\S]*Field "Repository\.id" already exists/,
    );
  });

  test.each(["branches.rulesQuery", "branches.rulesSnapshot"] as const)(
    "%s selects every translation-table twin",
    (key) => {
      // A twin in a translation table but not in the query's selection set would drift forever: the live field reads as undefined and never
      // converges (the planner's read), or the snapshot writes a rule without it (the snapshot's read).
      const op = allGraphqlOps()[key];
      if (op === undefined) {
        throw new Error(`the branches section no longer declares ${key}; update this test`);
      }
      // Only fields selected DIRECTLY on the rule nodes count, since that is where the engine reads node[twin]; an aliased twin reads back under the
      // alias, so aliases are rejected too.
      const selected = new Set<string>();
      visit(parse(op.query), {
        Field(node) {
          if (node.name.value !== "branchProtectionRules") {
            return;
          }
          for (const selection of node.selectionSet?.selections ?? []) {
            if (selection.kind !== "Field" || selection.name.value !== "nodes") {
              continue;
            }
            for (const field of selection.selectionSet?.selections ?? []) {
              if (field.kind === "Field") {
                expect(
                  field.alias,
                  `${key} must not alias "${field.name.value}": the engine reads rule fields by their twin name`,
                ).toBeUndefined();
                selected.add(field.name.value);
              }
            }
          }
        },
      });
      const twins = [
        ...Object.values(GRAPHQL_BOOLEAN_TWINS),
        ...Object.values(GRAPHQL_REVIEW_TWINS),
        ...Object.values(GRAPHQL_STATUS_CHECK_TWINS),
      ];
      for (const twin of twins) {
        expect(
          selected.has(twin),
          `${key} must select "${twin}" on the rule nodes: a twin in a translation table but not in the query's selection set can never converge`,
        ).toBe(true);
      }
    },
  );
});
