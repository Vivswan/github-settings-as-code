/**
 * What GitHub keeps of a request body, decided once for every section route before its handler runs:
 * the fields the trimmed spec documents. api.github.com ignores an unknown key on an open body (the
 * GET never echoes it, so a misspelled setting never converges) and answers a 422 on a closed one; a
 * handler that stored the body verbatim would hide both from every scenario.
 */

import type { Route } from "../../../src/sections/contract/endpoints.js";
import { sharedValidator } from "../openapi/validate.js";
import type { Json, MockResponse } from "./support.js";

/**
 * Fields GitHub accepts (verified live) that its descriptor omits, so the spec-derived allowlist would
 * wrongly drop them. Each entry retires when upstream documents the field; request-body.test.ts pins
 * that every entry is still absent from the spec.
 *   PATCH /repos/{owner}/{repo} has_discussions  -> src/sections/repository/index.ts, UndocumentedPatchField
 */
export const UNDOCUMENTED_BODY_FIELDS: ReadonlyMap<Route, readonly string[]> = new Map([
  ["PATCH /repos/{owner}/{repo}", ["has_discussions"]],
]);

function isPlainObject(value: unknown): value is Json {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * The body a handler receives for `route`: the documented top-level fields of an object body, every
 * other shape untouched (a raw string, an array, no body: the OpenAPI validator's concern). Nested
 * objects pass as sent; the spec closes none of the nested shapes the sections write.
 */
export function acceptedBody(
  route: Route,
  body: unknown,
): { body: unknown } | { rejected: MockResponse } {
  const documented = sharedValidator().requestBody(route);
  if (documented === undefined || !isPlainObject(body)) {
    return { body };
  }
  const extra = UNDOCUMENTED_BODY_FIELDS.get(route) ?? [];
  const unknown = Object.keys(body).filter(
    (key) => !documented.fields.has(key) && !extra.includes(key),
  );
  if (unknown.length === 0) {
    return { body };
  }
  if (documented.closed) {
    const names = unknown.map((key) => JSON.stringify(key)).join(", ");
    const verb = unknown.length === 1 ? "is not a permitted key" : "are not permitted keys";
    return {
      rejected: {
        status: 422,
        body: { message: `Invalid request.\n\n${names} ${verb}.` },
        // The body is deliberately off the request schema; the validator skips only that check.
        requestOffSpec: true,
      },
    };
  }
  return {
    body: Object.fromEntries(Object.entries(body).filter(([key]) => !unknown.includes(key))),
  };
}
