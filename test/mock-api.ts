import {
  type ClientAnswer,
  type GitHubClient,
  type GraphqlOp,
  type ListOptions,
  PAGE_SIZE,
  type RequestMark,
} from "../src/github/api.js";
import type { ApiError } from "../src/github/api-error.js";

/** `failed` is the client's own line for a request with no HTTP answer (not sent, the transport failed). */
export type Route = { data?: unknown; error?: ApiError; failed?: string };

export type MockApiOptions = { unroutedMutations?: "throw" | "succeed" };

function markOf(options: RequestMark | undefined): { carriesSecret?: true } {
  return options?.carriesSecret === true ? { carriesSecret: true } : {};
}

/**
 * The longest list a page body carries, as GitHub shapes one: the bare list, or a list under a `total_count`
 * envelope. The walker cannot know the declared key, so the page is full while any list in it is full.
 */
function pageItems(body: unknown): unknown[] | null {
  if (Array.isArray(body)) {
    return body;
  }
  if (typeof body === "object" && body !== null && "total_count" in body) {
    const lists = Object.values(body).filter(Array.isArray);
    return lists.length === 0
      ? null
      : lists.reduce((longest, list) => (list.length > longest.length ? list : longest));
  }
  return null;
}

/**
 * tryList for a double that answers one request at a time: the pages are asked for as `per_page=N&page=K`, the
 * shape every route table keys, and the walk ends on a short page (what a route table has in place of GitHub's
 * Link header), on a body carrying no list (the caller reports it malformed), or on the page `until` accepts. The
 * first page that is not answered with data is the whole answer, as the real client's walk ends there too.
 */
async function listThroughRequests(
  tryRequest: GitHubClient["tryRequest"],
  path: string,
  options: ListOptions | undefined,
): Promise<ClientAnswer<unknown[]>> {
  const perPage = options?.perPage ?? PAGE_SIZE;
  const separator = path.includes("?") ? "&" : "?";
  const pages: unknown[] = [];
  for (let page = 1; ; page++) {
    const answer = await tryRequest("GET", `${path}${separator}per_page=${perPage}&page=${page}`);
    if (!("data" in answer)) {
      return answer;
    }
    pages.push(answer.data);
    const items = pageItems(answer.data);
    if (items === null || items.length < perPage || options?.until?.(answer.data) === true) {
      return { data: pages };
    }
  }
}

/**
 * Gives a double that answers requests its tryList over its own tryRequest. The double keeps its identity, so its
 * `this` keeps working.
 */
export function withListing<T extends GitHubClient>(client: Omit<T, "tryList">): T {
  return Object.assign(client, {
    tryList: (path: string, options?: ListOptions) =>
      listThroughRequests((...args) => client.tryRequest(...args), path, options),
  }) as T;
}

/**
 * Duck-typed GitHubClient over a route table. GraphQL operations route under `GRAPHQL <opName>` and record their declared kind, since every GraphQL
 * call shares the POST method and mutations() could not tell a read from a write otherwise.
 */
export class MockApi implements GitHubClient {
  calls: Array<{
    method: string;
    path: string;
    payload?: unknown;
    /** Present exactly when the request arrived marked as carrying a resolved secret. */
    carriesSecret?: true;
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
    options?: RequestMark & { accept?: string; raw?: boolean },
  ): Promise<ClientAnswer<unknown>> {
    this.calls.push({ method, path, payload, ...markOf(options) });
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
    if (route.failed !== undefined) {
      return { failed: route.failed };
    }
    if (route.error) {
      return { error: route.error };
    }
    return { data: route.data ?? null };
  }

  tryList(path: string, options?: ListOptions): Promise<ClientAnswer<unknown[]>> {
    return listThroughRequests((...args) => this.tryRequest(...args), path, options);
  }

  async tryGraphql(
    op: GraphqlOp,
    variables: Readonly<Record<string, unknown>>,
    _slug: string,
    options?: RequestMark,
  ): Promise<ClientAnswer<Record<string, unknown>>> {
    this.calls.push({
      method: "GRAPHQL",
      path: op.name,
      payload: variables,
      ...markOf(options),
      graphqlKind: op.kind,
    });
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
    if (route.failed !== undefined) {
      return { failed: route.failed };
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
