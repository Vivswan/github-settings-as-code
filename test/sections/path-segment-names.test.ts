/**
 * A declared name that becomes one URL path segment of a request. A URL resolves "." and ".." away, so a request for
 * /labels/.. would land on the repository route itself, and percent-encoding cannot prevent it: the name is refused
 * when the settings file is parsed. Parsed through each section's runtime shape, so a rule that survives here reaches the run.
 */

import { describe, expect, test } from "bun:test";
import { validateSectionShapes } from "../../src/engine/validate.js";

function verdict(doc: Record<string, unknown>): { ok: true } | { issues: readonly string[] } {
  return validateSectionShapes(doc, "settings.yml").match(
    () => ({ ok: true }) as const,
    (problem) => ({ issues: problem.issues }),
  );
}

/** Each key whose value is a path segment: the document declaring `name` there, and the refusal, key first. */
const SEGMENT_KEYS: ReadonlyArray<
  readonly [key: string, doc: (name: string) => Record<string, unknown>, refusal: string]
> = [
  [
    "labels[].name",
    (name) => ({ labels: [{ name }] }),
    'labels[0].name: the name of a label cannot be "." or "..": a URL path resolves either to another API route. Rename it on GitHub and here',
  ],
  [
    "labels[].new_name",
    (name) => ({ labels: [{ name: "bug", new_name: name }] }),
    'labels[0].new_name: the name of a label cannot be "." or "..": a URL path resolves either to another API route. Rename it on GitHub and here',
  ],
  [
    "collaborators[].username",
    (name) => ({ collaborators: [{ username: name, permission: "push" }] }),
    'collaborators[0].username: the username of a collaborator cannot be "." or "..": a URL path resolves either to another API route. Rename it on GitHub and here',
  ],
  [
    "environments[].name",
    (name) => ({ environments: [{ name }] }),
    'environments[0].name: the name of an environment cannot be "." or "..": a URL path resolves either to another API route. Rename it on GitHub and here',
  ],
  [
    "branches[].name",
    (name) => ({ branches: [{ name, protection: null }] }),
    'branches[0].name: the name of a branch cannot be "." or "..": a URL path resolves either to another API route. Rename it on GitHub and here',
  ],
];

describe("a declared name that is a dot segment never reaches the API path", () => {
  test.each(SEGMENT_KEYS)(
    '%s refuses "." and ".." at parse, naming the key and the fix',
    (_key, doc, refusal) => {
      expect([verdict(doc(".")), verdict(doc(".."))]).toEqual([
        { issues: [refusal] },
        { issues: [refusal] },
      ]);
    },
  );

  test.each(SEGMENT_KEYS)(
    '%s still parses every other name with dots: only a whole "." or ".." segment resolves away, and the rule must refuse nothing else',
    (_key, doc) => {
      expect(["...", ".github", "v1.2", "a..b", ".x."].map((name) => verdict(doc(name)))).toEqual(
        Array.from({ length: 5 }, () => ({ ok: true })),
      );
    },
  );
});
