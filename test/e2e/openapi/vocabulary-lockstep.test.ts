/**
 * The hand-written GitHub vocabularies (the keys a PUT takes, the values a filter sends, the fields a GET alone
 * reports) pinned to the operation of GitHub's OpenAPI descriptor that defines each. The nightly's probe-schema
 * step runs this file against @octokit/openapi at latest, so an upstream addition or removal ends the night red
 * naming the table, instead of surfacing as a 422 at apply or a drift that never converges.
 */

import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { AFFILIATIONS, VISIBILITY_FILTERS } from "../../../src/discovery/discover.js";
import { OidcTemplate } from "../../../src/sections/actions/schema.js";
import { GRAPHQL_REVIEW_TWINS } from "../../../src/sections/branches/graphql-vocabulary.js";
import { REQUIRED_PROTECTION_KEYS } from "../../../src/sections/branches/index.js";
import {
  BOOLEAN_CONTROL_SET,
  isUrlKey,
  NULLABLE_CONTROLS,
  GET_ONLY_KEYS as PROTECTION_GET_ONLY_KEYS,
} from "../../../src/sections/branches/keys.js";
import {
  BranchProtectionConfig,
  PROTECTION_MAPPING_KEYS,
} from "../../../src/sections/branches/schema.js";
import { CustomPropertyConfig } from "../../../src/sections/custom_properties/schema.js";
import { InteractionLimitsConfig } from "../../../src/sections/interaction_limits/schema.js";
import { UPDATABLE_KEYS } from "../../../src/sections/secret_scanning_custom_patterns/index.js";
import { DEFAULT_ROLE, ROLE_FOR_PERMISSION } from "../../../src/sections/shared/roles.js";
import { GET_ONLY_KEYS as SETUP_GET_ONLY_KEYS } from "../../../src/sections/shared/setup-schema.js";
import { INTERACTION_EXPIRES, SECRET_SCANNING_UPDATABLE_KEYS } from "../mock/support.js";
import { loadSpec } from "./validate.js";

interface SchemaNode {
  readonly type?: unknown;
  readonly nullable?: boolean;
  readonly default?: unknown;
  readonly enum?: readonly unknown[];
  readonly items?: SchemaNode;
  readonly properties?: Readonly<Record<string, SchemaNode>>;
  readonly required?: readonly string[];
  readonly oneOf?: readonly SchemaNode[];
  readonly anyOf?: readonly SchemaNode[];
}

interface Parameter {
  readonly name: string;
  readonly schema: SchemaNode;
}

interface Shape {
  readonly properties: readonly string[];
  readonly required: readonly string[];
}

const REPO = "/repos/{owner}/{repo}";

const sorted = (values: Iterable<string>): string[] => [...new Set(values)].sort();

function defined<T>(value: T | undefined, what: string): T {
  expect(value, `${what} is absent`).toBeDefined();
  return value as T;
}

function requestBody(path: string, method: "put" | "patch"): SchemaNode {
  const operation = loadSpec().paths[path]?.[method];
  return defined(
    operation?.requestBody?.content?.["application/json"]?.schema as SchemaNode | undefined,
    `the ${method.toUpperCase()} ${path} JSON request body`,
  );
}

function getResponse(path: string): SchemaNode {
  const operation = loadSpec().paths[path]?.get;
  return defined(
    operation?.responses?.["200"]?.content?.["application/json"]?.schema as SchemaNode | undefined,
    `the GET ${path} 200 JSON response`,
  );
}

function getParameter(path: string, name: string): SchemaNode {
  const parameters = loadSpec().paths[path]?.get?.parameters as readonly Parameter[] | undefined;
  return defined(
    parameters?.find((p) => p.name === name)?.schema,
    `GET ${path}'s ${name} parameter`,
  );
}

const properties = (node: SchemaNode): string[] => sorted(Object.keys(node.properties ?? {}));
const required = (node: SchemaNode): string[] => sorted(node.required ?? []);
const enumValues = (node: SchemaNode): string[] =>
  sorted(defined(node.enum, "the enum").map(String));
const property = (node: SchemaNode, key: string): SchemaNode =>
  defined(node.properties?.[key], `the ${key} property`);
const difference = (all: readonly string[], minus: readonly string[]): string[] =>
  all.filter((key) => !minus.includes(key));

const documentedShape = (node: SchemaNode): Shape => ({
  properties: properties(node),
  required: required(node),
});

const jsonSchema = (schema: z.ZodType): SchemaNode =>
  z.toJSONSchema(schema, { io: "input" }) as SchemaNode;

const labels = (node: SchemaNode): string[] =>
  node.anyOf?.flatMap(labels) ??
  node.oneOf?.flatMap(labels) ??
  (Array.isArray(node.type)
    ? node.type.map(String)
    : [node.type === "array" ? `${String(node.items?.type)}[]` : String(node.type)]);

function reportedOnly(get: SchemaNode, put: SchemaNode, into: Set<string>): void {
  for (const [key, node] of Object.entries(get.properties ?? {})) {
    const twin = put.properties?.[key];
    if (twin === undefined) {
      into.add(key);
    } else if (twin.properties !== undefined) {
      reportedOnly(node, twin, into);
    }
  }
}

const PROTECTION = `${REPO}/branches/{branch}/protection`;
const protectionPut = () => requestBody(PROTECTION, "put");
const protectionGet = () => getResponse(PROTECTION);
const putBooleans = () =>
  Object.entries(protectionPut().properties ?? {}).filter(([, node]) => node.type === "boolean");

const StatusChecks = BranchProtectionConfig.shape.required_status_checks.unwrap().unwrap();
const Reviews = BranchProtectionConfig.shape.required_pull_request_reviews.unwrap().unwrap();
const Restrictions = BranchProtectionConfig.shape.restrictions.unwrap().unwrap();

const SECRET_SCANNING_PATTERN = `${REPO}/secret-scanning/custom-patterns/{pattern_id}`;

type Row =
  | {
      readonly relation: "equals";
      readonly ours: () => Shape | readonly string[];
      readonly descriptor: () => Shape | readonly string[];
    }
  | {
      readonly relation: "ours within descriptor";
      readonly ours: () => readonly string[];
      readonly descriptor: () => readonly string[];
    };

function setupGetOnlyRow(path: string): Row {
  return {
    relation: "equals",
    ours: () => sorted(SETUP_GET_ONLY_KEYS),
    descriptor: () =>
      difference(properties(getResponse(path)), properties(requestBody(path, "patch"))),
  };
}

const patternPatch = () => requestBody(SECRET_SCANNING_PATTERN, "patch");
const VERSION_GUARD = "custom_pattern_version";

function updatableKeysRow(ours: readonly string[]): Row {
  return {
    relation: "equals",
    ours: () => sorted(ours),
    descriptor: () => properties(patternPatch()).filter((key) => key !== VERSION_GUARD),
  };
}

const interactionLimitsPut = () => requestBody(`${REPO}/interaction-limits`, "put");

function interactionEnumRow(key: "limit" | "expiry"): Row {
  return {
    relation: "equals",
    ours: () => enumValues(jsonSchema(InteractionLimitsConfig.unwrap().shape[key].unwrap())),
    descriptor: () => enumValues(property(interactionLimitsPut(), key)),
  };
}

function reviewActorHolderRow(
  holder: "dismissal_restrictions" | "bypass_pull_request_allowances",
): Row {
  return {
    relation: "equals",
    ours: () => documentedShape(jsonSchema(Reviews.shape[holder].unwrap())),
    descriptor: () =>
      documentedShape(property(property(protectionPut(), "required_pull_request_reviews"), holder)),
  };
}

const ROWS: Readonly<Record<string, Row>> = {
  "actions.oidc_customization_sub: a key the OIDC template PUT takes that the discriminated union does not route":
    {
      relation: "equals",
      ours: () => sorted(OidcTemplate.options.flatMap((variant) => Object.keys(variant.shape))),
      descriptor: () => properties(requestBody(`${REPO}/actions/oidc/customization/sub`, "put")),
    },
  "code_scanning_default_setup: a field its GET reports and its PATCH lacks that the shared GET-only list does not refuse":
    setupGetOnlyRow(`${REPO}/code-scanning/default-setup`),
  "code_quality_setup: a field its GET reports and its PATCH lacks that the shared GET-only list does not refuse":
    setupGetOnlyRow(`${REPO}/code-quality/setup`),
  "collaborators and teams: a role_name the permission map reads back as that the invitation listing no longer reports":
    {
      relation: "ours within descriptor",
      ours: () => sorted(ROLE_FOR_PERMISSION.values()),
      descriptor: () =>
        enumValues(
          property(defined(getResponse(`${REPO}/invitations`).items, "the items"), "permissions"),
        ),
    },
  "collaborators and teams: DEFAULT_ROLE drifting from the collaborator PUT's own default for permission":
    {
      relation: "equals",
      ours: () => [DEFAULT_ROLE],
      descriptor: () => [
        String(
          property(requestBody(`${REPO}/collaborators/{username}`, "put"), "permission").default,
        ),
      ],
    },
  "custom_properties.value: a wire shape the PATCH gains or loses that the union does not follow (boolean and number are ours, sent as strings)":
    {
      relation: "equals",
      ours: () => sorted(labels(jsonSchema(CustomPropertyConfig.shape.value))),
      descriptor: () => {
        const entry = defined(
          property(requestBody(`${REPO}/properties/values`, "patch"), "properties").items,
          "the items",
        );
        const value = property(entry, "value");
        const documented = value.nullable === true ? [...labels(value), "null"] : labels(value);
        return sorted([...documented, "boolean", "number"]);
      },
    },
  "branches: a protection control the GET wraps as {url, enabled} that the boolean-control table does not fold":
    {
      relation: "equals",
      ours: () => sorted(BOOLEAN_CONTROL_SET),
      descriptor: () =>
        sorted(
          Object.entries(protectionGet().properties ?? {})
            .filter(([, node]) => node.properties?.enabled?.type === "boolean")
            .map(([key]) => key),
        ),
    },
  "branches: a bare boolean the protection PUT gains or loses that the boolean-control table misses (required_signatures has its own endpoint)":
    {
      relation: "equals",
      ours: () => sorted(BOOLEAN_CONTROL_SET).filter((key) => key !== "required_signatures"),
      descriptor: () => sorted(putBooleans().map(([key]) => key)),
    },
  "branches: a protection PUT boolean whose null spelling the nullable-control set does not match":
    {
      relation: "equals",
      ours: () => sorted(NULLABLE_CONTROLS),
      descriptor: () =>
        sorted(
          putBooleans()
            .filter(([, node]) => node.nullable === true)
            .map(([key]) => key),
        ),
    },
  "branches: a protection PUT key GitHub requires in every body that REQUIRED_PROTECTION_KEYS does not send":
    {
      relation: "equals",
      ours: () => sorted(REQUIRED_PROTECTION_KEYS),
      descriptor: () => required(protectionPut()),
    },
  "branches: a GET-only protection key (reported, no PUT word, neither a url nor a control) that GET_ONLY_KEYS does not drop":
    {
      relation: "equals",
      ours: () => sorted(PROTECTION_GET_ONLY_KEYS),
      descriptor: () => {
        const reported = new Set<string>();
        reportedOnly(protectionGet(), protectionPut(), reported);
        return sorted(
          [...reported].filter((key) => !isUrlKey(key) && !BOOLEAN_CONTROL_SET.has(key)),
        );
      },
    },
  "branches.required_status_checks: a PUT key or requirement the declared shape lacks (contexts is derived from checks, so required only here)":
    {
      relation: "equals",
      ours: () => {
        const shape = documentedShape(jsonSchema(StatusChecks));
        return { properties: shape.properties, required: sorted([...shape.required, "contexts"]) };
      },
      descriptor: () => documentedShape(property(protectionPut(), "required_status_checks")),
    },
  "branches.required_status_checks.checks[]: a field of a required check the strict item shape does not take":
    {
      relation: "equals",
      ours: () => documentedShape(jsonSchema(StatusChecks.shape.checks.unwrap().element)),
      descriptor: () =>
        documentedShape(
          defined(
            property(property(protectionPut(), "required_status_checks"), "checks").items,
            "the items",
          ),
        ),
    },
  "branches.restrictions: a PUT key or requirement the declared shape lacks": {
    relation: "equals",
    ours: () => documentedShape(jsonSchema(Restrictions)),
    descriptor: () => documentedShape(property(protectionPut(), "restrictions")),
  },
  "branches.required_pull_request_reviews.dismissal_restrictions: a PUT key or requirement the declared shape lacks":
    reviewActorHolderRow("dismissal_restrictions"),
  "branches.required_pull_request_reviews.bypass_pull_request_allowances: a PUT key or requirement the declared shape lacks":
    reviewActorHolderRow("bypass_pull_request_allowances"),
  "branches.required_pull_request_reviews: a review setting the PUT takes or requires that neither the shape nor the GraphQL twin table follows":
    {
      relation: "equals",
      ours: () => ({
        properties: sorted([
          ...PROTECTION_MAPPING_KEYS.required_pull_request_reviews,
          ...Object.keys(GRAPHQL_REVIEW_TWINS),
        ]),
        required: documentedShape(jsonSchema(Reviews)).required,
      }),
      descriptor: () => documentedShape(property(protectionPut(), "required_pull_request_reviews")),
    },
  "discovery visibility: a /user/repos visibility value the filter input lacks (internal is applied client-side, so ours alone)":
    {
      relation: "equals",
      ours: () => sorted(VISIBILITY_FILTERS.filter((value) => value !== "internal")),
      descriptor: () => enumValues(getParameter("/user/repos", "visibility")),
    },
  "discovery affiliation: an affiliation /user/repos knows (its default lists them all) that the filter input lacks":
    {
      relation: "equals",
      ours: () => sorted(AFFILIATIONS),
      descriptor: () =>
        sorted(String(getParameter("/user/repos", "affiliation").default).split(",")),
    },
  "secret_scanning_custom_patterns: a pattern PATCH field beyond the version guard that UPDATABLE_KEYS does not send":
    updatableKeysRow(UPDATABLE_KEYS),
  "secret_scanning_custom_patterns required: a PATCH field required beyond the version guard, which the update body sends only when it changes":
    {
      relation: "equals",
      ours: () => [VERSION_GUARD],
      descriptor: () => required(patternPatch()),
    },
  "mock secret scanning: a pattern PATCH field beyond the version guard that the mock's update does not store":
    updatableKeysRow(SECRET_SCANNING_UPDATABLE_KEYS),
  "interaction_limits.limit: a user group the PUT accepts that the declared enum refuses at parse":
    interactionEnumRow("limit"),
  "interaction_limits.expiry: an expiry the PUT accepts that the declared enum refuses at parse":
    interactionEnumRow("expiry"),
  "mock interaction_limits: an expiry the PUT accepts that INTERACTION_EXPIRES mints no expires_at for":
    {
      relation: "equals",
      ours: () => sorted(Object.keys(INTERACTION_EXPIRES)),
      descriptor: () => enumValues(property(interactionLimitsPut(), "expiry")),
    },
};

describe("the hand-written GitHub vocabularies match the descriptor node that defines each", () => {
  test.each(Object.entries(ROWS))("%s", (_name, row) => {
    if (row.relation === "equals") {
      expect(row.ours()).toEqual(row.descriptor());
      return;
    }
    const documented = row.descriptor();
    const missing = row.ours().filter((value) => !documented.includes(value));
    expect(missing, `${row.relation}: not in the descriptor`).toEqual([]);
  });
});
