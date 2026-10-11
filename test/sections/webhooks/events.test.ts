import { describe, expect, test } from "bun:test";
import {
  REPOSITORY_WEBHOOK_EVENTS,
  WEBHOOK_EVENTS_REFERENCE,
} from "../../../src/sections/webhooks/events.js";

/**
 * Pins the committed event list to GitHub's webhooks OpenAPI description as @octokit/openapi-webhooks ships it. The
 * descriptor is too large to bundle, so src/ never imports it; this test recomputes the list from the package, and a
 * bump that adds or drops a repository event fails here naming the difference to apply to events.ts.
 */

/** The slice of the descriptor the derivation reads; the rest of each webhook entry is its payload schema. */
interface WebhooksDescriptor {
  readonly webhooks: Readonly<
    Record<
      string,
      {
        readonly post?: {
          readonly externalDocs?: { readonly url?: string };
          readonly "x-github"?: {
            readonly subcategory?: string;
            readonly "supported-webhook-types"?: readonly string[];
          };
        };
      }
    >
  >;
}

interface WebhookVocabulary {
  /** Sorted wire event names, without the "*" wildcard (the schema adds it). */
  readonly events: readonly string[];
  /** The reference pages the entries' externalDocs point at, minus their anchors; GitHub keeps them on one page. */
  readonly references: readonly string[];
  /** Entries lacking a field the derivation reads, as `hook.path`. A missing field is reported, not skipped: a
   * skipped entry would drop an event GitHub still delivers and the parser would start refusing a valid file. */
  readonly missing: readonly string[];
}

function repositoryWebhookVocabulary(doc: WebhooksDescriptor): WebhookVocabulary {
  const events = new Set<string>();
  const references = new Set<string>();
  const missing: string[] = [];
  for (const [hook, entry] of Object.entries(doc.webhooks)) {
    const github = entry.post?.["x-github"];
    const fields = {
      "post.x-github.supported-webhook-types": github?.["supported-webhook-types"],
      "post.x-github.subcategory": github?.subcategory,
      "post.externalDocs.url": entry.post?.externalDocs?.url,
    };
    for (const [path, value] of Object.entries(fields)) {
      if (value === undefined) {
        missing.push(`${hook}.${path}`);
      }
    }
    const scopes = fields["post.x-github.supported-webhook-types"];
    const slug = fields["post.x-github.subcategory"];
    const url = fields["post.externalDocs.url"];
    if (scopes === undefined || slug === undefined || url === undefined) {
      continue;
    }
    if (!scopes.includes("repository")) {
      continue;
    }
    // The subcategory is the docs slug (custom-property-values, issue-dependencies, sub-issues); the wire name GitHub
    // accepts on a hook and sends in X-GitHub-Event is snake_case, the same rewrite @octokit/webhooks applies.
    events.add(slug.replaceAll("-", "_"));
    references.add(url.split("#")[0] as string);
  }
  return { events: [...events].sort(), references: [...references].sort(), missing };
}

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
      references: [REFERENCE],
      missing: [],
    });
  });

  test("names each entry lacking a field it reads instead of skipping the entry", () => {
    const doc: WebhooksDescriptor = {
      webhooks: {
        push: hook("push", ["repository"], { "x-github": { subcategory: "push" } }),
        fork: hook("fork", ["repository"], { externalDocs: {} }),
      },
    };
    expect(repositoryWebhookVocabulary(doc).missing).toEqual([
      "push.post.x-github.supported-webhook-types",
      "fork.post.externalDocs.url",
    ]);
  });
});

describe("the committed list", () => {
  test("is the descriptor's repository events under its one reference page; a bump that moves it fails here with the names to apply to events.ts", async () => {
    // The one dot-com file of the eight the package ships; its index would load every GHES descriptor too.
    const module = await import("@octokit/openapi-webhooks/generated/api.github.com.json", {
      with: { type: "json" },
    });
    const vocabulary = repositoryWebhookVocabulary(module.default as WebhooksDescriptor);
    expect(vocabulary.missing).toEqual([]);
    expect(vocabulary.references).toEqual([WEBHOOK_EVENTS_REFERENCE]);
    expect<readonly string[]>(REPOSITORY_WEBHOOK_EVENTS).toEqual(vocabulary.events);
  });
});
