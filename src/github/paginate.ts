/**
 * The single page loop the sections' listAll helpers and discovery share, so pagination cannot drift between them. An
 * endpoint with a documented cap below 100 (EndpointDecl.pageSize) passes its `perPage` so the short-page termination
 * check matches what GitHub serves.
 */

import type { ApiError, GithubClient } from "./api.js";

export type PageResult = { items: unknown[] } | { error: ApiError } | { malformed: true };

export async function paginate(
  api: GithubClient,
  path: string,
  extract: (data: unknown) => unknown[] | null = (data) => (Array.isArray(data) ? data : null),
  stop?: (items: unknown[]) => boolean,
  perPage = 100,
): Promise<PageResult> {
  const items: unknown[] = [];
  const separator = path.includes("?") ? "&" : "?";
  for (let page = 1; ; page++) {
    const result = await api.tryRequest(
      "GET",
      `${path}${separator}per_page=${perPage}&page=${page}`,
    );
    if ("error" in result) {
      return { error: result.error };
    }
    const chunk = extract(result.data);
    if (chunk === null) {
      return { malformed: true };
    }
    items.push(...chunk);
    if (stop?.(items) || chunk.length < perPage) {
      return { items };
    }
  }
}
