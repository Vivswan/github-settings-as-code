/**
 * A stateful GitHubClient over a section's e2e mock fragment, so a unit idempotence proof runs against the mock's own transformers, not a second
 * hand-written inverse.
 *
 *   fragmentFake(section, ...)  -> that section's handlers; a request outside them is refused
 *   registryFake(live, token)   -> every section's handlers, the merged mock tables, under the token's permission mask when one is given
 *   GraphQL                     -> dispatched by operation name onto the mock's GraphQL handlers
 */

import { type ClientAnswer, type GitHubClient, PAGE_SIZE } from "../../src/github/api.js";
import type { ApiError } from "../../src/github/api-error.js";
import type { SectionKey } from "../../src/schema.js";
import type { SectionMeta } from "../../src/sections/contract/module.js";
import { endpointPermission } from "../../src/sections/contract/operations.js";
import { allGraphqlOps } from "../../src/sections/registry.js";
import { graphqlOpForBody, matchEndpoint, requestHeaders } from "../e2e/mock/dispatch.js";
import {
  denialResponse,
  endpointRequirement,
  gradeRequirement,
  graphqlDenialErrors,
  type Requirement,
  SECTION_BY_KEY,
} from "../e2e/mock/grading.js";
import { GRAPHQL_HANDLERS, HANDLERS } from "../e2e/mock/handlers.js";
import { acceptedBody } from "../e2e/mock/request-body.js";
import { buildStateForSlug, type LiveState, type MockState } from "../e2e/mock/state.js";
import type { Handler, Json, MockResponse } from "../e2e/mock/support.js";
import type { DenialStyle, PermissionMask } from "../e2e/scenario.js";
import { REPO } from "./section-run.js";

export interface FragmentFake extends GitHubClient {
  /** The mock state the handlers read and mutate. */
  readonly state: MockState;

  /** Every write past routing and the permission grade, a closed body's 422 included: "METHOD /path", or "GRAPHQL <opName>" for a mutation. */
  readonly writes: string[];
}

/** The token the fake grades requests against; omitted, every grant is held. */
export interface FakeToken {
  readonly mask: PermissionMask;
  readonly denialStyle: DenialStyle;
}

/** A routed REST request: its URL, the matched declaration, and the handler the table holds for it. */
interface Routed {
  url: URL;
  matched: NonNullable<ReturnType<typeof matchEndpoint>>;
  handler: Handler;
}

/** A dispatched GraphQL operation: the declaration the body names and the handler the table holds for it. */
interface GraphqlRouted {
  dispatched: NonNullable<ReturnType<typeof graphqlOpForBody>>;
  handler: NonNullable<(typeof GRAPHQL_HANDLERS)[string]>;
}

/** The client's status fold (apiErrorFromGraphqlErrors): FORBIDDEN 403, NOT_FOUND 404, else 422. */
export function graphqlErrorStatus(types: readonly string[]): 403 | 404 | 422 {
  if (types.includes("FORBIDDEN")) {
    return 403;
  }
  if (types.includes("NOT_FOUND")) {
    return 404;
  }
  return 422;
}

export function fragmentFake(
  section: SectionMeta,
  handlers: Readonly<Record<string, Handler>>,
  live: LiveState,
): FragmentFake {
  return handlerFake(handlers, live, section.key);
}

/** The fake over EVERY section's handlers (the merged mock tables), as the token sees them (all grades held by default). */
export function registryFake(live: LiveState, token?: FakeToken): FragmentFake {
  return handlerFake(HANDLERS, live, null, token);
}

/** The request's route and handler, or the 404 the fake answers outside the section's (or the registry's) handlers. */
function routeOf(
  handlers: Readonly<Record<string, Handler>>,
  only: SectionKey | null,
  method: string,
  path: string,
): Routed | { error: ApiError } {
  const url = new URL(path, "https://api.github.com");
  const matched = matchEndpoint(method, url.pathname);
  const handler = matched === null ? undefined : handlers[matched.key];
  if (
    matched === null ||
    (only !== null && matched.endpoint.section !== only) ||
    handler === undefined
  ) {
    return { error: { status: 404, message: `unexpected ${method} ${path}`, body: "" } };
  }
  return { url, matched, handler };
}

/** The GraphQL operation the body names and its handler, or the 404 the fake answers outside the section's (or the registry's) handlers. */
function graphqlRouteOf(
  only: SectionKey | null,
  name: string,
): GraphqlRouted | { error: ApiError } {
  const dispatched = graphqlOpForBody({ operationName: name }, allGraphqlOps());
  const handler = dispatched === null ? undefined : GRAPHQL_HANDLERS[dispatched.key];
  if (
    dispatched === null ||
    (only !== null && dispatched.op.section !== only) ||
    handler === undefined
  ) {
    return { error: { status: 404, message: `unexpected GRAPHQL ${name}`, body: "" } };
  }
  return { dispatched, handler };
}

/** The mock's own denial of a request the token's grants do not cover, so a section meets exactly what the e2e pipeline answers; null when it is allowed. */
function denialOf(
  token: FakeToken | undefined,
  requirement: Requirement,
): { error: ApiError } | null {
  if (token === undefined || gradeRequirement(token.mask, requirement).allowed) {
    return null;
  }
  const denied = denialResponse(token.denialStyle, requirement.kind);
  return {
    error: {
      status: denied.status,
      message: String((denied.body as { message?: unknown }).message ?? ""),
      body: JSON.stringify(denied.body),
    },
  };
}

function handlerFake(
  handlers: Readonly<Record<string, Handler>>,
  live: LiveState,
  only: SectionKey | null,
  token?: FakeToken,
): FragmentFake {
  const state = buildStateForSlug(REPO.slug, { settingsYaml: null, liveState: live }, "org");
  const writes: string[] = [];
  const serve = (
    method: string,
    path: string,
    payload: unknown,
    accept: string | undefined,
  ): { response: MockResponse } | { error: ApiError } => {
    const routed = routeOf(handlers, only, method, path);
    if ("error" in routed) {
      return routed;
    }
    const { url, matched, handler } = routed;
    const requirement = endpointRequirement(matched.endpoint);
    const denied = denialOf(token, requirement);
    if (denied !== null) {
      return denied;
    }
    if (method !== "GET") {
      writes.push(`${method} ${url.pathname}`);
    }
    // The stage the wire pipeline runs before its handler (routes.ts): the handler keeps only the body fields GitHub
    // documents, so a section proof cannot converge on a key GitHub never stores.
    const accepted = acceptedBody(matched.endpoint.route, payload);
    if ("rejected" in accepted) {
      return { response: accepted.rejected };
    }
    const response = handler({
      state,
      endpoint: matched.endpoint,
      param: (name) => {
        const value = matched.params[name];
        if (value === undefined) {
          throw new Error(`fragmentFake: ${matched.endpoint.route} declares no "${name}" param`);
        }
        return value;
      },
      query: Object.fromEntries(url.searchParams),
      body: accepted.body,
      // The section's media type reaches the handler, so a probe whose reply GitHub shapes by Accept is proven here too.
      headers: requestHeaders(accept === undefined ? {} : { accept }),
      grants: (kind) =>
        token === undefined ||
        gradeRequirement(token.mask, { permission: requirement.permission, kind }).allowed,
    });
    return { response };
  };
  const answerOf = (response: MockResponse): ClientAnswer<unknown> => {
    if (response.status >= 400) {
      const error: ApiError = {
        status: response.status,
        message: String((response.body as { message?: unknown } | null)?.message ?? ""),
        body: JSON.stringify(response.body),
      };
      return { error };
    }
    return { data: response.body };
  };
  return {
    state,
    writes,
    async tryRequest(method, path, payload, options) {
      const served = serve(method, path, payload, options?.accept);
      return "error" in served ? served : answerOf(served.response);
    },
    // The handler's `nextPage` is what the wire pipeline renders as the Link header, so the walk here ends where the
    // real client's would.
    async tryList(path, options) {
      const perPage = options?.perPage ?? PAGE_SIZE;
      const separator = path.includes("?") ? "&" : "?";
      const pages: unknown[] = [];
      for (let page = 1; ; page++) {
        const served = serve(
          "GET",
          `${path}${separator}per_page=${perPage}&page=${page}`,
          undefined,
          undefined,
        );
        if ("error" in served) {
          return served;
        }
        const answer = answerOf(served.response);
        if (!("data" in answer)) {
          return answer;
        }
        pages.push(answer.data);
        if (served.response.nextPage === undefined || options?.until?.(answer.data) === true) {
          return { data: pages };
        }
      }
    },
    async tryGraphql(op, variables) {
      const routed = graphqlRouteOf(only, op.name);
      if ("error" in routed) {
        return routed;
      }
      const { dispatched, handler } = routed;
      const owner = SECTION_BY_KEY.get(dispatched.op.section);
      if (owner === undefined) {
        throw new Error(
          `fragmentFake: no section module registered for "${dispatched.op.section}"`,
        );
      }
      const requirement = { permission: endpointPermission(owner, dispatched.op), kind: op.kind };
      const errors =
        token !== undefined && !gradeRequirement(token.mask, requirement).allowed
          ? graphqlDenialErrors(token.denialStyle, op.kind)
          : undefined;
      if (op.kind === "write" && errors === undefined) {
        writes.push(`GRAPHQL ${op.name}`);
      }
      const result =
        errors === undefined
          ? handler({ state, op: dispatched.op, variables: variables as Json })
          : { data: null, errors };
      if (result.errors !== undefined) {
        const types = result.errors.map((entry) => entry.type);
        return {
          error: {
            status: graphqlErrorStatus(types),
            message: result.errors.map((entry) => entry.message).join("; "),
            body: JSON.stringify(result.errors),
            graphqlTypes: [...types].sort(),
          },
        };
      }
      return { data: result.data };
    },
  };
}
