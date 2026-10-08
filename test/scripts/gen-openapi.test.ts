/**
 * The descriptor-derived files against the installed @octokit/openapi: a bump that moves an enum changes the fresh
 * render while the committed copy stays, and nothing else reads the two side by side. The nightly runs this file
 * after installing the descriptor at @latest, so a release GitHub makes fails the night before Dependabot's bump
 * PR does. The generator's own refusals are pinned on hand-written descriptors.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type Descriptor,
  enumAt,
  loadDescriptor,
  OUTPUTS,
  render,
  type SchemaNode,
} from "../../.github/scripts/gen-openapi.js";
import { ROOT } from "../root.js";

describe("the committed descriptor-derived files", () => {
  const descriptor = loadDescriptor();
  test.each(OUTPUTS.map((output) => [output.path, output] as const))(
    "%s is a fresh render from the installed descriptor",
    (path, output) => {
      expect(readFileSync(join(ROOT, path), "utf8")).toBe(render(output, descriptor));
    },
  );
});

describe("the generator refuses what it cannot render, naming it", () => {
  const withPermissions = (schema: Record<string, unknown>): Descriptor => ({
    paths: {
      "/x": {
        patch: {
          requestBody: {
            content: { "application/json": { schema: { properties: { permissions: schema } } } },
          },
        },
      },
    },
    components: {
      schemas: {
        role: { type: "string", enum: ["read", "write"] },
        alias: { $ref: "#/components/schemas/role", enum: ["read"] },
        void: null as unknown as SchemaNode,
      },
    },
  });
  const PERMISSIONS = [
    "paths",
    "/x",
    "patch",
    "requestBody",
    "content",
    "application/json",
    "schema",
    "properties",
    "permissions",
  ];

  test("a $ref on the way is followed to its component", () => {
    expect(enumAt(withPermissions({ $ref: "#/components/schemas/role" }), PERMISSIONS)).toEqual([
      "read",
      "write",
    ]);
  });

  test.each<[what: string, schema: Record<string, unknown>, refusal: string]>([
    [
      "a node with no enum",
      { type: "string" },
      `${PERMISSIONS.join(".")} carries no enum, or an empty one`,
    ],
    [
      "an empty enum, which rendered would refuse every pending invitation's role",
      { enum: [] },
      `${PERMISSIONS.join(".")} carries no enum, or an empty one`,
    ],
    [
      "an enum that is not a list",
      { enum: "read" },
      `${PERMISSIONS.join(".")} carries no enum, or an empty one`,
    ],
    [
      "an enum whose member is not a string",
      { enum: ["read", 1] },
      `${PERMISSIONS.join(".")} enum member 1 is not a string`,
    ],
    [
      "a $ref to a component the descriptor lacks",
      { $ref: "#/components/schemas/gone" },
      "#/components/schemas/gone names no component schema",
    ],
    [
      "a $ref whose component is itself a $ref: OpenAPI ignores the alias's own enum, so it cannot stand in",
      { $ref: "#/components/schemas/alias" },
      "#/components/schemas/alias is a reference to #/components/schemas/role, a chain the emitter does not follow",
    ],
    [
      "a $ref to a component that is null",
      { $ref: "#/components/schemas/void" },
      "#/components/schemas/void names no component schema",
    ],
    [
      "a $ref outside the component schemas",
      { $ref: "#/components/responses/role" },
      "#/components/responses/role names no component schema",
    ],
  ])("%s", (_what, schema, refusal) => {
    expect(() => enumAt(withPermissions(schema), PERMISSIONS)).toThrow(refusal);
  });

  test("a missing step names the path up to it", () => {
    expect(() => enumAt(withPermissions({}), [...PERMISSIONS.slice(0, 3), "put"])).toThrow(
      "paths./x.patch.put is missing from the descriptor",
    );
  });
});
