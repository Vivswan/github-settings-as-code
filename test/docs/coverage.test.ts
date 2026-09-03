// COVERAGE.md contract tests over its sources: the rendered page's file citations resolve on disk,
// and the authored gaps never name a surface the action already calls (implementing a gap forces
// its row out). Supported rows are pinned in test/sections/docs-registry.test.ts, the page in test/scripts/gen-docs.test.ts.

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Kind, parse, type SelectionSetNode } from "graphql";
import { COVERAGE_DATA, type GapRow } from "../../.github/scripts/coverage-data.js";
import { renderCoverage } from "../../.github/scripts/gen-docs.js";
import {
  endpointMethod,
  endpointPath,
  matchesTemplate,
  type Route,
} from "../../src/sections/contract/endpoints.js";
import { DOCS } from "../../src/sections/docs-registry.js";
import { allEndpoints, allGraphqlOps, SECTIONS } from "../../src/sections/registry.js";

const ROOT = join(import.meta.dir, "..", "..");
const coverage = renderCoverage(SECTIONS, DOCS, COVERAGE_DATA);

describe("COVERAGE path citations", () => {
  test("every src/ or test/ path citation resolves on disk", () => {
    // File moves silently rot prose citations; existence on disk is the contract. A citation
    // must carry a file extension so prose slash-pairs ("test/lint jobs") do not read as paths;
    // a directory citation is invisible here, so cite files.
    const cited =
      coverage.match(/\b(?:src|test)\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*\.[a-z]+\b/g) ?? [];
    expect(cited.length, "COVERAGE.md cites no src/ or test/ path at all").toBeGreaterThan(0);
    for (const path of new Set(cited)) {
      expect(
        existsSync(join(ROOT, path)),
        `COVERAGE.md cites "${path}" but nothing exists there; update the citation to the file's current location`,
      ).toBe(true);
    }
  });
});

describe("COVERAGE gaps anti-test", () => {
  /** The facet of a GraphQL operation the collision check reads: its document text. */
  type GraphqlDocument = { readonly query: string };

  // The root fields an operation's document selects, with root-level fragment spreads and inline
  // fragments expanded so a refactor into fragments cannot hide a field.
  function rootFields(op: GraphqlDocument): string[] {
    const document = parse(op.query);
    const fragments = new Map<string, SelectionSetNode>();
    for (const definition of document.definitions) {
      if (definition.kind === Kind.FRAGMENT_DEFINITION) {
        fragments.set(definition.name.value, definition.selectionSet);
      }
    }
    const fields = (selections: SelectionSetNode): string[] =>
      selections.selections.flatMap((selection) => {
        switch (selection.kind) {
          case Kind.FIELD:
            return [selection.name.value];
          case Kind.INLINE_FRAGMENT:
            return fields(selection.selectionSet);
          case Kind.FRAGMENT_SPREAD: {
            const spread = fragments.get(selection.name.value);
            if (spread === undefined) {
              throw new Error(`fragment "${selection.name.value}" is not defined in the document`);
            }
            return fields(spread);
          }
          default:
            return [];
        }
      });
    return document.definitions.flatMap((definition) =>
      definition.kind === Kind.OPERATION_DEFINITION ? fields(definition.selectionSet) : [],
    );
  }

  /** A well-formed GraphQL root field name, as the GraphQL grammar spells a Name. */
  const GRAPHQL_NAME = /^[_A-Za-z][_0-9A-Za-z]*$/;
  /** A well-formed route path: one or more segments, each a literal of route characters or one {param}. */
  const REST_PATH = /^(?:\/(?:[A-Za-z0-9_.-]+|\{[A-Za-z_][A-Za-z0-9_]*\}))+$/;

  // A gap endpoint split into method and target, or a throw when the target is not a shape the
  // collision check can inspect: a check that cannot read its input must fail, not say "no collision".
  function parseGap(gap: string): { method: string; target: string } {
    const space = gap.indexOf(" ");
    const method = gap.slice(0, space);
    const target = gap.slice(space + 1);
    const grammar = method === "GraphQL" ? GRAPHQL_NAME : REST_PATH;
    if (!grammar.test(target)) {
      throw new Error(
        `gap endpoint "${gap}" is malformed: a GraphQL gap names one root field, a REST gap one route path`,
      );
    }
    return { method, target };
  }

  // Every gap endpoint colliding with a surface the action calls, as "<gap> -> <route or op>": a
  // REST gap matches a same-method route template (each {param} becomes a placeholder segment,
  // since matchesTemplate takes a CONCRETE path), a GraphQL gap an op selecting its root field.
  function gapCollisions(
    rows: readonly GapRow[],
    routes: ReadonlyArray<Route>,
    ops: ReadonlyArray<GraphqlDocument & { readonly name: string }>,
  ): string[] {
    const collisions: string[] = [];
    for (const row of rows) {
      for (const gap of row.endpoints) {
        const { method, target } = parseGap(gap);
        if (method === "GraphQL") {
          for (const op of ops) {
            if (rootFields(op).includes(target)) {
              collisions.push(`${gap} -> ${op.name}`);
            }
          }
          continue;
        }
        const concrete = target.replace(/\{[^}]+\}/g, "_param_");
        for (const route of routes) {
          if (endpointMethod(route) === method && matchesTemplate(endpointPath(route), concrete)) {
            collisions.push(`${gap} -> ${route}`);
          }
        }
      }
    }
    return collisions;
  }

  test("no gap endpoint matches a registered endpoint or GraphQL operation", () => {
    const routes = Object.values(allEndpoints()).map((endpoint) => endpoint.route);
    const ops = Object.values(allGraphqlOps());
    // Controls: a called route is caught in either parameter spelling, a same-path other-method
    // row is not; a selected GraphQL root field is caught with or without arguments, in the
    // operation, a spread, or an inline fragment; an unselected field and an op's own NAME are not.
    const labels: GapRow = {
      area: "control",
      endpoints: ["POST /repos/{owner}/{repo}/labels", "DELETE /repos/{o}/{r}/labels/{name}"],
      why: "control",
    };
    const gaps = (...endpoints: GapRow["endpoints"]): GapRow[] => [{ ...labels, endpoints }];
    expect(gapCollisions([labels], routes, ops)).toEqual([
      "POST /repos/{owner}/{repo}/labels -> POST /repos/{owner}/{repo}/labels",
      "DELETE /repos/{o}/{r}/labels/{name} -> DELETE /repos/{owner}/{repo}/labels/{name}",
    ]);
    expect(gapCollisions(gaps("PUT /repos/{owner}/{repo}/labels"), routes, ops)).toEqual([]);
    const synthetic = [
      { name: "ViewerLogin", query: "query ViewerLogin { viewer { login } }" },
      {
        name: "SpreadMeta",
        query: "query SpreadMeta { ...Root } fragment Root on Query { meta { gitHubServicesSha } }",
      },
      { name: "InlineNode", query: 'query InlineNode { ... on Query { node(id: "x") { id } } }' },
    ];
    expect(
      gapCollisions(
        gaps(
          "GraphQL pinEnvironment",
          "GraphQL viewer",
          "GraphQL meta",
          "GraphQL node",
          "GraphQL pinIssue",
          "GraphQL ViewerLogin",
        ),
        routes,
        [...ops, ...synthetic],
      ),
    ).toEqual([
      "GraphQL pinEnvironment -> PinEnvironment",
      "GraphQL viewer -> ViewerLogin",
      "GraphQL meta -> SpreadMeta",
      "GraphQL node -> InlineNode",
    ]);
    expect(gapCollisions(COVERAGE_DATA.gaps.rows ?? [], routes, ops)).toEqual([]);
  });

  test("a gap endpoint the collision check cannot inspect fails instead of reporting no collision", () => {
    const malformed: GapRow["endpoints"][number][] = [
      "GraphQL ",
      "GraphQL pinEnvironment()",
      "GraphQL pin environment",
      "GET /repos/{owner}/{repo}/labels (read-only)",
      "GET /repos/{}/labels",
      "GET /repos/{owner/labels",
      "GET /repos//labels",
      "GET /repos/{owner}{repo}/labels",
    ];
    for (const gap of malformed) {
      expect(() => gapCollisions([{ area: "x", endpoints: [gap], why: "x" }], [], [])).toThrow(
        `gap endpoint "${gap}" is malformed`,
      );
    }
  });
});
