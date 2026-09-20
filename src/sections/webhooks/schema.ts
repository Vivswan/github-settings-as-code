/** The `webhooks:` section's schema slice; root src/schema.ts composes the SettingsFile property from it. */

import { z } from "zod";
import { GAP as WEBHOOK_EVENTS } from "../../upstream-gaps/webhook-events.js";

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

// GitHub 422s each of these at apply time ("is not a valid event", "Url is not a valid URL"); the wire types are
// bare strings, so the parser carries what GitHub documents and refuses the rest naming the fix.
const WebhookEvent = z.enum([...WEBHOOK_EVENTS.values, "*"] as const, {
  error: (issue) =>
    `${spell(issue.input)} is not a repository webhook event this release knows ("*" means every event); GitHub's list is ${WEBHOOK_EVENTS.reference}, and an event added there since is a new line in src/upstream-gaps/webhook-events.ts`,
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
