/**
 * The failures the run returns instead of throwing: config parsing, settings
 * reading and validation, the layer fold, target resolution, and the flows'
 * fatal paths. One union, discriminated on `code`, and the one renderer that
 * words each member. A library caller branches on the code; the action
 * renders at its edge, so its lines stay exactly what they were.
 * Outside this union: the sections' API failures, which stay exceptions so
 * the permission policy can classify them.
 */

import { isPlainObject } from "./plain-data.js";
import type { SectionKey } from "./schema.js";

/**
 * The advice appended to a transient (non-permission) API failure: a network
 * blip or a 5xx that survived the retries. One source for the discovery
 * problems rendered here and multi.ts's remote-file read failure, so the "not
 * a permission problem" wording cannot drift between them.
 */
export const RERUN_ADVICE =
  "This is not a permission problem; re-run the workflow, and retry later if it persists";

/** Names as an error message lists them: each quoted, comma-separated. */
export function quoteList(names: readonly string[]): string {
  return names.map((name) => `"${name}"`).join(", ");
}

/** The run modes that read exactly one settings file. */
type EngineMode = "apply" | "check";

/** How a non-mapping settings document's top level reads, in typeof terms. */
export type TopLevelShape =
  | "list"
  | "null"
  | "undefined"
  | "boolean"
  | "number"
  | "bigint"
  | "string"
  | "symbol"
  | "function";

/** Which input named an unreadable settings file; each role's advice names its fix. */
export type SettingsFileRole = "settings-file" | "defaults-file" | "layer";

/** One repos-dir file the central resolution cannot turn into a target. */
export type CentralFileProblem =
  | { readonly kind: "not-a-slug"; readonly filePath: string; readonly slug: string }
  | {
      readonly kind: "duplicate";
      readonly slug: string;
      readonly first: string;
      readonly second: string;
    }
  | { readonly kind: "ownerless"; readonly files: readonly string[] };

/**
 * Every failure the run reports as data. The layer members carry only what
 * their prose needs: the prose fragments are literal unions, the positions are
 * numbers, and a document value enters only as `actual`, which the renderer
 * describes by SHAPE. `keyField` is the module's declared key field, never
 * read from a document.
 */
export type Problem =
  // Action inputs
  | {
      readonly code: "input-unsupported-value";
      readonly input: string;
      readonly value: string;
      readonly noun: string;
      readonly allowed: readonly string[];
      readonly fallback: string;
    }
  | {
      readonly code: "input-unknown-sections";
      readonly unknown: ReadonlyArray<{
        readonly input: "required-sections" | "sections";
        readonly names: readonly string[];
      }>;
      readonly known: readonly string[];
    }
  | { readonly code: "input-report-key-unused"; readonly channel: string }
  | { readonly code: "input-report-key-missing" }
  | { readonly code: "input-report-key-invalid"; readonly reason: string }
  | { readonly code: "input-rejected-in-merge"; readonly inputs: readonly string[] }
  | { readonly code: "input-merged-file-missing" }
  | { readonly code: "input-settings-file-empty"; readonly value: string }
  | {
      readonly code: "input-merge-only";
      readonly inputs: readonly string[];
      readonly mode: EngineMode;
    }
  | {
      readonly code: "input-snapshot-only";
      readonly inputs: readonly string[];
      readonly mode: EngineMode;
    }
  | { readonly code: "input-rejected-in-snapshot"; readonly inputs: readonly string[] }
  | { readonly code: "input-snapshot-destination-missing" }
  | { readonly code: "input-snapshot-destinations-both" }
  | { readonly code: "input-snapshot-file-with-multi" }
  | { readonly code: "input-repository-with-snapshot-dir" }
  | { readonly code: "input-snapshot-dir-without-targets" }
  | { readonly code: "input-token-missing" }
  | { readonly code: "input-report-without-redaction" }
  | {
      readonly code: "input-affiliation-unsupported";
      readonly entry: string;
      readonly allowed: readonly string[];
    }
  | { readonly code: "input-exclude-pattern-invalid"; readonly pattern: string }
  | { readonly code: "input-repository-with-multi" }
  | { readonly code: "input-settings-file-with-multi" }
  | {
      readonly code: "discovery-filters-without-wildcard";
      readonly filters: readonly string[];
      /** Where the run's targets come from instead of `repos: "*"`. */
      readonly targets: "single-repo" | "explicit-repos" | "repos-dir" | "snapshot-file";
    }
  | { readonly code: "input-defaults-file-without-multi" }
  | {
      readonly code: "input-settings-file-is-list";
      readonly value: string;
      readonly mode: EngineMode;
    }
  | { readonly code: "input-repository-not-slug"; readonly value: string }
  // The settings document
  | {
      readonly code: "settings-not-mapping";
      readonly source: string;
      readonly shape: TopLevelShape;
    }
  | { readonly code: "settings-not-plain-mapping"; readonly source: string }
  | {
      readonly code: "settings-unknown-sections";
      readonly source: string;
      readonly unknown: readonly string[];
      readonly known: readonly string[];
    }
  | {
      readonly code: "settings-malformed-sections";
      readonly source: string;
      readonly issues: readonly string[];
    }
  // Settings sources
  | { readonly code: "yaml-invalid"; readonly reason: string }
  | {
      readonly code: "settings-file-unreadable";
      readonly role: SettingsFileRole;
      readonly path: string;
      readonly reason: string;
    }
  // The layer boundary
  | { readonly code: "layer-cycle"; readonly layer: string; readonly site: string }
  | {
      readonly code: "layer-wrong-shape";
      readonly layer: string;
      readonly site: string;
      readonly expected: "a mapping" | "a list of mappings or an {_undeclared, entries} wrapper";
      readonly actual: unknown;
      readonly detail?: " without an entries list";
    }
  | {
      readonly code: "layer-bad-directive";
      readonly layer: string;
      readonly site: string;
      readonly actual: unknown;
    }
  | { readonly code: "layer-no-layering-key"; readonly layer: string; readonly site: string }
  | {
      readonly code: "layer-no-key";
      readonly layer: string;
      readonly site: string;
      readonly keyField: string;
    }
  | {
      readonly code: "layer-duplicate-key";
      readonly layer: string;
      readonly site: string;
      readonly keyField: string;
      readonly first: number;
      readonly second: number;
    }
  // The section selection
  | { readonly code: "required-sections-excluded"; readonly excluded: readonly SectionKey[] }
  // The run flows
  | { readonly code: "artifact-uploader-missing" }
  | {
      readonly code: "merged-file-is-layer";
      readonly mergedFile: string;
      /** The colliding layer's position in the settings-file list, from 0. */
      readonly index: number;
      readonly layer: string;
    }
  | { readonly code: "merged-file-unwritable"; readonly path: string; readonly reason: string }
  | {
      readonly code: "snapshot-file-is-settings-file";
      readonly snapshotFile: string;
      readonly settingsFile: string;
    }
  | {
      readonly code: "snapshot-dir-overlaps-repos-dir";
      readonly snapshotDir: string;
      readonly reposDir: string;
    }
  | { readonly code: "no-targets"; readonly filteredOut: number }
  // Target resolution
  | { readonly code: "repo-slug-invalid"; readonly value: string }
  | { readonly code: "repos-input-wildcard-mixed" }
  | {
      readonly code: "repos-input-invalid-entries";
      readonly invalid: readonly string[];
      readonly duplicated: readonly string[];
    }
  | { readonly code: "repos-dir-missing"; readonly reposDir: string }
  | { readonly code: "repos-dir-unreadable"; readonly reposDir: string; readonly reason: string }
  | {
      readonly code: "repos-dir-invalid-files";
      readonly reposDir: string;
      readonly files: readonly CentralFileProblem[];
    }
  | {
      readonly code: "discovery-request-failed";
      readonly path: string;
      readonly status: number;
      readonly message: string;
      /** True for a denial or an invalid token, where a user PAT is the fix. */
      readonly denied: boolean;
    }
  | { readonly code: "discovery-transport-failed"; readonly reason: string }
  | { readonly code: "discovery-response-not-a-list"; readonly path: string }
  // The private report
  | { readonly code: "age-recipient-invalid"; readonly reason: string };

/** The members with these codes, for a function's own error type. */
export type ProblemOf<C extends Problem["code"]> = Extract<Problem, { readonly code: C }>;

/** The layer boundary's members: what mergeLayers refuses. */
export type LayerProblem = Extract<Problem, { readonly code: `layer-${string}` }>;

/** The settings document's members: what validateSettingsDoc refuses (a file's read failure is not one). */
export type SettingsProblem = ProblemOf<
  | "settings-not-mapping"
  | "settings-not-plain-mapping"
  | "settings-unknown-sections"
  | "settings-malformed-sections"
>;

const PAT_ADVICE =
  "Discovery needs a user PAT; the workflow GITHUB_TOKEN and GitHub App installation tokens " +
  'cannot enumerate a user\'s repositories. List the target repositories explicitly in the "repos" input';

const PASSTHROUGH_ADVICE =
  "Fix these values in the settings file (only the named keys are validated; extra fields pass " +
  "through, except in closed sections and strict nested objects like actions.cache, which reject " +
  "unrecognized keys)";

function quote(value: unknown): string {
  return JSON.stringify(String(value));
}

/** A value's kind for refusal prose: what it is, not what it contains. */
function describeShape(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "a list";
  }
  if (isPlainObject(value)) {
    return "a mapping";
  }
  if (typeof value === "object") {
    return `a ${value.constructor?.name ?? "tagged"} value`;
  }
  return `a ${typeof value}`;
}

function describeCentralFile(file: CentralFileProblem): string {
  switch (file.kind) {
    case "not-a-slug":
      return `${file.filePath} resolves to the target "${file.slug}", which is not a valid owner/name slug. Rename the file so <owner> and <name> contain only letters, digits, dots, underscores, and dashes`;
    case "duplicate":
      return `duplicate target ${file.slug}: defined by both ${file.first} and ${file.second}. Keep exactly one settings file per repository`;
    case "ownerless":
      return `cannot resolve ${file.files.join(", ")}: top-level repos-dir files use the current repository's owner, which is unknown outside GitHub Actions. Use the <owner>/<name>.yml layout instead`;
  }
}

function describeUnreadable(problem: ProblemOf<"settings-file-unreadable">): string {
  switch (problem.role) {
    case "settings-file":
      return `cannot read settings from ${problem.path}: ${problem.reason}. Check that the file exists at that path (set the "settings-file" input if it lives elsewhere) and is valid YAML`;
    case "defaults-file":
      return `cannot read the defaults file ${problem.path}: ${problem.reason}. Check the "defaults-file" path and that the file is valid YAML`;
    case "layer":
      return `cannot read the settings layer ${problem.path}: ${problem.reason}. Check that every path in the "settings-file" input exists and is valid YAML`;
  }
}

function describeFiltersWithoutWildcard(
  problem: ProblemOf<"discovery-filters-without-wildcard">,
): string {
  const named = quoteList(problem.filters);
  switch (problem.targets) {
    case "single-repo":
      return `the discovery filter input(s) ${named} only apply to repos: "*" discovery, but this run is in single-repo mode. Set repos: "*" to discover repositories, or remove the filter input(s)`;
    case "explicit-repos":
      return `the discovery filter input(s) ${named} only apply when repos is "*", but the "repos" input lists explicit repositories. Set repos: "*", or remove the filter input(s)`;
    case "repos-dir":
      return `the discovery filter input(s) ${named} only apply to repos: "*" discovery, but targets come only from repos-dir files. Set repos: "*", or remove the filter input(s)`;
    case "snapshot-file":
      return `the discovery filter input(s) ${named} only apply to repos: "*" discovery, but this snapshot targets one repository. Set repos: "*" with snapshot-dir to discover repositories, or remove the filter input(s)`;
  }
}

function describeUnknownSectionInput(
  unknown: ProblemOf<"input-unknown-sections">["unknown"][number],
  known: readonly string[],
): string {
  const quoted = quoteList(unknown.names);
  return unknown.names.length === 1
    ? `unknown section ${quoted} in the "${unknown.input}" input; it matches none of: ${known.join(", ")}. Fix the name in the workflow's input list`
    : `unknown sections ${quoted} in the "${unknown.input}" input; each matches none of: ${known.join(", ")}. Fix the names in the workflow's input list`;
}

function describeInvalidReposEntries(problem: ProblemOf<"repos-input-invalid-entries">): string {
  const parts: string[] = [];
  if (problem.invalid.length > 0) {
    parts.push(
      `${quoteList(problem.invalid)} ` +
        `${problem.invalid.length === 1 ? "is not an owner/name slug" : "are not owner/name slugs"} ` +
        '(use values like "octocat/hello-world", comma- or newline-separated)',
    );
  }
  if (problem.duplicated.length > 0) {
    parts.push(
      `${quoteList(problem.duplicated)} ` +
        `${problem.duplicated.length === 1 ? "is" : "are"} listed more than once ` +
        "(keep exactly one entry per repository)",
    );
  }
  const count = problem.invalid.length + problem.duplicated.length;
  return `the "repos" input has ${count} invalid entr${count === 1 ? "y" : "ies"}: ${parts.join("; ")}. Or use "*" alone to discover repositories`;
}

/**
 * The ONE place a problem is worded. INVARIANT for the layer members: a
 * message names the layer as the layer list names it, the site's key path, and
 * the kind of problem - never a value from the document. mode: merge has no
 * private-repos redaction context, so a value echoed there (a label name, a
 * rule type, a mis-shaped section body) could land a private repository's
 * settings in a public log. `actual` reaches the prose only through
 * describeShape; the marker test in test/engine/layers.test.ts pins this.
 */
export function describeProblem(problem: Problem): string {
  switch (problem.code) {
    case "input-unsupported-value": {
      const values = problem.allowed.map((v) =>
        v === problem.fallback ? `"${v}" (default)` : `"${v}"`,
      );
      return `the "${problem.input}" input is "${problem.value}", which is not a supported ${problem.noun}. Set it to ${values.join(", ")}`;
    }
    case "input-unknown-sections":
      return problem.unknown
        .map((unknown) => describeUnknownSectionInput(unknown, problem.known))
        .join("; ");
    case "required-sections-excluded": {
      const one = problem.excluded.length === 1;
      const [noun, pronoun] = one ? ["entry", "it"] : ["entries", "them"];
      return (
        `the "required-sections" ${noun} ${quoteList(problem.excluded)} ${one ? "is" : "are"} ` +
        `excluded by the "sections" allowlist, so the run would pass without ever attempting ` +
        `${pronoun}. Add ${pronoun} to the "sections" input, or remove ${pronoun} from ` +
        `"required-sections"`
      );
    }
    case "input-report-key-unused":
      return `the "report-public-key" input only applies to private-report: artifact, but the channel is "${problem.channel}", so the key would never be used. Remove report-public-key, or set private-report: artifact`;
    case "input-report-key-missing":
      return (
        'private-report: artifact needs a "report-public-key" input: the age recipient every ' +
        'report is encrypted to. Generate a keypair with "age-keygen -o key.txt", keep key.txt ' +
        'secret, and set report-public-key to the printed "age1..." recipient (safe to commit)'
      );
    case "input-report-key-invalid":
      return `the "report-public-key" input is not a valid age recipient: ${problem.reason}. It must be an "age1..." public key from "age-keygen" (the recipient line, not the AGE-SECRET-KEY identity)`;
    case "input-rejected-in-merge":
      return (
        `the ${quoteList(problem.inputs)} input(s) do not apply to mode: merge, which only folds ` +
        "the settings-file layers into merged-file: it never targets a repository, calls the GitHub " +
        "API, delivers a report, or narrows the sections it writes. Remove the input(s), or move " +
        "them to the apply or check step that runs the merged document"
      );
    case "input-merged-file-missing":
      return 'mode: merge needs a "merged-file" input: the path the merged settings document is written to. Set it (for example .github/settings.merged.yml) and feed that path to a later apply or check step as its settings-file';
    case "input-settings-file-empty":
      return `the "settings-file" input is "${problem.value}", which lists no file. In mode: merge it is the ordered list of layers to fold, newline- or comma-separated, lowest first; name at least one settings file`;
    case "input-merge-only":
      return (
        `the ${quoteList(problem.inputs)} input(s) only apply to mode: merge, but this run is in ` +
        `${problem.mode} mode, so ${problem.inputs.length === 1 ? "it" : "they"} would never be ` +
        "used. Remove the input(s), or set mode: merge to fold settings files"
      );
    case "input-snapshot-only":
      return (
        `the ${quoteList(problem.inputs)} input(s) only apply to mode: snapshot, but this run is in ` +
        `${problem.mode} mode, so ${problem.inputs.length === 1 ? "it" : "they"} would never be ` +
        "used. Remove the input(s), or set mode: snapshot to write the live settings to a file"
      );
    case "input-rejected-in-snapshot":
      return (
        `the ${quoteList(problem.inputs)} input(s) do not apply to mode: snapshot, which only reads the ` +
        "target repositories' live settings into snapshot-file or snapshot-dir: it applies no " +
        "document, folds no layers, and delivers no report. Remove the input(s), or move them to " +
        "the apply, check, or merge step they belong to"
      );
    case "input-snapshot-destination-missing":
      return 'mode: snapshot needs exactly one of the "snapshot-file" input (one repository\'s settings written to that file) or the "snapshot-dir" input (one <owner>/<name>.yml per repos or repos-dir target under that directory). Set one of them';
    case "input-snapshot-destinations-both":
      return 'the "snapshot-file" and "snapshot-dir" inputs are both set, but a snapshot run writes one form: a single repository to snapshot-file, or one <owner>/<name>.yml per multi-repo target under snapshot-dir. Remove one of them';
    case "input-snapshot-file-with-multi":
      return 'the "snapshot-file" input writes one repository\'s snapshot, but "repos" or "repos-dir" names multi-repo targets. Set "snapshot-dir" to write one file per target, or remove the multi-repo inputs and name the repository with "repository"';
    case "input-repository-with-snapshot-dir":
      return 'the "repository" input cannot be combined with "snapshot-dir", which writes one file per "repos" or "repos-dir" target. Remove "repository", or set "snapshot-file" to snapshot one repository';
    case "input-snapshot-dir-without-targets":
      return 'the "snapshot-dir" input needs multi-repo targets: set "repos" (an owner/name list, or "*" to discover) or "repos-dir". To snapshot one repository, set "snapshot-file" instead';
    case "input-token-missing":
      return 'cannot call the GitHub API: no token was provided. Set the "token" input on the action step (or export GITHUB_TOKEN)';
    case "input-report-without-redaction":
      return 'the "private-report" input delivers reports only for redacted targets, but "private-repos" is "show", so nothing is redacted and no report would ever be sent. Set private-repos: redact, or set private-report: none';
    case "input-affiliation-unsupported":
      return `the "affiliation" input entry "${problem.entry}" is not a supported affiliation, so discovery cannot build the /user/repos query. Use a comma-separated list of ${quoteList(problem.allowed)}`;
    case "input-exclude-pattern-invalid":
      return (
        `the "exclude" input pattern "${problem.pattern}" can never match an owner/name repository: a ` +
        `pattern takes at most one "/", with a non-empty glob on each side of it. Use ` +
        `"<name-glob>" or "<owner-glob>/<name-glob>", where "*" matches any characters`
      );
    case "input-repository-with-multi":
      return 'the "repository" input cannot be combined with "repos" or "repos-dir"; multi-repo targets come from those inputs. Remove "repository", or remove the multi-repo inputs to stay in single-repo mode';
    case "input-settings-file-with-multi":
      return 'the "settings-file" input cannot be combined with "repos" or "repos-dir": central targets are read from repos-dir files and remote targets from each repository\'s own .github/settings.yml. Remove the settings-file override';
    case "discovery-filters-without-wildcard":
      return describeFiltersWithoutWildcard(problem);
    case "input-defaults-file-without-multi":
      return 'the "defaults-file" input only applies to multi-repo mode, but this run is in single-repo mode, so the defaults would never apply. Remove the input, or add "repos" or "repos-dir" to switch to multi-repo mode';
    case "input-settings-file-is-list":
      return (
        `the "settings-file" input is "${problem.value}", which contains a list separator: ` +
        `${problem.mode} mode reads exactly one settings file, and only mode: merge takes a ` +
        "newline- or comma-separated list. Name one file, or set mode: merge to fold the list into " +
        "one document"
      );
    case "input-repository-not-slug":
      return `cannot target a repository: "${problem.value}" is not an owner/name slug. Set the "repository" input (or GITHUB_REPOSITORY) to a value like "octocat/hello-world"`;
    case "settings-not-mapping":
      return `${problem.source} must be a YAML mapping of section names to settings, but its top level parsed as a ${problem.shape}. Rewrite the top level as "section: ..." keys`;
    case "settings-not-plain-mapping":
      return `${problem.source} must be a plain YAML mapping of section names to settings, but its top level parsed as another type (a YAML-tagged value like !!timestamp parses to a Date). Rewrite the top level as "section: ..." keys`;
    case "settings-unknown-sections":
      return `unknown top-level section(s) in ${problem.source}: ${problem.unknown.join(", ")} (known: ${problem.known.join(", ")}). Fix the typo, or prefix private keys with "_", or set the "sections" input to limit processing`;
    case "settings-malformed-sections":
      return `${problem.source} has malformed section entries: ${problem.issues.join("; ")}. ${PASSTHROUGH_ADVICE}`;
    case "yaml-invalid":
      return problem.reason;
    case "settings-file-unreadable":
      return describeUnreadable(problem);
    case "layer-cycle":
      return `${layerSite(problem)} contains a reference cycle (a YAML anchor that includes itself); layers must be trees`;
    case "layer-wrong-shape":
      return `${layerSite(problem)} must be ${problem.expected}; got ${describeShape(problem.actual)}${problem.detail ?? ""}`;
    case "layer-bad-directive":
      return `${layerSite(problem)} must be "merge" or "replace"; got ${describeShape(problem.actual)}${typeof problem.actual === "string" ? " that is neither" : ""}`;
    case "layer-no-layering-key":
      return `${layerSite(problem)} has no layering key, so it cannot be layered by "merge"; declare _layering: replace or drop the directive`;
    case "layer-no-key":
      return `${layerSite(problem)} carries no string ${quote(problem.keyField)}, which every entry needs to layer by`;
    case "layer-duplicate-key":
      return `${layerSite(problem)}[${problem.first}] and ${problem.site}[${problem.second}] both claim one ${problem.keyField}; each ${problem.keyField} belongs to one entry within a layer`;
    case "artifact-uploader-missing":
      return "private-report: artifact needs an artifact uploader, and none was supplied: the action supplies its own; a library caller passes one as the uploader argument, or picks another private-report channel";
    case "merged-file-is-layer":
      return (
        `the "merged-file" input "${problem.mergedFile}" is layer ${problem.index + 1} of the ` +
        `"settings-file" list ("${problem.layer}"): the merge would overwrite that layer with the ` +
        "folded document, and the next run would fold the merged document as a layer. Write the " +
        "merged document to a path outside the layer list"
      );
    case "merged-file-unwritable":
      return `cannot write the merged document to ${problem.path}: ${problem.reason}. Check that the "merged-file" input names a writable path`;
    case "snapshot-file-is-settings-file":
      return `the "snapshot-file" input "${problem.snapshotFile}" is the settings file apply and check read (${problem.settingsFile}): the snapshot would overwrite the document you author. Write it to another path and copy it over deliberately`;
    case "snapshot-dir-overlaps-repos-dir":
      return (
        `the "snapshot-dir" input "${problem.snapshotDir}" is, contains, or sits inside the "repos-dir" ` +
        `"${problem.reposDir}": the snapshots are written in the repos-dir layout, so they would ` +
        "overwrite the central settings files or be read back as central files. Write them to a " +
        "directory outside the repos-dir and copy them over deliberately"
      );
    case "no-targets":
      return problem.filteredOut > 0
        ? `multi-repo mode found no targets: repos: "*" discovery found ${problem.filteredOut} ` +
            `${problem.filteredOut === 1 ? "repository" : "repositories"}, but the discovery filters ` +
            `removed all of them (see the notices above). Relax the filter inputs, or add per-repo ` +
            `files to the repos-dir`
        : `multi-repo mode found no targets: repos-dir yielded no settings files and the "repos" input resolved to no repositories. Add per-repo files to the repos-dir, or list repositories in the "repos" input`;
    case "repo-slug-invalid":
      return `"${problem.value}" is not an owner/name repository slug (use a value like "octocat/hello-world")`;
    case "repos-input-wildcard-mixed":
      return 'the "repos" input mixes "*" with explicit repositories. Use "*" alone to discover every repository the token owns, or list the repositories without it';
    case "repos-input-invalid-entries":
      return describeInvalidReposEntries(problem);
    case "repos-dir-missing":
      return `repos-dir "${problem.reposDir}" does not exist in the workspace, so there are no central settings files to read. Add an actions/checkout step before this action, or fix the repos-dir path`;
    case "repos-dir-unreadable":
      return `cannot read repos-dir "${problem.reposDir}": ${problem.reason}. Check that it is a readable directory of settings files`;
    case "repos-dir-invalid-files":
      return `repos-dir "${problem.reposDir}" has ${problem.files.length} invalid settings file(s):\n- ${problem.files.map(describeCentralFile).join("\n- ")}`;
    case "discovery-request-failed":
      return `cannot discover repositories for repos: "*": GET ${problem.path} failed: ${problem.status} ${problem.message}. ${problem.denied ? PAT_ADVICE : RERUN_ADVICE}`;
    case "discovery-transport-failed":
      return `cannot discover repositories for repos: "*": ${problem.reason}. ${RERUN_ADVICE}`;
    case "discovery-response-not-a-list":
      return `cannot discover repositories for repos: "*": GET ${problem.path} returned a JSON value that is not a list, so the response cannot be paginated. ${RERUN_ADVICE}`;
    case "age-recipient-invalid":
      return `not a valid age recipient: ${problem.reason}`;
  }
}

/** The `layer "<name>": <site>` prefix every layer refusal opens with. */
function layerSite(problem: LayerProblem): string {
  return `layer ${quote(problem.layer)}: ${problem.site}`;
}
