import { describe, expect, test } from "bun:test";
import {
  repositoryWebhookVocabulary,
  type WebhooksDescriptor,
} from "../../.github/scripts/gen-webhook-events.js";

const REFERENCE = "https://docs.github.com/webhooks/webhook-events-and-payloads";

function hook(
  slug: string,
  scopes: readonly string[],
  overrides: Partial<NonNullable<WebhooksDescriptor["webhooks"][string]["post"]>> = {},
): WebhooksDescriptor["webhooks"][string] {
  return {
    post: {
      externalDocs: { url: `${REFERENCE}#${slug}` },
      "x-github": { subcategory: slug, "supported-webhook-types": scopes },
      ...overrides,
    },
  };
}

describe("the derivation", () => {
  test("keeps repository-scoped events once each across their actions, sorted, in wire spelling, and drops every other scope", () => {
    const doc: WebhooksDescriptor = {
      webhooks: {
        "sub-issues-parent-issue-added": hook("sub-issues", ["repository", "organization", "app"]),
        "sub-issues-parent-issue-removed": hook("sub-issues", [
          "repository",
          "organization",
          "app",
        ]),
        // Every hyphen becomes an underscore, not the first alone.
        "custom-property-values-updated": hook("custom-property-values", ["repository"]),
        push: hook("push", ["repository", "organization", "app"]),
        "installation-created": hook("installation", ["app"]),
        "projects-v2-created": hook("projects_v2", ["organization"]),
        sponsorship: hook("sponsorship", ["sponsors_listing"]),
      },
    };
    expect(repositoryWebhookVocabulary(doc)).toEqual({
      events: ["custom_property_values", "push", "sub_issues"],
      reference: REFERENCE,
    });
  });

  // A shape change in the descriptor refuses instead of skipping: a skipped entry would shorten the list and the parser
  // would start refusing an event GitHub still delivers.
  test.each<[label: string, doc: WebhooksDescriptor, message: string]>([
    [
      "an entry without supported-webhook-types",
      { webhooks: { push: hook("push", ["repository"], { "x-github": { subcategory: "push" } }) } },
      "webhooks.push.post.x-github.supported-webhook-types is missing",
    ],
    [
      "no repository-scoped webhook at all (a renamed scope would otherwise empty the list)",
      { webhooks: { push: hook("push", ["repo"]) } },
      'no webhook names "repository"',
    ],
  ])("refuses %s instead of rendering a shorter list", (_label, doc, message) => {
    expect(() => repositoryWebhookVocabulary(doc)).toThrow(message);
  });
});
