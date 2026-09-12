/**
 * The problem union's renderer: one specimen per member, each pinned to the
 * exact line the action prints for it. The specimen table is typed over every
 * code, so a new member fails compilation here until it has a specimen, and
 * describeProblem's switch fails until it has a case.
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

const KNOWN = SECTION_KEYS.join(", ");

const PASSTHROUGH =
  "Fix these values in the settings file (only the named keys are validated; extra fields pass " +
  "through, except in closed sections and strict nested objects like actions.cache, which reject " +
  "unrecognized keys)";

const RERUN =
  "This is not a permission problem; re-run the workflow, and retry later if it persists";

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
    `unknown section "nope" in the "required-sections" input; it matches none of: ${KNOWN}. Fix the name in the workflow's input list; ` +
      `unknown sections "typo", "nope" in the "sections" input; each matches none of: ${KNOWN}. Fix the names in the workflow's input list`,
  ],
  "required-sections-excluded": [
    { code: "required-sections-excluded", excluded: ["labels", "milestones"] },
    'the "required-sections" entries "labels", "milestones" are excluded by the "sections" allowlist, so the run would pass without ever attempting them. Add them to the "sections" input, or remove them from "required-sections"',
  ],
  "input-report-key-unused": [
    { code: "input-report-key-unused", channel: "issue" },
    'the "report-public-key" input only applies to private-report: artifact, but the channel is "issue", so the key would never be used. Remove report-public-key, or set private-report: artifact',
  ],
  "input-report-key-missing": [
    { code: "input-report-key-missing" },
    'private-report: artifact needs a "report-public-key" input: the age recipient every report ' +
      'is encrypted to. Generate a keypair with "age-keygen -o key.txt", keep key.txt secret, and ' +
      'set report-public-key to the printed "age1..." recipient (safe to commit)',
  ],
  "input-report-key-invalid": [
    { code: "input-report-key-invalid", reason: "invalid recipient" },
    'the "report-public-key" input is not a valid age recipient: invalid recipient. It must be an "age1..." public key from "age-keygen" (the recipient line, not the AGE-SECRET-KEY identity)',
  ],
  "input-rejected-in-merge": [
    { code: "input-rejected-in-merge", inputs: ["repos", "repos-dir"] },
    'the "repos", "repos-dir" input(s) do not apply to mode: merge, which only folds the ' +
      "settings-file layers into merged-file: it never targets a repository, calls the GitHub API, " +
      "delivers a report, or narrows the sections it writes. Remove the input(s), or move them to " +
      "the apply or check step that runs the merged document",
  ],
  "input-merged-file-missing": [
    { code: "input-merged-file-missing" },
    'mode: merge needs a "merged-file" input: the path the merged settings document is written to. Set it (for example .github/settings.merged.yml) and feed that path to a later apply or check step as its settings-file',
  ],
  "input-settings-file-empty": [
    { code: "input-settings-file-empty", value: "," },
    'the "settings-file" input is ",", which lists no file. In mode: merge it is the ordered list of layers to fold, newline- or comma-separated, lowest first; name at least one settings file',
  ],
  "input-merge-only": [
    { code: "input-merge-only", inputs: ["merged-file", "layering"], mode: "check" },
    'the "merged-file", "layering" input(s) only apply to mode: merge, but this run is in check mode, so they would never be used. Remove the input(s), or set mode: merge to fold settings files',
  ],
  "input-token-missing": [
    { code: "input-token-missing" },
    'cannot call the GitHub API: no token was provided. Set the "token" input on the action step (or export GITHUB_TOKEN)',
  ],
  "input-report-without-redaction": [
    { code: "input-report-without-redaction" },
    'the "private-report" input delivers reports only for redacted targets, but "private-repos" is "show", so nothing is redacted and no report would ever be sent. Set private-repos: redact, or set private-report: none',
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
  "input-repository-with-multi": [
    { code: "input-repository-with-multi" },
    'the "repository" input cannot be combined with "repos" or "repos-dir"; multi-repo targets come from those inputs. Remove "repository", or remove the multi-repo inputs to stay in single-repo mode',
  ],
  "input-settings-file-with-multi": [
    { code: "input-settings-file-with-multi" },
    'the "settings-file" input cannot be combined with "repos" or "repos-dir": central targets are read from repos-dir files and remote targets from each repository\'s own .github/settings.yml. Remove the settings-file override',
  ],
  "discovery-filters-without-wildcard": [
    { code: "discovery-filters-without-wildcard", filters: ["forks"], targets: "single-repo" },
    'the discovery filter input(s) "forks" only apply to repos: "*" discovery, but this run is in single-repo mode. Set repos: "*" to discover repositories, or remove the filter input(s)',
  ],
  "input-defaults-file-without-multi": [
    { code: "input-defaults-file-without-multi" },
    'the "defaults-file" input only applies to multi-repo mode, but this run is in single-repo mode, so the defaults would never apply. Remove the input, or add "repos" or "repos-dir" to switch to multi-repo mode',
  ],
  "input-settings-file-is-list": [
    { code: "input-settings-file-is-list", value: "a.yml,b.yml", mode: "apply" },
    'the "settings-file" input is "a.yml,b.yml", which contains a list separator: apply mode ' +
      "reads exactly one settings file, and only mode: merge takes a newline- or comma-separated " +
      "list. Name one file, or set mode: merge to fold the list into one document",
  ],
  "input-repository-not-slug": [
    { code: "input-repository-not-slug", value: "nope" },
    'cannot target a repository: "nope" is not an owner/name slug. Set the "repository" input (or GITHUB_REPOSITORY) to a value like "octocat/hello-world"',
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
    `unknown top-level section(s) in f.yml: labls (known: ${KNOWN}). Fix the typo, or prefix private keys with "_", or set the "sections" input to limit processing`,
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
  "artifact-uploader-missing": [
    { code: "artifact-uploader-missing" },
    "private-report: artifact needs an artifact uploader, and none was supplied: the action supplies its own; a library caller passes one as the uploader argument, or picks another private-report channel",
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
  "no-targets": [
    { code: "no-targets", filteredOut: 2 },
    'multi-repo mode found no targets: repos: "*" discovery found 2 repositories, but the discovery filters removed all of them (see the notices above). Relax the filter inputs, or add per-repo files to the repos-dir',
  ],
  "repo-slug-invalid": [
    { code: "repo-slug-invalid", value: "nope" },
    '"nope" is not an owner/name repository slug (use a value like "octocat/hello-world")',
  ],
  "repos-input-wildcard-mixed": [
    { code: "repos-input-wildcard-mixed" },
    'the "repos" input mixes "*" with explicit repositories. Use "*" alone to discover every repository the token owns, or list the repositories without it',
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
    'repos-dir "repos" has 3 invalid settings file(s):\n' +
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
} satisfies { [C in Problem["code"]]: [ProblemOf<C>, string] };

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
      "one merge-only input reads in the singular",
      { code: "input-merge-only", inputs: ["layering"], mode: "apply" },
      'the "layering" input(s) only apply to mode: merge, but this run is in apply mode, so it would never be used. Remove the input(s), or set mode: merge to fold settings files',
    ],
    [
      "filters beside an explicit repos list",
      {
        code: "discovery-filters-without-wildcard",
        filters: ["forks", "topics"],
        targets: "explicit-repos",
      },
      'the discovery filter input(s) "forks", "topics" only apply when repos is "*", but the "repos" input lists explicit repositories. Set repos: "*", or remove the filter input(s)',
    ],
    [
      "filters beside repos-dir targets only",
      { code: "discovery-filters-without-wildcard", filters: ["forks"], targets: "repos-dir" },
      'the discovery filter input(s) "forks" only apply to repos: "*" discovery, but targets come only from repos-dir files. Set repos: "*", or remove the filter input(s)',
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

describe("SettingsProblem", () => {
  test("names the four validation refusals and not a file's read failure", () => {
    const codes: SettingsProblem["code"][] = [
      "settings-not-mapping",
      "settings-not-plain-mapping",
      "settings-unknown-sections",
      "settings-malformed-sections",
    ];
    // @ts-expect-error a read failure shares the prefix but is not a validation problem
    const unreadable: SettingsProblem["code"] = "settings-file-unreadable";
    expect(codes).not.toContain(unreadable);
  });
});

describe("quoteList", () => {
  test("quotes each name and joins with commas", () => {
    expect(quoteList(["a", "b c"])).toBe('"a", "b c"');
    expect(quoteList([])).toBe("");
  });
});
