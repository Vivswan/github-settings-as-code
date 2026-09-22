/**
 * The refusals every list section shares, pinned once as the problem lines a user reads: a wrapper carrying a key
 * that is not one of its directives (with the pre-v3 policy spelling naming its rename), a section value that is
 * neither a list nor a wrapper, and a YAML-tagged value where a mapping section expects a plain mapping. The
 * wording lives in src/sections/shared/schema-helpers.ts, renamed-key.ts, and contract/module.ts.
 */

import { describe, expect, test } from "bun:test";
import { validateSectionShapes } from "../../src/engine/validate.js";
import { repositorySection } from "../../src/sections/repository/index.js";

function issues(doc: Record<string, unknown>): readonly string[] | null {
  return validateSectionShapes(doc, "settings.yml").match(
    () => null,
    (problem) => problem.issues,
  );
}

const KNOBBED_DIRECTIVES =
  'the wrapper\'s directives are "_undeclared" and, on a top-level section, "_layering", and nothing else - there are no private-note keys. Remove the key, or keep the note as a YAML comment';

const RENAMED =
  'the wrapper\'s policy key "undeclared" was renamed to "_undeclared" in v3 (a directive, like _layering) - write _undeclared: keep or _undeclared: delete';

describe("a list wrapper carrying a key outside its directives is refused at parse, naming the directives and the fix", () => {
  test.each<[what: string, doc: Record<string, unknown>, expected: string[]]>([
    [
      "a private note on a knobbed section's wrapper",
      { labels: { _notes: "owned by platform", entries: [{ name: "bug" }] } },
      [`labels: Unrecognized key: "_notes"; ${KNOBBED_DIRECTIVES}`],
    ],
    [
      "a private note beside a misspelled entries key: the clause names the underscore key it is about",
      { labels: { _notes: "owned by platform", entires: [], entries: [] } },
      [`labels: Unrecognized keys: "_notes", "entires"; "_notes": ${KNOBBED_DIRECTIVES}`],
    ],
    [
      "the pre-v3 policy spelling",
      { labels: { undeclared: "keep", entries: [] } },
      [`labels: Unrecognized key: "undeclared"; ${RENAMED}`],
    ],
    [
      "the pre-v3 policy spelling beside a private note: both fixes in one run",
      { labels: { undeclared: "keep", _owner: "platform", entries: [] } },
      [
        `labels: Unrecognized keys: "undeclared", "_owner"; ${RENAMED}; "_owner": ${KNOBBED_DIRECTIVES}`,
      ],
    ],
    [
      "a policy on a plain list's wrapper, which applies none",
      { branches: { _undeclared: "keep", entries: [] } },
      [
        'branches: Unrecognized key: "_undeclared"; the wrapper\'s directives are "_layering" alone ' +
          '(this section applies no undeclared policy, so its wrapper takes no "_undeclared"), and ' +
          "nothing else - there are no private-note keys. Remove the key, or keep the note as a YAML " +
          "comment",
      ],
    ],
    [
      "the layering directive on a nested list, which has no layers below it",
      { environments: [{ name: "prod", variables: { _layering: "deep", entries: [] } }] },
      [`environments[0].variables: Unrecognized key: "_layering"; ${KNOBBED_DIRECTIVES}`],
    ],
    [
      "a scalar where a knobbed section's list or wrapper goes",
      { labels: 5 },
      [
        'labels: Invalid input: expected a list of entries, or a mapping with "entries" (and an optional "_undeclared" policy), but this section parsed as number',
      ],
    ],
    [
      "a scalar where a plain list section's list or wrapper goes",
      { branches: "main" },
      [
        'branches: Invalid input: expected a list of entries, or a mapping with "entries" (and an optional "_layering" directive), but this section parsed as string',
      ],
    ],
  ])("%s", (_what, doc, expected) => {
    expect(issues(doc)).toEqual(expected);
  });

  test("both wrapper forms with their own directives parse", () => {
    expect(
      issues({
        labels: { _undeclared: "delete", _layering: "shallow", entries: [{ name: "bug" }] },
        branches: { _layering: "replace", entries: [] },
        environments: [{ name: "prod", variables: { _undeclared: "keep", entries: [] } }],
      }),
    ).toBeNull();
  });

  test("a mapping section's shape, parsed directly by a library caller, refuses a YAML-tagged value by name; the engine refuses it earlier with its own plainness line", () => {
    const parsed = repositorySection.shape.safeParse(new Date(0));
    expect(parsed.success ? [] : parsed.error.issues.map((issue) => issue.message)).toEqual([
      "Invalid input: expected a plain mapping (a YAML-tagged value like !!timestamp parses to another type)",
    ]);
  });
});
