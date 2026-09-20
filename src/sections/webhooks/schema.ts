/** The `webhooks:` section's schema slice; root src/schema.ts composes the SettingsFile property from it. */

import { z } from "zod";
import { REPOSITORY_WEBHOOK_EVENTS, WEBHOOK_EVENTS_REFERENCE } from "./events.js";

/**
 * JSON.stringify on an arbitrary YAML value would throw on a cyclic alias and kill the run before the normal failure
 * path, so containers describe by kind only; strings stay quoted so a refused "1" and a refused 1 read differently.
 */
function spell(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "a list";
  }
  if (typeof value === "object") {
    return "a mapping";
  }
  return String(value);
}

// GitHub 422s each of these at apply time ("is not a valid event", "Url is not a valid URL"); the REST wire types are
// bare strings, so the parser carries the list GitHub's webhooks description publishes and refuses the rest naming it.
const WebhookEvent = z.enum([...REPOSITORY_WEBHOOK_EVENTS, "*"] as const, {
  error: (issue) =>
    `${spell(issue.input)} is not an event GitHub delivers to repository webhooks ("*" means every event); ` +
    `the accepted names are GitHub's list at ${WEBHOOK_EVENTS_REFERENCE}, read from @octokit/openapi-webhooks, ` +
    "so an event GitHub added since arrives in the release that bumps that package",
});

const WebhookDeliveryConfig = z
  .looseObject({
    url: z.url({
      error: (issue) =>
        `${spell(issue.input)} is not an absolute URL (the shape is https://hooks.example.com/ci); GitHub refuses the hook otherwise`,
    }),
    content_type: z
      .enum(["json", "form"], {
        error: (issue) =>
          `${spell(issue.input)} is not a payload encoding GitHub accepts; use "json" or "form"`,
      })
      .optional(),
    secret: z.string().optional(),
    // Both spellings on purpose: GitHub takes either and stores the string, so the section's lens compares the string form.
    insecure_ssl: z
      .union([z.enum(["0", "1"]), z.literal(0), z.literal(1)], {
        error: (issue) =>
          `${spell(issue.input)} is not a value GitHub accepts; use "0" (verify the TLS certificate) or "1" (skip verification), as a string or a number`,
      })
      .optional(),
  })
  .catchall(z.unknown())
  .meta({ id: "WebhookDeliveryConfig" });

export const WebhookConfig = z
  .object({
    name: z.literal("web").optional(),
    config: WebhookDeliveryConfig,
    events: z.array(WebhookEvent).optional(),
    active: z.boolean().optional(),
  })
  .superRefine((entry, refineCtx) => {
    // An ENTRY-level secret would pass the loose shape, ship the raw reference text verbatim, and
    // create a silently unauthenticated hook, the exact failure this feature exists to prevent. The
    // strict type hides the key; only the loosen()ed shape that parses documents lets it reach here.
    if ((entry as Record<string, unknown>).secret !== undefined) {
      refineCtx.addIssue({
        code: "custom",
        path: ["secret"],
        message:
          "a webhook secret belongs under config.secret, not at the entry level; here it would pass through verbatim and the hook would be created without a working secret",
      });
    }
  })
  .meta({ id: "WebhookConfig" });
export type WebhookConfig = z.infer<typeof WebhookConfig>;
