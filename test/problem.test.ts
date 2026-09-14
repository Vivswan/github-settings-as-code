/**
 * The problem union's renderer: one specimen per member that carries fields, each pinned to the exact line the action prints for it, so a
 * dropped or swapped interpolation and a wrong plural show up as the line a user would read. A member whose only field is its code renders
 * a constant, which is its own source of truth, so those members are pinned to render distinct lines instead of to their text: a case
 * copied from its neighbor, or one falling through to the next, renders a line written for another problem. Both tables are typed over
 * the union, so a new member fails compilation here until it is placed, and describeProblem's switch fails until it has a case.
 */

import { describe, expect, test } from "bun:test";
import {
  describeProblem,
  type Problem,
  type ProblemOf,
  quoteList,
  type SettingsProblem,
} from "../src/problem.js";
import { SECTION_KEYS } from "../src/schema.js";

/** The members whose only field is `code`. */
type FieldlessCode = {
  [C in Problem["code"]]: keyof ProblemOf<C> extends "code" ? C : never;
}[Problem["code"]];

const FIELDLESS: Record<FieldlessCode, true> = {
  "input-report-key-missing": true,
  "input-merged-file-missing": true,
  "input-snapshot-destination-missing": true,
  "input-snapshot-destinations-both": true,
  "input-snapshot-file-with-multi": true,
  "input-repository-with-snapshot-dir": true,
  "input-snapshot-dir-without-targets": true,
  "input-token-missing": true,
  "input-report-without-redaction": true,
  "input-repository-with-multi": true,
  "input-settings-file-with-multi": true,
  "input-defaults-file-without-multi": true,
  "input-artifact-unsupported": true,
  "repos-input-wildcard-mixed": true,
};

const KNOWN = SECTION_KEYS.join(", ");

const PASSTHROUGH =
  "Fix these values in the settings file (only the named keys are validated; extra fields pass " +
  "through, except in closed sections and strict nested objects like actions.cache, which reject " +
  "unrecognized keys)";

const RERUN = "This is not a permission problem; re-run, and retry later if it persists";

const PAT =
  "Discovery needs a user PAT; the workflow GITHUB_TOKEN and GitHub App installation tokens " +
  'cannot enumerate a user\'s repositories. List the target repositories explicitly in the "repos" input';

/** Every member once: its specimen and the line it renders to. */
const SPECIMENS = {
  "input-unsupported-value": [
    {
      code: "input-unsupported-value",
      input: "mode",
      value: "dry-run",
      noun: "mode",
      allowed: ["apply", "check", "merge"],
      fallback: "apply",
    },
    'the "mode" input is "dry-run", which is not a supported mode. Set it to "apply" (default), "check", "merge"',
  ],
  "input-unknown-sections": [
    {
      code: "input-unknown-sections",
      unknown: [
        { input: "required-sections", names: ["nope"] },
        { input: "sections", names: ["typo", "nope"] },
      ],
      known: SECTION_KEYS,
    },
    `unknown section "nope" in the "required-sections" input; it matches none of: ${KNOWN}. Fix the section name; ` +
      `unknown sections "typo", "nope" in the "sections" input; each matches none of: ${KNOWN}. Fix the section names`,
  ],
  "required-sections-excluded": [
    { code: "required-sections-excluded", excluded: ["labels", "milestones"] },
    'the "required-sections" entries "labels", "milestones" are excluded by the "sections" allowlist, so the run would pass without ever attempting them. Add them to the "sections" input, or remove them from "required-sections"',
  ],
  "input-report-key-unused": [
    { code: "input-report-key-unused", channel: "issue" },
    'the "report-public-key" input only applies to private-report: artifact, but the channel is "issue", so the key would never be used. Remove report-public-key, or set private-report: artifact',
  ],
  "input-report-key-invalid": [
    { code: "input-report-key-invalid", reason: "invalid recipient" },
    'the "report-public-key" input is not a valid age recipient: invalid recipient. It must be an "age1..." public key from "age-keygen" (the recipient line, not the AGE-SECRET-KEY identity)',
  ],
  "input-rejected-in-merge": [
    { code: "input-rejected-in-merge", inputs: ["repos", "repos-dir"] },
    'the "repos", "repos-dir" inputs do not apply to mode: merge, which only folds the ' +
      "settings-file layers into merged-file: it never targets a repository, calls the GitHub API, " +
      "delivers a report, or narrows the sections it writes. Remove the inputs, or move them to " +
      "the apply or check step that runs the merged document",
  ],
  "input-settings-file-empty": [
    { code: "input-settings-file-empty", value: "," },
    'the "settings-file" input is ",", which lists no file. In mode: merge it is the ordered list of layers to fold, newline- or comma-separated, lowest first; name at least one settings file',
  ],
  "input-merge-only": [
    { code: "input-merge-only", inputs: ["merged-file", "layering"], mode: "check" },
    'the "merged-file", "layering" inputs only apply to mode: merge, but this run is in check mode, so they would never be used. Remove the inputs, or set mode: merge to fold settings files',
  ],
  "input-snapshot-only": [
    { code: "input-snapshot-only", inputs: ["snapshot-file"], mode: "check" },
    'the "snapshot-file" input only applies to mode: snapshot, but this run is in check mode, so it would never be used. Remove the input, or set mode: snapshot to write the live settings to a file',
  ],
  "input-rejected-in-snapshot": [
    { code: "input-rejected-in-snapshot", inputs: ["settings-file", "layering"] },
    'the "settings-file", "layering" inputs do not apply to mode: snapshot, which only reads the ' +
      "target repositories' live settings into snapshot-file or snapshot-dir: it applies no " +
      "document, folds no layers, and delivers no report. Remove the inputs, or move them to " +
      "the apply, check, or merge step they belong to",
  ],
  "input-affiliation-unsupported": [
    {
      code: "input-affiliation-unsupported",
      entry: "member",
      allowed: ["owner", "collaborator", "organization_member"],
    },
    'the "affiliation" input entry "member" is not a supported affiliation, so discovery cannot build the /user/repos query. Use a comma-separated list of "owner", "collaborator", "organization_member"',
  ],
  "input-exclude-pattern-invalid": [
    { code: "input-exclude-pattern-invalid", pattern: "a/b/c" },
    'the "exclude" input pattern "a/b/c" can never match an owner/name repository: a pattern takes at most one "/", with a non-empty glob on each side of it. Use "<name-glob>" or "<owner-glob>/<name-glob>", where "*" matches any characters',
  ],
  "discovery-filters-without-wildcard": [
    { code: "discovery-filters-without-wildcard", filters: ["forks"], targets: "single-repo" },
    'the discovery filter input "forks" only applies to repos: "*" discovery, but this run is in single-repo mode. Set repos: "*" to discover repositories, or remove the filter input',
  ],
  "input-settings-file-is-list": [
    { code: "input-settings-file-is-list", value: "a.yml,b.yml", mode: "apply" },
    'the "settings-file" input is "a.yml,b.yml", which contains a list separator: apply mode ' +
      "reads exactly one settings file, and only mode: merge takes a newline- or comma-separated " +
      "list. Name one file, or set mode: merge to fold the list into one document",
  ],
  "input-repository-not-slug": [
    { code: "input-repository-not-slug", value: "nope" },
    'cannot target a repository: "nope" is not an owner/name slug. Set the "repository" input (--repository on the command line) to a value like "octocat/hello-world"; inside GitHub Actions, GITHUB_REPOSITORY supplies it',
  ],
  "settings-not-mapping": [
    { code: "settings-not-mapping", source: "f.yml", shape: "list" },
    'f.yml must be a YAML mapping of section names to settings, but its top level parsed as a list. Rewrite the top level as "section: ..." keys',
  ],
  "settings-not-plain-mapping": [
    { code: "settings-not-plain-mapping", source: "f.yml" },
    'f.yml must be a plain YAML mapping of section names to settings, but its top level parsed as another type (a YAML-tagged value like !!timestamp parses to a Date). Rewrite the top level as "section: ..." keys',
  ],
  "settings-unknown-sections": [
    { code: "settings-unknown-sections", source: "f.yml", unknown: ["labls"], known: SECTION_KEYS },
    `unknown top-level section in f.yml: labls (known: ${KNOWN}). Fix the typo, or set the "sections" input to limit processing`,
  ],
  "settings-unknown-directives": [
    { code: "settings-unknown-directives", source: "f.yml", unknown: ["_notes", "_layerin"] },
    "unknown underscore keys in f.yml: _notes, _layerin. The underscore marks this action's " +
      "directives, \"_layering\" (a file's top level or a list section's {entries} wrapper) and " +
      '"_undeclared" (a wrapper), and nothing else; there are no private-note keys. Remove the key, ' +
      "or keep the note as a YAML comment",
  ],
  "settings-malformed-sections": [
    {
      code: "settings-malformed-sections",
      source: "f.yml",
      issues: ["labels[0].new_name: Invalid input: expected string, received number", "pages: x"],
    },
    `f.yml has malformed section entries: labels[0].new_name: Invalid input: expected string, received number; pages: x. ${PASSTHROUGH}`,
  ],
  "yaml-invalid": [
    { code: "yaml-invalid", reason: "YAMLParseError: Flow sequence in block collection" },
    "YAMLParseError: Flow sequence in block collection",
  ],
  "settings-file-unreadable": [
    {
      code: "settings-file-unreadable",
      role: "settings-file",
      path: "missing.yml",
      reason: "ENOENT",
    },
    'cannot read settings from missing.yml: ENOENT. Check that the file exists at that path (set the "settings-file" input if it lives elsewhere) and is valid YAML',
  ],
  "layer-cycle": [
    { code: "layer-cycle", layer: "repo", site: "the document" },
    'layer "repo": the document contains a reference cycle (a YAML anchor that includes itself); layers must be trees',
  ],
  "layer-wrong-shape": [
    {
      code: "layer-wrong-shape",
      layer: "repo",
      site: "labels",
      expected: "a list of mappings or an {_undeclared, entries} wrapper",
      actual: { _undeclared: "keep" },
      detail: " without an entries list",
    },
    'layer "repo": labels must be a list of mappings or an {_undeclared, entries} wrapper; got a mapping without an entries list',
  ],
  "layer-bad-directive": [
    { code: "layer-bad-directive", layer: "repo", site: "labels._layering", actual: "union" },
    'layer "repo": labels._layering must be "merge" or "replace"; got a string that is neither',
  ],
  "layer-no-layering-key": [
    { code: "layer-no-layering-key", layer: "repo", site: "milestones" },
    'layer "repo": milestones has no layering key, so it cannot be layered by "merge"; declare _layering: replace or drop the directive',
  ],
  "layer-no-key": [
    { code: "layer-no-key", layer: "repo", site: "labels[1]", keyField: "name" },
    'layer "repo": labels[1] carries no string "name", which every entry needs to layer by',
  ],
  "layer-duplicate-key": [
    {
      code: "layer-duplicate-key",
      layer: "repo",
      site: "labels",
      keyField: "name",
      first: 0,
      second: 2,
    },
    'layer "repo": labels[0] and labels[2] both claim one name; each name belongs to one entry within a layer',
  ],
  "merged-file-is-layer": [
    { code: "merged-file-is-layer", mergedFile: "./repo.yml", index: 1, layer: "repo.yml" },
    'the "merged-file" input "./repo.yml" is layer 2 of the "settings-file" list ("repo.yml"): ' +
      "the merge would overwrite that layer with the folded document, and the next run would fold " +
      "the merged document as a layer. Write the merged document to a path outside the layer list",
  ],
  "merged-file-unwritable": [
    { code: "merged-file-unwritable", path: "out/merged.yml", reason: "EACCES" },
    'cannot write the merged document to out/merged.yml: EACCES. Check that the "merged-file" input names a writable path',
  ],
  "snapshot-file-is-settings-file": [
    {
      code: "snapshot-file-is-settings-file",
      snapshotFile: "./.github/settings.yml",
      settingsFile: ".github/settings.yml",
    },
    'the "snapshot-file" input "./.github/settings.yml" is the settings file apply and check read (.github/settings.yml): the snapshot would overwrite the document you author. Write it to another path and copy it over deliberately',
  ],
  "snapshot-dir-overlaps-repos-dir": [
    { code: "snapshot-dir-overlaps-repos-dir", snapshotDir: "central", reposDir: "central/acme" },
    'the "snapshot-dir" input "central" is, contains, or sits inside the "repos-dir" ' +
      '"central/acme": the snapshots are written in the repos-dir layout, so they would overwrite ' +
      "the central settings files or be read back as central files. Write them to a directory " +
      "outside the repos-dir and copy them over deliberately",
  ],
  "no-targets": [
    { code: "no-targets", filteredOut: 2 },
    'multi-repo mode found no targets: repos: "*" discovery found 2 repositories, but the discovery filters removed all of them (see the notices above). Relax the filter inputs, or add per-repo files to the repos-dir',
  ],
  "repo-slug-invalid": [
    { code: "repo-slug-invalid", value: "nope" },
    '"nope" is not an owner/name repository slug (use a value like "octocat/hello-world")',
  ],
  "repos-input-invalid-entries": [
    { code: "repos-input-invalid-entries", invalid: ["bad", "worse"], duplicated: ["O/A"] },
    'the "repos" input has 3 invalid entries: "bad", "worse" are not owner/name slugs (use values ' +
      'like "octocat/hello-world", comma- or newline-separated); "O/A" is listed more than once ' +
      '(keep exactly one entry per repository). Or use "*" alone to discover repositories',
  ],
  "repos-dir-missing": [
    { code: "repos-dir-missing", reposDir: "repos" },
    'repos-dir "repos" does not exist in the workspace, so there are no central settings files to read. Add an actions/checkout step before this action, or fix the repos-dir path',
  ],
  "repos-dir-unreadable": [
    { code: "repos-dir-unreadable", reposDir: "repos", reason: "EACCES" },
    'cannot read repos-dir "repos": EACCES. Check that it is a readable directory of settings files',
  ],
  "repos-dir-invalid-files": [
    {
      code: "repos-dir-invalid-files",
      reposDir: "repos",
      files: [
        { kind: "not-a-slug", filePath: "repos/o/a b.yml", slug: "o/a b" },
        { kind: "duplicate", slug: "o/x", first: "repos/o/x.yml", second: "repos/x.yml" },
        { kind: "ownerless", files: ["repos/api.yml", "repos/web.yml"] },
      ],
    },
    'repos-dir "repos" has 4 invalid settings files:\n' +
      '- repos/o/a b.yml resolves to the target "o/a b", which is not a valid owner/name slug. Rename the file so <owner> and <name> contain only letters, digits, dots, underscores, and dashes\n' +
      "- duplicate target o/x: defined by both repos/o/x.yml and repos/x.yml. Keep exactly one settings file per repository\n" +
      "- cannot resolve repos/api.yml, repos/web.yml: top-level repos-dir files use the current repository's owner, which is unknown outside GitHub Actions. Use the <owner>/<name>.yml layout instead",
  ],
  "discovery-request-failed": [
    {
      code: "discovery-request-failed",
      path: "/user/repos?affiliation=owner",
      status: 403,
      message: "Resource not accessible",
      denied: true,
    },
    `cannot discover repositories for repos: "*": GET /user/repos?affiliation=owner failed: 403 Resource not accessible. ${PAT}`,
  ],
  "discovery-transport-failed": [
    { code: "discovery-transport-failed", reason: "fetch failed" },
    `cannot discover repositories for repos: "*": fetch failed. ${RERUN}`,
  ],
  "discovery-response-not-a-list": [
    { code: "discovery-response-not-a-list", path: "/user/repos?affiliation=owner" },
    `cannot discover repositories for repos: "*": GET /user/repos?affiliation=owner returned a JSON value that is not a list, so the response cannot be paginated. ${RERUN}`,
  ],
  "age-recipient-invalid": [
    { code: "age-recipient-invalid", reason: "invalid recipient" },
    "not a valid age recipient: invalid recipient",
  ],
} satisfies { [C in Exclude<Problem["code"], FieldlessCode>]: [ProblemOf<C>, string] };

describe("describeProblem", () => {
  test.each(Object.entries(SPECIMENS))("renders %s", (_code, [problem, line]) => {
    expect(describeProblem(problem)).toBe(line);
  });

  test.each<[what: string, problem: Problem, line: string]>([
    [
      "one excluded required section reads in the singular",
      { code: "required-sections-excluded", excluded: ["labels"] },
      'the "required-sections" entry "labels" is excluded by the "sections" allowlist, so the run would pass without ever attempting it. Add it to the "sections" input, or remove it from "required-sections"',
    ],
    [
      "one rejected merge input reads in the singular",
      { code: "input-rejected-in-merge", inputs: ["repos"] },
      'the "repos" input does not apply to mode: merge, which only folds the settings-file layers into merged-file: it never targets a repository, ' +
        "calls the GitHub API, delivers a report, or narrows the sections it writes. Remove the input, or move it to the apply or check step that runs the merged document",
    ],
    [
      "two snapshot-only inputs read in the plural",
      { code: "input-snapshot-only", inputs: ["snapshot-file", "snapshot-dir"], mode: "check" },
      'the "snapshot-file", "snapshot-dir" inputs only apply to mode: snapshot, but this run is in check mode, so they would never be used. Remove the inputs, or set mode: snapshot to write the live settings to a file',
    ],
    [
      "one rejected snapshot input reads in the singular",
      { code: "input-rejected-in-snapshot", inputs: ["layering"] },
      'the "layering" input does not apply to mode: snapshot, which only reads the target repositories\' live settings into snapshot-file or snapshot-dir: ' +
        "it applies no document, folds no layers, and delivers no report. Remove the input, or move it to the apply, check, or merge step it belongs to",
    ],
    [
      "two filters beside a single-repo snapshot read in the plural",
      {
        code: "discovery-filters-without-wildcard",
        filters: ["forks", "topics"],
        targets: "snapshot-file",
      },
      'the discovery filter inputs "forks", "topics" only apply to repos: "*" discovery, but this snapshot targets one repository. Set repos: "*" with snapshot-dir to discover repositories, or remove the filter inputs',
    ],
    [
      "one filter beside a single-repo snapshot reads in the singular",
      { code: "discovery-filters-without-wildcard", filters: ["forks"], targets: "snapshot-file" },
      'the discovery filter input "forks" only applies to repos: "*" discovery, but this snapshot targets one repository. Set repos: "*" with snapshot-dir to discover repositories, or remove the filter input',
    ],
    [
      "two unknown sections read in the plural",
      {
        code: "settings-unknown-sections",
        source: "f.yml",
        unknown: ["labls", "rulesest"],
        known: SECTION_KEYS,
      },
      `unknown top-level sections in f.yml: labls, rulesest (known: ${KNOWN}). Fix the typo, or set the "sections" input to limit processing`,
    ],
    [
      "one unknown underscore key reads in the singular",
      { code: "settings-unknown-directives", source: "f.yml", unknown: ["_notes"] },
      "unknown underscore key in f.yml: _notes. The underscore marks this action's directives, " +
        '"_layering" (a file\'s top level or a list section\'s {entries} wrapper) and "_undeclared" (a wrapper), and nothing else; ' +
        "there are no private-note keys. Remove the key, or keep the note as a YAML comment",
    ],
    [
      "one invalid repos-dir file reads in the singular",
      {
        code: "repos-dir-invalid-files",
        reposDir: "repos",
        files: [{ kind: "not-a-slug", filePath: "repos/o/a b.yml", slug: "o/a b" }],
      },
      'repos-dir "repos" has 1 invalid settings file:\n- repos/o/a b.yml resolves to the target "o/a b", which is not a valid owner/name slug. Rename the file so <owner> and <name> contain only letters, digits, dots, underscores, and dashes',
    ],
    [
      "one merge-only input reads in the singular",
      { code: "input-merge-only", inputs: ["layering"], mode: "apply" },
      'the "layering" input only applies to mode: merge, but this run is in apply mode, so it would never be used. Remove the input, or set mode: merge to fold settings files',
    ],
    [
      "filters beside an explicit repos list",
      {
        code: "discovery-filters-without-wildcard",
        filters: ["forks", "topics"],
        targets: "explicit-repos",
      },
      'the discovery filter inputs "forks", "topics" only apply when repos is "*", but the "repos" input lists explicit repositories. Set repos: "*", or remove the filter inputs',
    ],
    [
      "filters beside repos-dir targets only",
      { code: "discovery-filters-without-wildcard", filters: ["forks"], targets: "repos-dir" },
      'the discovery filter input "forks" only applies to repos: "*" discovery, but targets come only from repos-dir files. Set repos: "*", or remove the filter input',
    ],
    [
      "a defaults file that cannot be read",
      { code: "settings-file-unreadable", role: "defaults-file", path: "d.yml", reason: "ENOENT" },
      'cannot read the defaults file d.yml: ENOENT. Check the "defaults-file" path and that the file is valid YAML',
    ],
    [
      "a layer that cannot be read",
      { code: "settings-file-unreadable", role: "layer", path: "fleet.yml", reason: "ENOENT" },
      'cannot read the settings layer fleet.yml: ENOENT. Check that every path in the "settings-file" input exists and is valid YAML',
    ],
    [
      "a central repos-dir file that cannot be read",
      {
        code: "settings-file-unreadable",
        role: "central-file",
        path: "repos/o/r.yml",
        reason: "EACCES",
      },
      "cannot read the central settings file repos/o/r.yml: EACCES. Fix the file, or delete it to stop managing this repository",
    ],
    [
      "init's settings-file spelled as a list",
      { code: "input-settings-file-is-list", value: "a.yml,b.yml", mode: "init" },
      'the "settings-file" input is "a.yml,b.yml", which contains a list separator: init writes exactly one settings file, and only mode: merge takes a newline- or comma-separated list. Name one file',
    ],
    [
      "no targets with nothing filtered",
      { code: "no-targets", filteredOut: 0 },
      'multi-repo mode found no targets: repos-dir yielded no settings files and the "repos" input resolved to no repositories. Add per-repo files to the repos-dir, or list repositories in the "repos" input',
    ],
    [
      "one filtered repository reads in the singular",
      { code: "no-targets", filteredOut: 1 },
      'multi-repo mode found no targets: repos: "*" discovery found 1 repository, but the discovery filters removed all of them (see the notices above). Relax the filter inputs, or add per-repo files to the repos-dir',
    ],
    [
      "one invalid repos entry reads in the singular",
      { code: "repos-input-invalid-entries", invalid: ["not-a-slug"], duplicated: [] },
      'the "repos" input has 1 invalid entry: "not-a-slug" is not an owner/name slug (use values like "octocat/hello-world", comma- or newline-separated). Or use "*" alone to discover repositories',
    ],
    [
      "two duplicated repos entries read in the plural",
      { code: "repos-input-invalid-entries", invalid: [], duplicated: ["o/a", "o/b"] },
      'the "repos" input has 2 invalid entries: "o/a", "o/b" are listed more than once (keep exactly one entry per repository). Or use "*" alone to discover repositories',
    ],
    [
      "a request failure that is not a denial gets re-run advice",
      {
        code: "discovery-request-failed",
        path: "/user/repos?affiliation=owner",
        status: 403,
        message: "API rate limit exceeded for user",
        denied: false,
      },
      `cannot discover repositories for repos: "*": GET /user/repos?affiliation=owner failed: 403 API rate limit exceeded for user. ${RERUN}`,
    ],
    [
      "a non-string directive is described by shape alone",
      { code: "layer-bad-directive", layer: "repo", site: "_layering", actual: true },
      'layer "repo": _layering must be "merge" or "replace"; got a boolean',
    ],
    [
      "a tagged value where a list belongs is described by its class",
      {
        code: "layer-wrong-shape",
        layer: "repo",
        site: "milestones",
        expected: "a list of mappings or an {_undeclared, entries} wrapper",
        actual: new Date(0),
      },
      'layer "repo": milestones must be a list of mappings or an {_undeclared, entries} wrapper; got a Date value',
    ],
  ])("renders the variant: %s", (_what, problem, line) => {
    expect(describeProblem(problem)).toBe(line);
  });
});

describe("the fieldless members", () => {
  test("each renders its own non-empty line, distinct from every other member's", () => {
    const fielded = new Set(Object.values(SPECIMENS).map(([, line]) => line));
    const seen = new Map<string, string>();
    for (const code of Object.keys(FIELDLESS) as FieldlessCode[]) {
      const line = describeProblem({ code });
      expect(line.trim(), code).not.toBe("");
      expect(fielded.has(line), `${code} renders a fielded member's line`).toBe(false);
      expect(seen.get(line), `${code} renders the same line as ${seen.get(line)}`).toBeUndefined();
      seen.set(line, code);
    }
  });
});

describe("SettingsProblem", () => {
  test("a file's read failure is not a validation problem", () => {
    // The library's validateSettings error type: widening it to a read failure would reach every consumer's exhaustive switch.
    // @ts-expect-error a read failure shares the prefix but is not a validation problem
    const unreadable: SettingsProblem["code"] = "settings-file-unreadable";
    void unreadable;
  });
});

describe("quoteList", () => {
  test("quotes each name and joins with commas", () => {
    expect(quoteList(["a", "b c"])).toBe('"a", "b c"');
    expect(quoteList([])).toBe("");
  });
});
