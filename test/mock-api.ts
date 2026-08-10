import type { ApiError, GithubClient, GraphqlOp } from "../src/github/api.js";

export type Route = { data?: unknown; error?: ApiError };

export type MockApiOptions = { unroutedMutations?: "throw" | "succeed" };

/**
 * Duck-typed GithubClient over a route table; records every mutation.
 * GraphQL operations route through the same table under the key
 * `GRAPHQL <opName>` (`data` must be the response's data object), and are
 * recorded with their declared kind so mutations() can tell a GraphQL read
 * from a write - every GraphQL call shares the POST method, so the method
 * alone cannot.
 */
export class MockApi implements GithubClient {
  calls: Array<{
    method: string;
    path: string;
    payload?: unknown;
    graphqlKind?: "read" | "write";
  }> = [];
  private routes: Record<string, Route>;
  private unroutedMutations: "throw" | "succeed";

  constructor(routes: Record<string, Route>, opts?: MockApiOptions) {
    this.routes = routes;
    this.unroutedMutations = opts?.unroutedMutations ?? "throw";
  }

  /** Register keys (exact or trailing-glob) as permitted mutations returning {data: null}. */
  allowMutations(...keys: string[]) {
    for (const key of keys) {
      this.routes[key] = { data: null };
    }
    return this;
  }

  private lookup(method: string, path: string): Route | undefined {
    const key = `${method} ${path}`;
    const exact = this.routes[key];
    if (exact) {
      return exact;
    }
    for (const routeKey of Object.keys(this.routes)) {
      if (!routeKey.endsWith("/*")) {
        continue;
      }
      const prefix = routeKey.slice(0, -1);
      if (key.startsWith(prefix)) {
        return this.routes[routeKey];
      }
    }
    return undefined;
  }

  async tryRequest(
    method: string,
    path: string,
    payload?: unknown,
    _options?: { accept?: string; raw?: boolean },
  ): Promise<{ data: unknown } | { error: ApiError }> {
    this.calls.push({ method, path, payload });
    const route = this.lookup(method, path);
    if (!route) {
      if (method === "GET") {
        return { error: { status: 404, message: "Not Found", body: "" } };
      }
      if (this.unroutedMutations === "throw") {
        throw new Error(
          `MockApi: unrouted mutation ${method} ${path}; add a route or allowMutations(...)`,
        );
      }
      return { data: null };
    }
    if (route.error) {
      return { error: route.error };
    }
    return { data: route.data ?? null };
  }

  async tryGraphql(
    op: GraphqlOp,
    variables: Readonly<Record<string, unknown>>,
    _slug: string,
  ): Promise<{ data: Record<string, unknown> } | { error: ApiError }> {
    this.calls.push({ method: "GRAPHQL", path: op.name, payload: variables, graphqlKind: op.kind });
    const route = this.routes[`GRAPHQL ${op.name}`];
    if (!route) {
      if (op.kind === "read") {
        // Mirror the unrouted-GET default: absence reads as GitHub's 404.
        return { error: { status: 404, message: "Not Found", body: "" } };
      }
      if (this.unroutedMutations === "throw") {
        throw new Error(
          `MockApi: unrouted GraphQL mutation ${op.name}; add a "GRAPHQL ${op.name}" route or allowMutations(...)`,
        );
      }
      return { data: {} };
    }
    if (route.error) {
      return { error: route.error };
    }
    return { data: (route.data ?? {}) as Record<string, unknown> };
  }

  mutations() {
    return this.calls.filter((c) => c.method !== "GET" && c.graphqlKind !== "read");
  }
}
