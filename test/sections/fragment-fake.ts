/**
 * A stateful GithubClient over a section's e2e mock fragment, so a unit idempotence proof runs against the mock's own transformers, not a second
 * hand-written inverse.
 *
 *   fragmentFake(section, ...)  -> that section's handlers; a request outside them is refused
 *   registryFake(live)          -> every section's handlers, the merged mock tables
 *   GraphQL                     -> dispatched by operation name onto the mock's GraphQL handlers
 */

import type { ApiError, GithubClient } from "../../src/github/api.js";
import type { SectionKey } from "../../src/schema.js";
import type { SectionMeta } from "../../src/sections/contract/module.js";
import { allGraphqlOps } from "../../src/sections/registry.js";
import { graphqlOpForBody, matchEndpoint } from "../e2e/mock/dispatch.js";
import { GRAPHQL_HANDLERS, HANDLERS } from "../e2e/mock/handlers.js";
import { buildStateForSlug, type LiveState, type MockState } from "../e2e/mock/state.js";
import type { Handler, Json } from "../e2e/mock/support.js";
import { REPO } from "./section-run.js";

export interface FragmentFake extends GithubClient {
  readonly state: MockState;
  /** Every write that reached a handler: "METHOD /path", or "GRAPHQL <opName>" for a mutation. */
  readonly writes: string[];
}

export function fragmentFake(
  section: SectionMeta,
  handlers: Readonly<Record<string, Handler>>,
  live: LiveState,
): FragmentFake {
  return handlerFake(handlers, live, section.key);
}

/** The fake over EVERY section's handlers (the merged mock tables), as an all-grades token sees them. */
export function registryFake(live: LiveState): FragmentFake {
  return handlerFake(HANDLERS, live, null);
}

function handlerFake(
  handlers: Readonly<Record<string, Handler>>,
  live: LiveState,
  only: SectionKey | null,
): FragmentFake {
  const state = buildStateForSlug(REPO.slug, { settingsYaml: null, liveState: live }, "org");
  const writes: string[] = [];
  return {
    state,
    writes,
    async tryRequest(method, path, payload) {
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
      if (method !== "GET") {
        writes.push(`${method} ${url.pathname}`);
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
        body: payload,
        grants: () => true,
      });
      if (response.status >= 400) {
        const error: ApiError = {
          status: response.status,
          message: String((response.body as { message?: unknown } | null)?.message ?? ""),
          body: JSON.stringify(response.body),
        };
        return { error };
      }
      return { data: response.body };
    },
    async tryGraphql(op, variables) {
      const dispatched = graphqlOpForBody({ operationName: op.name }, allGraphqlOps());
      const handler = dispatched === null ? undefined : GRAPHQL_HANDLERS[dispatched.key];
      if (
        dispatched === null ||
        (only !== null && dispatched.op.section !== only) ||
        handler === undefined
      ) {
        return { error: { status: 404, message: `unexpected GRAPHQL ${op.name}`, body: "" } };
      }
      if (op.kind === "write") {
        writes.push(`GRAPHQL ${op.name}`);
      }
      const result = handler({ state, op: dispatched.op, variables: variables as Json });
      if (result.errors !== undefined) {
        // The client's status fold (apiErrorFromGraphqlErrors): FORBIDDEN 403, NOT_FOUND 404, else 422.
        const types = result.errors.map((entry) => entry.type);
        const status = types.includes("FORBIDDEN") ? 403 : types.includes("NOT_FOUND") ? 404 : 422;
        return {
          error: {
            status,
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
