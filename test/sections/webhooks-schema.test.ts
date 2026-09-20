import { describe, expect, test } from "bun:test";
import { ok } from "neverthrow";
import { validateSectionShapes } from "../../src/engine/validate.js";
import { WEBHOOK_EVENTS_REFERENCE } from "../../src/sections/webhooks/events.js";

/** The issue lines the run prints before exiting 1, or null when the document parses. */
function problems(webhooks: unknown): string[] | null {
  return validateSectionShapes({ webhooks }, "settings.yml").match(
    () => null,
    (problem) => [...problem.issues],
  );
}

const HOOK_URL = "https://hooks.example.com/ci";

const UNKNOWN_EVENT = (spelled: string) =>
  `${spelled} is not an event GitHub delivers to repository webhooks ("*" means every event); ` +
  `the accepted names are GitHub's list at ${WEBHOOK_EVENTS_REFERENCE}, read from @octokit/openapi-webhooks, ` +
  "so an event GitHub added since arrives in the release that bumps that package";
const INSECURE_SSL = (spelled: string) =>
  `${spelled} is not a value GitHub accepts; use "0" (verify the TLS certificate) or "1" (skip verification), as a string or a number`;

describe("webhooks values GitHub would refuse with 422 at apply time are refused at parse time", () => {
  test.each<[label: string, hook: Record<string, unknown>, expected: string]>([
    [
      "an event GitHub does not deliver to repository webhooks",
      { config: { url: HOOK_URL }, events: ["push", "pushes"] },
      `webhooks[0].events[1]: ${UNKNOWN_EVENT('"pushes"')}`,
    ],
    [
      "an event name that is not a string",
      { config: { url: HOOK_URL }, events: [7] },
      `webhooks[0].events[0]: ${UNKNOWN_EVENT("7")}`,
    ],
    [
      "a content type spelled as a MIME type",
      { config: { url: HOOK_URL, content_type: "application/json" } },
      'webhooks[0].config.content_type: "application/json" is not a payload encoding GitHub accepts; use "json" or "form"',
    ],
    [
      "an upper-case content type",
      { config: { url: HOOK_URL, content_type: "JSON" } },
      'webhooks[0].config.content_type: "JSON" is not a payload encoding GitHub accepts; use "json" or "form"',
    ],
    [
      "insecure_ssl as a boolean",
      { config: { url: HOOK_URL, insecure_ssl: true } },
      `webhooks[0].config.insecure_ssl: ${INSECURE_SSL("true")}`,
    ],
    [
      "insecure_ssl as a number other than 0 or 1",
      { config: { url: HOOK_URL, insecure_ssl: 2 } },
      `webhooks[0].config.insecure_ssl: ${INSECURE_SSL("2")}`,
    ],
    [
      "a url without a scheme",
      { config: { url: "hooks.example.com/ci" } },
      'webhooks[0].config.url: "hooks.example.com/ci" is not an absolute URL (the shape is https://hooks.example.com/ci); GitHub refuses the hook otherwise',
    ],
  ])("%s", (_label, hook, expected) => {
    expect(problems([hook])).toEqual([expected]);
  });

  test("every refused field of one entry is reported together, so the fix takes one run", () => {
    const hook = {
      config: { url: "hooks.example.com/ci", content_type: "JSON", insecure_ssl: true },
      events: ["pushes"],
    };
    expect(problems([hook])?.map((line) => line.slice(0, line.indexOf(":")))).toEqual([
      "webhooks[0].config.url",
      "webhooks[0].config.content_type",
      "webhooks[0].config.insecure_ssl",
      "webhooks[0].events[0]",
    ]);
  });

  test("a cyclic YAML alias in a refused field is described by kind, never serialized: JSON.stringify would throw and kill the run", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(
      problems([{ config: { url: cyclic, insecure_ssl: [cyclic] }, events: [cyclic] }]),
    ).toEqual([
      "webhooks[0].config.url: a mapping is not an absolute URL (the shape is https://hooks.example.com/ci); GitHub refuses the hook otherwise",
      `webhooks[0].config.insecure_ssl: ${INSECURE_SSL("a list")}`,
      `webhooks[0].events[0]: ${UNKNOWN_EVENT("a mapping")}`,
    ]);
  });
});

describe("every spelling GitHub accepts parses", () => {
  test.each<[label: string, hook: Record<string, unknown>]>([
    [
      "events GitHub delivers to repositories, old and recent",
      { config: { url: HOOK_URL }, events: ["push", "pull_request", "workflow_run", "sub_issues"] },
    ],
    ["the every-event wildcard", { config: { url: HOOK_URL }, events: ["*"] }],
    ["json payloads", { config: { url: HOOK_URL, content_type: "json" } }],
    ["form payloads", { config: { url: HOOK_URL, content_type: "form" } }],
    ["insecure_ssl as the string GitHub stores", { config: { url: HOOK_URL, insecure_ssl: "0" } }],
    [
      "insecure_ssl as the number GitHub also takes",
      { config: { url: HOOK_URL, insecure_ssl: 1 } },
    ],
    ["a plain http url with a port", { config: { url: "http://hooks.example.com:8080/ci" } }],
  ])("%s", (_label, hook) => {
    expect(problems([hook])).toBeNull();
  });

  test("an unknown config key survives the parse (a stripping shape would also parse, so success alone proves nothing)", () => {
    const webhooks = [{ config: { url: HOOK_URL, future_flag: "x" } }];
    expect(validateSectionShapes({ webhooks }, "settings.yml")).toEqual(ok({ webhooks }));
  });
});
