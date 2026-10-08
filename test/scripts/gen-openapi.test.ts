/**
 * The descriptor-derived files against the installed @octokit/openapi: a bump that moves an enum, adds a rule type,
 * or reshapes a rule's parameters changes the fresh render while the committed copy stays, and nothing else reads
 * the two side by side. The nightly runs this file after installing the descriptor at @latest, so a release GitHub
 * makes fails the night before Dependabot's bump PR does. The generator's own refusals are pinned on hand-written
 * descriptors.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type Descriptor,
  descriptionLiteral,
  enumAt,
  loadDescriptor,
  OUTPUTS,
  render,
  renderRules,
  type SchemaNode,
} from "../../.github/scripts/gen-openapi.js";
import { ROOT } from "../root.js";

/** The piece width the generator packs words into; a text this long still fits one literal. */
const DESCRIPTION_WIDTH = 80;

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

describe("the rule emitter refuses what the hand-written rows could not have said silently", () => {
  const RULE_TYPE = (type: string) => ({ type: "string", enum: [type] });
  const creation = {
    type: "object",
    required: ["type"],
    properties: { type: RULE_TYPE("creation") },
  };
  const withRules = (
    variants: Record<string, unknown>[],
    schemas: Record<string, unknown> = {},
    put: Record<string, unknown>[] = variants,
    union: Record<string, unknown> = { type: "object", description: "A repository rule." },
    array: Record<string, unknown> = { type: "array" },
  ): Descriptor => {
    const body = (items: Record<string, unknown>[]) => ({
      requestBody: {
        content: {
          "application/json": {
            schema: {
              properties: { rules: { ...array, items: { ...union, oneOf: items } } },
            },
          },
        },
      },
    });
    return {
      paths: {
        "/repos/{owner}/{repo}/rulesets": { post: body(variants) },
        "/repos/{owner}/{repo}/rulesets/{ruleset_id}": { put: body(put) },
      },
      components: { schemas: schemas as Record<string, SchemaNode> },
    };
  };
  const withParameters = (type: string, parameters: Record<string, unknown>) => ({
    type: "object",
    required: ["type"],
    properties: { type: RULE_TYPE(type), parameters },
  });

  test("a rule with no parameters, one with every known keyword, and a shared shape render", () => {
    const pattern = {
      type: "object",
      required: ["operator", "pattern"],
      properties: {
        name: { type: "string" },
        negate: { type: "boolean" },
        operator: { type: "string", enum: ["starts_with", "regex"] },
        pattern: { type: "string" },
      },
    };
    // A field named like a keyword is a field: only c_pattern declares it, so it shares no shape.
    const described = {
      ...pattern,
      properties: { ...pattern.properties, description: { type: "string" } },
    };
    const text = renderRules(
      withRules([
        creation,
        withParameters("sized", {
          type: "object",
          required: ["count"],
          properties: {
            count: { type: "integer", minimum: 1, maximum: 9, description: "How many." },
            share: {
              type: "number",
              format: "float",
              maximum: 100,
              description: `${"The share, as a percentage of the whole, ".repeat(2)}and nothing more.`,
            },
            names: { type: "array", items: { type: "string" } },
            mode: { type: "string", enum: ["A", "B"] },
            one: { type: "string", enum: ["only"] },
          },
        }),
        withParameters("a_pattern", pattern),
        withParameters("b_pattern", { ...pattern, description: "spelled apart" }),
        withParameters("c_pattern", described),
      ]),
    );
    expect(text).toContain(
      'z.looseObject({ type: z.literal("creation") }).meta({\n  id: "Rule<creation>",\n})',
    );
    // Prose rides as .describe(), a long one in word pieces joined back, since no line may outgrow the cap.
    expect(text).toContain(
      'count: z.int({ abort: true }).min(1, { abort: true }).max(9, { abort: true }).describe("How many.")',
    );
    expect(text).toContain(
      [
        'share: z.number().max(100, { abort: true }).describe(["The share, as a percentage ',
        'of the whole, The share, as a percentage of the", "whole, and nothing more."].join(" ")).optional()',
      ].join(""),
    );
    expect(text).toContain(
      'names: z.array(z.string()).optional(), mode: z.enum(["A", "B"]).optional(), one: z.literal("only").optional()',
    );
    expect(text).toContain(
      [
        "const PatternRuleParameters = z.looseObject({ name: z.string().optional(), ",
        'negate: z.boolean().optional(), operator: z.enum(["starts_with", "regex"]), pattern: z.string() })',
        '.meta({\n  id: "PatternRuleParameters",\n});',
      ].join(""),
    );
    // b_pattern's own prose stays off the reference: a described $ref loses its text under draft-7.
    expect(text.match(/parameters: PatternRuleParameters\.optional\(\)/g)).toHaveLength(2);
    expect(text).not.toContain("spelled apart");
    expect(text).toContain("pattern: z.string(), description: z.string().optional() }).optional()");
  });

  test.each<[what: string, descriptor: Descriptor, refusal: string]>([
    [
      "a keyword the emitter does not render",
      withRules([
        withParameters("odd", {
          type: "object",
          properties: { n: { type: "integer", multipleOf: 2 } },
        }),
      ]),
      'rules[0].parameters.n: the emitter does not know keyword "multipleOf" on a integer',
    ],
    [
      "a type the emitter does not render",
      withRules([withParameters("odd", { type: "object", properties: { n: { type: "null" } } })]),
      'rules[0].parameters.n: the emitter does not know type "null"',
    ],
    [
      "a number format other than float",
      withRules([
        withParameters("odd", {
          type: "object",
          properties: { n: { type: "number", format: "double" } },
        }),
      ]),
      'rules[0].parameters.n: the emitter does not know number format "double"',
    ],
    [
      "a parameters component outside COMPONENT_IDS",
      withRules(
        [withParameters("odd", { $ref: "#/components/schemas/repository-rule-params-new" })],
        { "repository-rule-params-new": { type: "object", properties: {} } },
      ),
      "rules[0].parameters: #/components/schemas/repository-rule-params-new is not in COMPONENT_IDS",
    ],
    [
      "a shared parameters shape outside SHARED_PARAMETER_IDS",
      withRules([
        withParameters("a_size", { type: "object", properties: { size: { type: "integer" } } }),
        withParameters("b_size", { type: "object", properties: { size: { type: "integer" } } }),
      ]),
      'a_size, b_size share one parameters shape with no published definition; add "size" to SHARED_PARAMETER_IDS',
    ],
    [
      "a keyword the emitter does not render on the rule itself",
      withRules([{ ...creation, minProperties: 2 }]),
      'rules[0]: the emitter does not know keyword "minProperties" on a object',
    ],
    [
      "parameters that are not an object",
      withRules([withParameters("odd", { type: "array", items: { type: "string" } })]),
      "rules[0].parameters: an object was expected, not a array",
    ],
    [
      "a required keyword that is not a list",
      withRules([
        withParameters("odd", {
          type: "object",
          required: null,
          properties: { n: { type: "integer" } },
        }),
      ]),
      "rules[0].parameters: required is null, not a list of field names",
    ],
    [
      "a keyword on the rule union, which would bind every row",
      withRules([creation], {}, [creation], { type: "object", minProperties: 2 }),
      'rules[]: the emitter does not know keyword "minProperties" on a object',
    ],
    [
      "a rule union that is not an object",
      withRules([creation], {}, [creation], { type: "number" }),
      "rules[]: an object was expected, not a number",
    ],
    [
      "a keyword on the rules array, which would bind the list",
      withRules([creation], {}, [creation], undefined, { type: "array", minItems: 1 }),
      'rules: the emitter does not know keyword "minItems" on a array',
    ],
    [
      "a rules list that is not an array",
      withRules([creation], {}, [creation], undefined, { type: "number" }),
      "rules: an array was expected, not a number",
    ],
    [
      "a required name properties does not declare",
      withRules([
        withParameters("odd", {
          type: "object",
          required: ["gone"],
          properties: { n: { type: "integer" } },
        }),
      ]),
      'rules[0].parameters: required names "gone", which properties does not declare',
    ],
    [
      "two shared shapes claiming one published definition",
      withRules(
        (
          [
            ["a_pattern", "regex"],
            ["b_pattern", "regex"],
            ["c_pattern", "starts_with"],
            ["d_pattern", "starts_with"],
          ] as const
        ).map(([type, operator]) =>
          withParameters(type, {
            type: "object",
            properties: {
              name: { type: "string" },
              negate: { type: "boolean" },
              operator: { type: "string", enum: [operator] },
              pattern: { type: "string" },
            },
          }),
        ),
      ),
      "PatternRuleParameters is spelled two ways: by a_pattern, b_pattern and by c_pattern, d_pattern; one published definition cannot carry both",
    ],
    [
      "PUT rules that differ from the POST's",
      withRules([creation], {}, [
        creation,
        withParameters("extra", { type: "object", properties: {} }),
      ]),
      "the rules of POST /repos/{owner}/{repo}/rulesets and PUT /repos/{owner}/{repo}/rulesets/{ruleset_id} differ",
    ],
    [
      "a variant whose type is not one enum value",
      withRules([{ type: "object", properties: { type: { type: "string", enum: ["a", "b"] } } }]),
      "rules[0]: a rule variant's type is one enum value",
    ],
  ])("%s", (_what, descriptor, refusal) => {
    expect(() => renderRules(descriptor)).toThrow(refusal);
  });
});

describe("a long description round-trips through its pieces", () => {
  // The pieces are joined back at the spaces they were split at, so a space the text carried anywhere, a run of
  // them included, is a space the published schema carries; a lost one would misquote GitHub's own sentence.
  const long = "a".repeat(DESCRIPTION_WIDTH);
  test.each<[what: string, text: string]>([
    ["a leading space", ` ${long} b`],
    ["a run of spaces", `${long}  b`],
    ["a trailing space", `${long} b `],
    ["a newline and a tab inside a word", `${long} b\nc\td`],
    ["a word longer than a piece, standing alone", `${long} ${"u".repeat(150)} end`],
  ])("%s", (_what, text) => {
    const literal = descriptionLiteral(text);
    expect(literal).toStartWith("[");
    expect(new Function(`return ${literal};`)()).toBe(text);
  });
});
