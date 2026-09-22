/**
 * Validates the mock's traffic against GitHub's published OpenAPI contract: the mock stands in for
 * GitHub, so drift between what it serves and what GitHub documents is a mock bug (or a stale descriptor).
 * The descriptor is @octokit/openapi's dereferenced api.github.com document, cut in memory to USED_PATHS
 * by loadSpec(); a Dependabot bump that stops documenting a used path, or starts documenting an upstream
 * gap, fails the load by name.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Ajv, type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";
import {
  endpointMethod,
  endpointPath,
  matchesTemplate,
  type Route,
} from "../../../src/sections/contract/endpoints.js";
import { GRAPHQL_ERROR_TYPES } from "../../../src/sections/contract/graphql.js";
import { allGraphqlOps } from "../../../src/sections/registry.js";
import { UNDOCUMENTED_ROUTES } from "../../../src/upstream-gaps/index.js";
import { VIOLATION_PREFIX } from "../constants.js";
import type { LoggedRequest } from "../mock/contract.js";
import { UNDOCUMENTED_PATHS, USED_PATHS } from "./paths.js";

type Json = Record<string, unknown>;

/**
 * The dereferenced (no $ref) api.github.com descriptor, resolved by file so the package's index, which loads every
 * GHES and GHEC variant too, never runs. Dereferenced, so a kept path carries its inlined schemas and no
 * components graph has to come along.
 */
const DESCRIPTOR_PATH = fileURLToPath(
  import.meta.resolve("@octokit/openapi/generated/api.github.com.deref.json"),
);

function segments(path: string): string[] {
  return path.split("/").filter((s) => s.length > 0);
}

/**
 * GitHub routes these trailing params greedily, so one segment per param would miss real paths.
 *   {path} on contents  -> ".github/settings.yml"
 *   {ref} on git ref    -> "heads/release/1.x"
 */
const GREEDY_TRAILING_PARAMS: ReadonlySet<string> = new Set(["{path}", "{ref}"]);

export function pathMatches(template: string, pathname: string): boolean {
  const templateSegs = segments(template);
  const lastTemplate = templateSegs[templateSegs.length - 1];
  if (lastTemplate !== undefined && GREEDY_TRAILING_PARAMS.has(lastTemplate)) {
    const prefix = templateSegs.slice(0, -1);
    const pathSegs = segments(pathname);
    if (pathSegs.length <= prefix.length) {
      return false;
    }
    return prefix.every((seg, i) => seg.startsWith("{") || seg === pathSegs[i]);
  }
  return matchesTemplate(template, pathname);
}

export interface OpenApiViolation {
  /** "METHOD /pathname" the violation is attributed to. */
  request: string;
  kind: "unknown-route" | "request-body" | "response-body";
  detail: string;
}

/**
 * Rewrites an OpenAPI 3.0 schema into what draft-07 ajv accepts; the spec in memory is never mutated.
 * Response bodies drop `required` because GitHub marks nearly every field of a resource required and
 * the mock serves only the subset the action reads; request bodies keep it (small, author-controlled).
 *
 *   nullable: true            -> "null" joins the type array (and a sibling enum)
 *   example/xml/discriminator -> dropped, annotation only
 *   oneOf, required dropped   -> anyOf: the widened branches overlap, so exactly-one would fail
 */
export function toJsonSchema(node: unknown, keepRequired = false): unknown {
  if (Array.isArray(node)) {
    return node.map((child) => toJsonSchema(child, keepRequired));
  }
  if (node === null || typeof node !== "object") {
    return node;
  }
  const input = node as Json;
  const out: Json = {};
  for (const [key, value] of Object.entries(input)) {
    if (
      key === "nullable" ||
      key === "example" ||
      key === "examples" ||
      key === "xml" ||
      key === "discriminator"
    ) {
      continue;
    }
    if (key === "required" && !keepRequired) {
      continue;
    }
    // A sibling anyOf would be clobbered, so such a node keeps its oneOf.
    if (key === "oneOf" && !keepRequired && !("anyOf" in input)) {
      out.anyOf = toJsonSchema(value, keepRequired);
      continue;
    }
    out[key] = toJsonSchema(value, keepRequired);
  }
  if (input.nullable === true && out.type !== undefined) {
    const types = Array.isArray(out.type) ? out.type : [out.type];
    if (!types.includes("null")) {
      out.type = [...types, "null"];
    }
    // GitHub spells nullable enums as nullable: true beside an enum WITHOUT null; a widened type
    // alone cannot get null past the enum keyword.
    if (Array.isArray(out.enum) && !out.enum.includes(null)) {
      out.enum = [...out.enum, null];
    }
  } else if (input.nullable === true) {
    // nullable beside a bare oneOf/anyOf (the custom property `value` schema): a null branch keeps
    // oneOf's exactly-one semantics, since null matches only that branch.
    for (const combinator of ["oneOf", "anyOf"] as const) {
      const branches = out[combinator];
      if (Array.isArray(branches)) {
        out[combinator] = [...branches, { type: "null" }];
      }
    }
  }
  return out;
}

/** The subset of an OpenAPI operation the validator and the docs generator read. */
interface Operation {
  requestBody?: {
    required?: boolean;
    content?: Record<string, { schema?: unknown }>;
  };
  responses?: Record<string, { content?: Record<string, { schema?: unknown }> }>;
  externalDocs?: { url: string };
  [key: string]: unknown;
}

type PathItem = Record<string, Operation>;

export interface OpenApiSpec {
  paths: Record<string, PathItem>;
}

/**
 * `doc` cut to exactly `usedPaths`, the slice the validator and the docs generator read. USED_PATHS spells
 * templates as OpenAPI keys them ("/repos/{owner}/{repo}/labels"), so the match is exact string equality.
 * Three descriptor states fail here, at load, by name, instead of as a wrong verdict downstream:
 *   a used path the descriptor lacks       -> the action calls a path GitHub does not document at this version
 *   an undocumented path it now documents  -> the owning gap in src/upstream-gaps/ is due for retirement
 *   a $ref left in the kept slice          -> a partial deref ajv would compile wrong or skip silently
 */
export function trimDescriptor(
  doc: { paths: Record<string, unknown> },
  usedPaths: readonly string[],
  undocumentedPaths: readonly string[],
): OpenApiSpec {
  const missing = usedPaths.filter((path) => doc.paths[path] === undefined);
  if (missing.length > 0) {
    throw new Error(
      `these USED_PATHS are not in the @octokit/openapi descriptor:\n  ${missing.join("\n  ")}\n` +
        "Either the path is wrong in test/e2e/openapi/paths.ts, or GitHub stopped documenting it",
    );
  }
  // An UNDOCUMENTED_PATHS entry exists precisely BECAUSE the descriptor lacks it, so the moment a bump documents
  // one, the carve-out must go (and validation switch on).
  const nowDocumented = undocumentedPaths.filter((path) => doc.paths[path] !== undefined);
  if (nowDocumented.length > 0) {
    throw new Error(
      `the @octokit/openapi descriptor now documents: ${nowDocumented.join(", ")}. Retire the owning gap in ` +
        "src/upstream-gaps/ (delete the spec-only file, or flip documentedInSpec to true on an octokit-kind one) " +
        "and regenerate the index (bun .github/scripts/gen-gaps-index.ts), so the validator covers them",
    );
  }
  const paths: Record<string, PathItem> = {};
  for (const path of usedPaths) {
    paths[path] = doc.paths[path] as PathItem;
  }
  const serialized = JSON.stringify(paths);
  if (serialized.includes('"$ref"')) {
    const sample = [...serialized.matchAll(/"\$ref":\s*"([^"]+)"/g)].slice(0, 5).map((m) => m[1]);
    throw new Error(
      `the descriptor slice still contains $ref pointers (e.g. ${sample.join(", ")}); ` +
        "@octokit/openapi's .deref.json is no longer fully dereferenced",
    );
  }
  return { paths };
}

/** Parsed and cut once per process: the runner, the mock's body pipeline, the docs generator, and the tests all read it. */
let sharedSpec: OpenApiSpec | undefined;
export function loadSpec(): OpenApiSpec {
  if (!sharedSpec) {
    const doc = JSON.parse(readFileSync(DESCRIPTOR_PATH, "utf8")) as {
      paths: Record<string, unknown>;
    };
    sharedSpec = trimDescriptor(doc, USED_PATHS, UNDOCUMENTED_PATHS);
  }
  return sharedSpec;
}

/**
 * What GitHub keeps of a request body: the properties the operation's schema documents, across every
 * oneOf/anyOf/allOf branch, and whether the schema closes over them (additionalProperties: false, where
 * GitHub answers an unknown key with a 422 instead of dropping it).
 */
export interface DocumentedRequestBody {
  readonly fields: ReadonlySet<string>;
  readonly closed: boolean;
}

/** Collects a schema's property names into `fields`; true when the schema itself is closed. */
function collectDocumentedFields(schema: unknown, fields: Set<string>): boolean {
  if (schema === null || typeof schema !== "object" || Array.isArray(schema)) {
    return false;
  }
  const node = schema as Json;
  const properties = node.properties;
  if (properties !== null && typeof properties === "object") {
    for (const name of Object.keys(properties)) {
      fields.add(name);
    }
  }
  for (const combinator of ["oneOf", "anyOf", "allOf"]) {
    const branches = node[combinator];
    if (Array.isArray(branches)) {
      for (const branch of branches) {
        collectDocumentedFields(branch, fields);
      }
    }
  }
  return node.additionalProperties === false;
}

/** Built once per process and reused across scenarios, so schemas compile once per variant, not per run. */
export class OpenApiValidator {
  private readonly ajv: Ajv;
  private readonly templates: string[];
  /** The declared GraphQL operation names the /graphql branch accepts. */
  private readonly graphqlOpNames: ReadonlySet<string>;
  /** Compiled response-body validators (required relaxed), keyed by schema. */
  private readonly cache = new Map<unknown, ValidateFunction>();
  /** Compiled request-body validators (required kept), keyed by schema. */
  private readonly requiredCache = new Map<unknown, ValidateFunction>();
  /** The documented request body per declared route; null records an operation documenting none. */
  private readonly bodyCache = new Map<string, DocumentedRequestBody | null>();

  constructor(
    private readonly spec: OpenApiSpec,
    // Injectable so tests can check the known-name rule with fixture names.
    graphqlOpNames?: ReadonlySet<string>,
  ) {
    // strict: false because the descriptor carries vocabulary ajv treats as unknown;
    // validateFormats: false because structure is checked, not string formats.
    this.ajv = new Ajv({ strict: false, validateFormats: false, allErrors: true });
    addFormats(this.ajv);
    this.templates = Object.keys(spec.paths);
    this.graphqlOpNames =
      graphqlOpNames ?? new Set(Object.values(allGraphqlOps()).map((op) => op.name));
  }

  /** Over the shared descriptor slice; a descriptor the action outgrew fails in loadSpec() by name, never skips. */
  static load(): OpenApiValidator {
    return new OpenApiValidator(loadSpec());
  }

  private matchTemplate(pathname: string): string | null {
    for (const template of this.templates) {
      if (pathMatches(template, pathname)) {
        return template;
      }
    }
    return null;
  }

  /**
   * The documented request body of a declared route ("PATCH /repos/{owner}/{repo}/labels/{name}"), or
   * undefined when the operation documents no body, or one without properties.
   */
  requestBody(route: Route): DocumentedRequestBody | undefined {
    const cached = this.bodyCache.get(route);
    if (cached !== undefined) {
      return cached ?? undefined;
    }
    const operation = this.spec.paths[endpointPath(route)]?.[endpointMethod(route).toLowerCase()];
    const fields = new Set<string>();
    const closed = collectDocumentedFields(
      this.jsonSchema(operation?.requestBody?.content),
      fields,
    );
    const body = fields.size === 0 ? null : { fields, closed };
    this.bodyCache.set(route, body);
    return body ?? undefined;
  }

  /** Two caches, not one: a schema shared by a request and a response body compiles once per variant. */
  private check(schema: unknown, value: unknown, keepRequired: boolean): string[] {
    if (schema === undefined) {
      return [];
    }
    const cache = keepRequired ? this.requiredCache : this.cache;
    let validate = cache.get(schema);
    if (!validate) {
      validate = this.ajv.compile(toJsonSchema(schema, keepRequired) as object);
      cache.set(schema, validate);
    }
    if (validate(value)) {
      return [];
    }
    return (validate.errors ?? []).map(
      (error) => `${error.instancePath || "(root)"} ${error.message ?? "is invalid"}`,
    );
  }

  private jsonSchema(content: Record<string, { schema?: unknown }> | undefined): unknown {
    return content?.["application/json"]?.schema;
  }

  /**
   * Every violation in one exchange, so a run collects them all. The harness's own shapes (denials,
   * mock violations, off-spec bodies) are excluded: the spec never documents them.
   */
  validateRequest(request: LoggedRequest): OpenApiViolation[] {
    if (request.offSpec) {
      return [];
    }
    if (request.deniedBy !== undefined) {
      return []; // a permission denial, not a documented GitHub response
    }
    if (request.status < 100) {
      // A connection drop logs status 0; kept beside offSpec so a bare sentinel never reads as real.
      return [];
    }
    if (request.status === 400 && isMockViolationBody(request.responseBody)) {
      return []; // the mock's own contract-violation reply
    }
    if (request.pathname === "/graphql") {
      // The OpenAPI descriptor never covers /graphql, so this branch is hand-written, not a skip.
      return this.validateGraphql(request);
    }
    const label = `${request.method} ${request.pathname}`;
    const template = this.matchTemplate(request.pathname);
    if (template === null) {
      if (
        UNDOCUMENTED_ROUTES.some(
          (route) =>
            endpointMethod(route) === request.method &&
            pathMatches(endpointPath(route), request.pathname),
        )
      ) {
        // A real endpoint the descriptor omits (src/upstream-gaps): nothing to check. Method-exact
        // on purpose: an unlisted method on the same path is still an unknown route.
        return [];
      }
      return [
        {
          request: label,
          kind: "unknown-route",
          detail: "path matches no template in the descriptor slice",
        },
      ];
    }
    const method = request.method.toLowerCase();
    const operation = this.spec.paths[template]?.[method];
    if (!operation) {
      return [
        {
          request: label,
          kind: "unknown-route",
          detail: `the spec documents no ${request.method} on "${template}"`,
        },
      ];
    }
    const violations: OpenApiViolation[] = [];
    // Request bodies keep `required`: they are small and author-controlled. requestOffSpec exempts
    // only the schema check (a handler tags a passthrough user typo it answers with GitHub's real
    // 4xx); a missing required body, or a body on a bodyless operation, stays a harness bug.
    const requestBody = operation.requestBody;
    const requestSchema = this.jsonSchema(requestBody?.content);
    if (request.body !== undefined) {
      if (requestSchema !== undefined) {
        if (request.requestOffSpec !== true) {
          for (const detail of this.check(requestSchema, request.body, true)) {
            violations.push({ request: label, kind: "request-body", detail });
          }
        }
      } else if (requestBody === undefined && typeof request.body !== "string") {
        // GitHub accepts no body here. A string body is the raw/malformed-client case exercised
        // elsewhere, and an op documenting a body without a JSON schema has nothing to shape-check.
        violations.push({
          request: label,
          kind: "request-body",
          detail: `${request.method} "${template}" documents no request body, but the client sent one`,
        });
      }
    } else if (requestBody?.required === true) {
      violations.push({
        request: label,
        kind: "request-body",
        detail: `the spec marks the request body required for ${request.method} "${template}", but the client sent none`,
      });
    }
    // GitHub's spec routinely omits error statuses (many 404s), so an undocumented >= 400 passes,
    // matching the mock's statusAllowed. It documents its success statuses, so an undocumented
    // 2xx/3xx means the EndpointDecl or the handler serves a status GitHub does not.
    const response = operation.responses?.[String(request.status)];
    if (!response && request.status < 400) {
      violations.push({
        request: label,
        kind: "response-body",
        detail: `the spec lists no ${request.status} response for ${request.method} "${template}"; GitHub documents its success statuses, so an undocumented 2xx/3xx means the EndpointDecl or mock handler serves a status GitHub does not`,
      });
    }
    // server.ts leaves responseBody unset for what must not be checked, so anything here is a JSON
    // body the spec should describe, primitives included.
    //   documented schema           -> validated (presence relaxed, shapes checked)
    //   success status, no content  -> a non-null body is a contract break; null is the empty 204
    //   >= 400, no schema           -> not flagged: the spec omits most error bodies
    const body = request.responseBody;
    if (body !== undefined && body !== null && response) {
      const schema = this.jsonSchema(response.content);
      if (schema !== undefined) {
        for (const detail of this.check(schema, body, false)) {
          violations.push({ request: label, kind: "response-body", detail });
        }
      } else if (request.status < 400 && isNoContent(response)) {
        violations.push({
          request: label,
          kind: "response-body",
          detail: `the spec documents no response content for ${request.status} on ${request.method} "${template}", but the mock sent a body`,
        });
      }
    }
    return violations;
  }

  validateLog(requests: readonly LoggedRequest[]): OpenApiViolation[] {
    return requests.flatMap((request) => this.validateRequest(request));
  }

  /** The GraphQL wire contract; findings take the OpenAPI kinds so a run reports them alike. */
  private validateGraphql(request: LoggedRequest): OpenApiViolation[] {
    const label = `${request.method} /graphql`;
    if (request.method !== "POST") {
      return [
        {
          request: label,
          kind: "unknown-route",
          detail: "GraphQL requests must be POST",
        },
      ];
    }
    const violations: OpenApiViolation[] = [];
    const body = request.body as
      | { query?: unknown; operationName?: unknown; variables?: unknown }
      | undefined;
    if (typeof body?.query !== "string") {
      violations.push({
        request: label,
        kind: "request-body",
        detail: "the request body must carry a string `query`",
      });
    }
    if (typeof body?.operationName !== "string") {
      violations.push({
        request: label,
        kind: "request-body",
        detail: "the request body must carry a string `operationName`",
      });
    } else if (!this.graphqlOpNames.has(body.operationName)) {
      violations.push({
        request: label,
        kind: "request-body",
        detail: `operationName "${body.operationName}" names no declared GraphQL operation`,
      });
    }
    if (
      typeof body?.variables !== "object" ||
      body.variables === null ||
      Array.isArray(body.variables)
    ) {
      violations.push({
        request: label,
        kind: "request-body",
        detail: "the request body must carry a `variables` object",
      });
    }
    if (request.status !== 200) {
      violations.push({
        request: label,
        kind: "response-body",
        detail: `GraphQL responses are HTTP 200 (errors ride the body), but the mock answered ${request.status}`,
      });
    }
    const response = request.responseBody as
      | { data?: unknown; errors?: unknown }
      | null
      | undefined;
    if (typeof response !== "object" || response === null) {
      violations.push({
        request: label,
        kind: "response-body",
        detail: "the response body must be an object",
      });
      return violations;
    }
    const data = response.data;
    if (data !== null && (typeof data !== "object" || Array.isArray(data))) {
      violations.push({
        request: label,
        kind: "response-body",
        detail: "the response `data` must be an object or null",
      });
    }
    if (response.errors !== undefined) {
      if (!Array.isArray(response.errors) || response.errors.length === 0) {
        violations.push({
          request: label,
          kind: "response-body",
          detail: "the response `errors`, when present, must be a non-empty array",
        });
        return violations;
      }
      for (const entry of response.errors) {
        const type = (entry as { type?: unknown } | null)?.type;
        const message = (entry as { message?: unknown } | null)?.message;
        if (
          typeof type !== "string" ||
          !(GRAPHQL_ERROR_TYPES as readonly string[]).includes(type)
        ) {
          violations.push({
            request: label,
            kind: "response-body",
            detail: `errors[].type "${String(type)}" is not a known GraphQL error type [${GRAPHQL_ERROR_TYPES.join(", ")}]`,
          });
        }
        if (typeof message !== "string") {
          violations.push({
            request: label,
            kind: "response-body",
            detail: "every errors[] entry must carry a string message",
          });
        }
      }
    }
    return violations;
  }
}

function isNoContent(response: { content?: Record<string, unknown> }): boolean {
  return response.content === undefined || Object.keys(response.content).length === 0;
}

/** True when a 400 body is the mock's own violation shape, not a GitHub error. */
function isMockViolationBody(body: unknown): boolean {
  return (
    typeof body === "object" &&
    body !== null &&
    typeof (body as Json).message === "string" &&
    ((body as Json).message as string).startsWith(VIOLATION_PREFIX)
  );
}

/** Compiled once per process: run.ts and fuzz.ts both reach it through the runner. */
let shared: OpenApiValidator | undefined;
export function sharedValidator(): OpenApiValidator {
  if (!shared) {
    shared = OpenApiValidator.load();
  }
  return shared;
}

/**
 * validateRequest for callers holding the response body apart from the request. An explicit `null`
 * responseBody OVERRIDES the request's field (the empty 204), so the default is a sentinel, not `??`.
 */
const NOT_PROVIDED = Symbol("responseBody-not-provided");
export function validateExchange(
  request: LoggedRequest & { body?: unknown },
  responseBody: unknown = NOT_PROVIDED,
): string[] {
  const resolved = responseBody === NOT_PROVIDED ? request.responseBody : responseBody;
  const entry: LoggedRequest = { ...request, responseBody: resolved };
  return sharedValidator()
    .validateRequest(entry)
    .map((v) => `${v.request} [${v.kind}]: ${v.detail}`);
}
