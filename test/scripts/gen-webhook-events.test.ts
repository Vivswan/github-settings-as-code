import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  EVENTS_PATH,
  readDescriptor,
  renderWebhookEvents,
  repositoryWebhookVocabulary,
  type WebhooksDescriptor,
} from "../../.github/scripts/gen-webhook-events.js";
import { ROOT } from "../root.js";

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

const committed = () => readFileSync(join(ROOT, EVENTS_PATH), "utf8");

describe("the committed webhook event vocabulary", () => {
  test("equals a fresh render from the installed @octokit/openapi-webhooks, so a package bump that changes GitHub's list fails here", async () => {
    expect(committed()).toBe(
      renderWebhookEvents(repositoryWebhookVocabulary(await readDescriptor())),
    );
  });

  test("a repository event the package gains and the file lacks fails the pin (the control on the pin above)", async () => {
    const doc = await readDescriptor();
    const grown: WebhooksDescriptor = {
      webhooks: { ...doc.webhooks, "fake-event-created": hook("fake-event", ["repository"]) },
    };
    const vocabulary = repositoryWebhookVocabulary(grown);
    expect(vocabulary.events).toContain("fake_event");
    expect(renderWebhookEvents(vocabulary)).not.toBe(committed());
  });

  test("carries the wire spellings of the events whose descriptor slug is hyphenated, and no hyphenated name", async () => {
    const { events } = repositoryWebhookVocabulary(await readDescriptor());
    expect(events).toEqual(
      expect.arrayContaining([
        "custom_property_values",
        "issue_dependencies",
        "sub_issues",
        "push",
        "ping",
      ]),
    );
    expect(events.filter((event) => event.includes("-") || event === "*")).toEqual([]);
  });
});

describe("the derivation", () => {
  test("keeps repository-scoped events once each across their actions, sorted, and drops every other scope", () => {
    const doc: WebhooksDescriptor = {
      webhooks: {
        "sub-issues-parent-issue-added": hook("sub-issues", ["repository", "organization", "app"]),
        "sub-issues-parent-issue-removed": hook("sub-issues", [
          "repository",
          "organization",
          "app",
        ]),
        push: hook("push", ["repository", "organization", "app"]),
        "installation-created": hook("installation", ["app"]),
        "projects-v2-created": hook("projects_v2", ["organization"]),
        sponsorship: hook("sponsorship", ["sponsors_listing"]),
      },
    };
    expect(repositoryWebhookVocabulary(doc)).toEqual({
      events: ["push", "sub_issues"],
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
