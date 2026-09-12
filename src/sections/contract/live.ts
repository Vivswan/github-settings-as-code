/**
 * Parse what the API returned ONCE, where it enters a section: the "parse, don't cast" sibling of the
 * declared-value boundary in engine/validate.ts. A body off the documented shape fails here naming the
 * endpoint and the defects, instead of surfacing later as a silent misread.
 */

import type { z } from "zod";
import { type EndpointDecl, endpointMethod, endpointPath } from "./endpoints.js";
import type { SectionMeta } from "./module.js";

/**
 * Schemas stay loose objects, so passthrough fields survive for subsetDiff/phantomKeys. `describe` names
 * the concrete resource (an environment, a page) the path template alone cannot spell.
 */
export function parseLive<T>(
  section: SectionMeta,
  endpoint: EndpointDecl,
  schema: z.ZodType<T>,
  data: unknown,
  describe?: string,
): T {
  const parsed = schema.safeParse(data);
  if (parsed.success) {
    return parsed.data;
  }
  const issues = parsed.error.issues;
  const shown = issues.slice(0, 3).map((issue) => {
    const path = issue.path
      .map((part) => (typeof part === "number" ? `[${part}]` : `.${String(part)}`))
      .join("");
    return `${path.replace(/^\./, "") || "(body)"}: ${issue.message}`;
  });
  const more = issues.length > 3 ? `; and ${issues.length - 3} more issue(s)` : "";
  const where = describe === undefined ? "" : ` (${describe})`;
  throw new Error(
    `${section.key}: ${endpointMethod(endpoint.route)} ${endpointPath(endpoint.route)}${where} returned a body outside the documented shape - ${shown.join("; ")}${more}. Check the "api-version" input against the GitHub REST docs for this endpoint`,
  );
}
