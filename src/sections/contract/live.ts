/**
 * The live-body boundary: parse what the API returned ONCE, where it enters
 * a section, into the shape the handler's logic assumes - the "parse, don't
 * cast" sibling of the declared-value boundary in engine/validate.ts. A body
 * off the documented shape fails loudly here, naming the endpoint and the
 * exact defects, instead of surfacing later as a silent misread of an
 * asserted field.
 */

import type { z } from "zod";
import { type EndpointDecl, endpointMethod, endpointPath } from "./endpoints.js";
import type { SectionMeta } from "./module.js";

/**
 * Parse a live response body against the schema of what the section READS
 * (schemas stay loose objects, so passthrough fields survive for
 * subsetDiff/phantomKeys). Returns the typed clone on success; throws the
 * standard actionable contract-violation error - section, endpoint, the
 * first few zod issues, and the api-version advice - on mismatch.
 * `describe`, when given, names the concrete resource (an environment, a
 * page) the path template alone cannot spell.
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
