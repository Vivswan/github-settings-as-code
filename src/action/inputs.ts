/**
 * GitHub Actions input reading and validation. parseConfig() reads every
 * input in a stable order, validates it (each error names the input and
 * the fix), and returns the typed RunConfig run() executes - so the
 * execution code never touches raw inputs.
 */

import { resolve } from "node:path";
import * as core from "@actions/core";
import {
  AFFILIATIONS,
  ARCHIVED_FILTERS,
  DEFAULT_DISCOVERY_FILTERS,
  type DiscoveryFilters,
  FORKS_FILTERS,
  VISIBILITY_FILTERS,
} from "../discovery/discover.js";
import { parseRepoSlug, type RepoRef } from "../discovery/targets.js";
import type { Layering } from "../engine/layers.js";
import { DEFAULT_API_VERSION } from "../github/api.js";
import { parseRecipient } from "../report/artifact-report.js";
import { SECTION_KEYS, type SectionKey } from "../schema.js";
import type { MustBeNever } from "../types.js";
import {
  DEFAULT_PRIVATE_REPORT,
  DEFAULT_PRIVATE_REPOS,
  PRIVATE_REPORT_CHANNELS,
  PRIVATE_REPOS_POLICIES,
  type PrivateReportChannel,
  type PrivateReposPolicy,
} from "./redact.js";

/**
 * Default settings-file path, and the sentinel the multi-repo guard
 * compares against: an unchanged value means the user did not override it,
 * so combining it with repos/repos-dir is rejected. Single source for the
 * action.yml `settings-file` default, this fallback, the override check,
 * and multi.ts's remote-path prose.
 */
export const DEFAULT_SETTINGS_FILE = ".github/settings.yml";

/**
 * One action input: its action.yml entry (description, default) and its
 * row in the generated Inputs table (summary, shown default) on the inputs
 * reference page, docs/reference/inputs.md. The runner applies the
 * defaults; parseConfig() falls back to them outside the runner.
 */
export interface InputDecl {
  /** The action.yml description; the generator folds it to width. */
  readonly description: string;
  /** The action.yml default, verbatim (an empty string means "unset"). */
  readonly default: string;
  /** The Inputs table's Meaning cell: the one-line gist. */
  readonly summary: string;
  /**
   * The Inputs table's Default cell when the raw default is not what a reader should
   * see: an expression, a prose fallback, or the effective value the code
   * supplies for an empty raw default (the discovery filters).
   */
  readonly shownDefault?: string;
}

/**
 * Every input parseConfig() reads, in the order the inputs reference page
 * and action.yml list them: the single source both are generated from
 * (bun run build:action-docs), so adding an input here is the whole declaration.
 */
export const INPUT_DECLS = {
  token: {
    description:
      "Token used for the API calls. Most sections need a fine-grained PAT with Administration read/write on the repository - the default GITHUB_TOKEN can never hold that permission.",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a workflow expression the runner resolves, not a JS template
    default: "${{ github.token }}",
    summary: "Token for the API calls (see [Token permissions](docs/reference/permissions.md))",
    shownDefault: "`github.token`",
  },
  repository: {
    description:
      "Target repository (owner/name). Defaults to the current repository. Single-repo mode only; cannot be combined with repos or repos-dir.",
    default: "",
    summary: "Target `owner/name` (single-repo mode only)",
    shownDefault: "current repo",
  },
  "settings-file": {
    description:
      "Path to the settings YAML file: exactly one in apply and check. In mode: merge, the ordered list of settings files to fold instead, newline- or comma-separated, lowest layer first. Newlines and commas are list separators in every mode, so a settings-file path can never contain a comma. Single-repo and merge modes only; multi-repo targets read repos-dir files or each repository's own .github/settings.yml, so overriding it alongside repos or repos-dir fails the run.",
    default: DEFAULT_SETTINGS_FILE,
    summary:
      "Settings file path (single-repo mode); in `mode: merge`, the ordered list of layers to fold, low to high",
  },
  mode: {
    description:
      "apply (mutate), check (report drift, exit 1 on any), or merge (fold the settings-file layers into one document written to merged-file, with no token and no GitHub API call; merge reads only settings-file, merged-file, and layering, ignores token, and rejects every other input set to a non-default value, since each controls an apply or check run). check makes no settings changes, though a private report may still be delivered.",
    default: "apply",
    summary:
      "`apply` mutates; `check` reports drift and exits 1 on any, making no settings changes (a private report may still be delivered); `merge` folds the settings-file layers into merged-file without touching GitHub",
  },
  "merged-file": {
    description:
      "mode: merge only, and required there: the path the merged settings document is written to (parent directories are created). The file holds exactly what apply would run: every section validated, each section that takes an undeclared policy in its policy-wrapper form with the policy made explicit, the other sections in their own shape, and private underscore keys and the _layering directives dropped. Feed it to a later apply or check step as its settings-file. Must not name one of the settings-file layers (the merge would overwrite it). Fails when set in apply or check.",
    default: "",
    summary:
      "`mode: merge` only (required there): where the merged document is written, exactly what `apply` would run",
  },
  "on-missing-permission": {
    description:
      "fail (default) or warn. Under warn, sections the token cannot access are skipped with a warning and the run stays green (partial success).",
    default: "fail",
    summary: "`warn` skips sections the token cannot access (partial success)",
  },
  "required-sections": {
    description:
      "Comma-separated section names that must fully apply even under on-missing-permission: " +
      'warn (minimum requirements). Every name must also be allowed by the "sections" input ' +
      "when that allowlist is set; a required section the allowlist excludes is rejected up " +
      "front, because the run could never attempt it.",
    default: "",
    summary: "Sections that must fully apply even under `warn`",
  },
  sections: {
    description:
      "Optional comma-separated allowlist of sections to process. apply and check only: mode: merge writes every section its layers declare, so the allowlist belongs on the step that runs the merged document and fails the merge when set.",
    default: "",
    summary:
      "Comma-separated allowlist of sections to process (apply and check only; rejected in `mode: merge`)",
    shownDefault: "(all declared)",
  },
  "api-version": {
    description:
      "X-GitHub-Api-Version header value. Override to opt into a newer REST API version before this action defaults to it.",
    default: DEFAULT_API_VERSION,
    summary: "`X-GitHub-Api-Version` header; override to opt into a newer REST API version",
  },
  repos: {
    description:
      "Multi-repo remote mode: comma- or newline-separated owner/name targets, each applied " +
      'from its own .github/settings.yml (default branch), or "*" alone to discover every ' +
      "repository the token's user owns, filterable via the visibility, archived, forks, " +
      "exclude, topics, and affiliation inputs. Combinable with repos-dir; a repos-dir file " +
      "for the same repository wins.",
    default: "",
    summary:
      "Multi-repo remote mode: `owner/name` list (comma/newline), or `*` to discover owned repos",
  },
  "repos-dir": {
    description:
      "Multi-repo central mode: a directory in the checked-out admin repository holding per-repo settings files - <name>.yml (same owner as this repository) or <owner>/<name>.yml. Requires actions/checkout.",
    default: "",
    summary: "Multi-repo central mode: directory of per-repo settings files in this repo",
  },
  "defaults-file": {
    description:
      "YAML settings document applied to every multi-repo target that has no settings file of " +
      "its own (a repos target without .github/settings.yml, which is otherwise skipped). A " +
      "target with its own file is applied as written; the defaults are never merged into it. " +
      'With repos: "*" every discovered repository without a settings file receives the ' +
      "defaults; run mode: check first. Multi-repo mode only; fails when set without repos or " +
      "repos-dir.",
    default: "",
    summary:
      "YAML applied to every multi-repo target without a settings file (multi-repo mode only)",
  },
  layering: {
    description:
      "mode: merge only: merge (default) or replace, the run-wide default for how the keyed list sections (labels, rulesets) combine with the layers below them; a layer's own _layering directive, at its top level or on a section's {entries} wrapper, overrides it per file or per section. Every other list is replaced by the higher layer's. Fails when set in apply or check.",
    default: "",
    summary:
      "`mode: merge` only: `merge` unions the keyed list sections (labels, rulesets) by key across layers, `replace` lets the higher layer's list win; a layer's `_layering` overrides it",
    shownDefault: "`merge`",
  },
  "private-repos": {
    description:
      "redact (default) or show. Under redact, private and internal targets are hidden from " +
      "this run's public logs, summary, and outputs: their slug becomes a \"private repository " +
      '#N" placeholder, live values and error bodies are replaced with "hidden (private ' +
      "repository)\", and each slug is registered with the runner's secret masker. A target " +
      "equal to GITHUB_REPOSITORY is never redacted. show reveals everything (today's " +
      "behavior); only use it when the run's logs are not publicly readable.",
    default: DEFAULT_PRIVATE_REPOS,
    summary:
      "`redact` hides private and internal targets from public logs, summary, and outputs; `show` reveals them",
  },
  "private-report": {
    description:
      "none (default), issue, issue-on-failure, or artifact. Delivers the full unredacted " +
      "report only for redacted targets the visibility probe proves private or internal (an " +
      "unknown visibility is redacted but excluded from delivery). Under issue, each such " +
      "target's report is delivered as a reused, marker-labelled issue on that target " +
      "repository itself (the one GitHub-private channel a public run has): the body is " +
      "replaced every run, and the issue is opened when the target fails or drifts and closed " +
      "when it is healthy. issue-on-failure is the quiet variant: a failing or drifting target " +
      "gets the same issue, but a healthy run only closes a still-open issue from a previous " +
      "failure and otherwise writes nothing - no issue ever appears on a repository that never " +
      "needed attention (though a declared labels section still creates the marker label, and " +
      "a manually-removed marker label defers the close: the next failing run reattaches it, " +
      "and the first healthy run after that closes the issue). Under artifact, those reports " +
      "are concatenated, age-encrypted to report-public-key, and uploaded as one workflow " +
      "artifact (settings-as-code-private-report) for readers who hold the key but no GitHub " +
      "access to the targets; the artifact channel needs the Actions artifact service, so on " +
      "GitHub Enterprise Server it warns and uploads nothing. Applies only to redacted " +
      "targets, so it is rejected alongside private-repos: show. Report delivery writes even " +
      "in mode: check, and its failure never changes the run's result.",
    default: DEFAULT_PRIVATE_REPORT,
    summary:
      "`issue` delivers each redacted target's full report to a reused issue on that target " +
      "repository; `issue-on-failure` writes that issue only when the target fails or drifts, " +
      "closing it once healthy; `artifact` uploads all reports as one age-encrypted workflow " +
      "artifact; rejected with `private-repos: show`",
  },
  "report-public-key": {
    description:
      'The age recipient (an "age1..." public key) the artifact channel encrypts every report ' +
      'to; safe to commit in the workflow. Generate a keypair with "age-keygen -o key.txt", ' +
      'keep key.txt secret, and decrypt a downloaded artifact with "age -d -i key.txt ' +
      'private-report.md.age". Required when private-report is artifact and rejected otherwise.',
    default: "",
    summary:
      "The `age1...` recipient the `artifact` channel encrypts reports to; required with `private-report: artifact`, rejected otherwise",
  },
  visibility: {
    description:
      'Keeps only repositories of this visibility in repos: "*" discovery. One of all (default), public, private, or internal; internal is matched client-side (Enterprise only). Fails if set without repos: "*".',
    default: "",
    summary: "Discovery-only: keep `public`, `private`, or `internal` repositories",
    shownDefault: `\`${DEFAULT_DISCOVERY_FILTERS.visibility}\``,
  },
  archived: {
    description:
      'Archived-repository policy for repos: "*" discovery. One of skip (default; settings writes fail on archived repositories), include, or only (mostly useful with mode: check). Fails if set without repos: "*".',
    default: "",
    summary: "Discovery-only: `skip`, `include`, or `only` archived repositories",
    shownDefault: `\`${DEFAULT_DISCOVERY_FILTERS.archived}\``,
  },
  forks: {
    description:
      'Fork policy for repos: "*" discovery. One of include (default), exclude, or only. Fails if set without repos: "*".',
    default: "",
    summary: "Discovery-only: `include`, `exclude`, or `only` forks",
    shownDefault: `\`${DEFAULT_DISCOVERY_FILTERS.forks}\``,
  },
  exclude: {
    description:
      'Comma- or newline-separated wildcard patterns removing repositories from repos: "*" ' +
      'discovery. "*" matches any characters; a pattern containing "/" matches the full ' +
      'owner/name, any other the name alone. Case-insensitive. Fails if set without repos: "*".',
    default: "",
    summary:
      "Discovery-only: `*` wildcard patterns (name, or `owner/name` if the pattern has a `/`) to drop",
  },
  topics: {
    description:
      'Comma- or newline-separated topics; repos: "*" discovery keeps only repositories carrying at least one of them. Unrelated to the topics settings section. Fails if set without repos: "*".',
    default: "",
    summary: "Discovery-only: keep repositories carrying at least one listed topic",
  },
  affiliation: {
    description:
      'Comma-separated affiliations for repos: "*" discovery, passed to the GitHub /user/repos ' +
      "listing. Any of owner, collaborator, organization_member; the list replaces the default " +
      "(owner), so use owner,collaborator to widen rather than move discovery. Fails if set " +
      'without repos: "*".',
    default: "",
    summary: "Discovery-only: `owner`, `collaborator`, `organization_member` (comma list)",
    shownDefault: `\`${DEFAULT_DISCOVERY_FILTERS.affiliation.join(",")}\``,
  },
} as const satisfies Record<string, InputDecl>;

type InputName = keyof typeof INPUT_DECLS;

function input(name: InputName): string {
  // @actions/core reads INPUT_<NAME> (uppercased, spaces to underscores -
  // dashes survive, e.g. `settings-file` -> INPUT_SETTINGS-FILE) and trims.
  return core.getInput(name);
}

/** The input, or its declared default when the step (or a local run) left it unset. */
function inputOrDefault(name: InputName): string {
  return input(name) || INPUT_DECLS[name].default;
}

/**
 * Every discovery-filter input name, the single source both the FilterInput
 * type and the discoveryFiltersSet scan derive from. `satisfies readonly
 * (keyof DiscoveryFilters)[]` pins each entry to a real filter field, and the
 * MustBeNever check below fails compilation if a DiscoveryFilters field is
 * ever added without a matching input name here - the same exhaustiveness
 * idiom SECTION_KEYS uses in schema.ts.
 */
export const FILTER_INPUTS = [
  "visibility",
  "archived",
  "forks",
  "exclude",
  "topics",
  "affiliation",
] as const satisfies readonly (keyof DiscoveryFilters)[];

/** A discovery filter input name, a subset of the declared inputs. */
type FilterInput = (typeof FILTER_INPUTS)[number];

/** Compile-time lockstep: a DiscoveryFilters field missing from FILTER_INPUTS fails here. */
type _UnlistedFilter = MustBeNever<Exclude<keyof DiscoveryFilters, FilterInput>>;

/**
 * Read an enum-valued input against the allowed list its type derives
 * from, so the type, the check, and the error message cannot drift apart.
 */
function readEnum<T extends string>(
  name: InputName,
  allowed: readonly T[],
  fallback: T,
  noun: string,
): T | { error: string } {
  const value = input(name) || fallback;
  if (!(allowed as readonly string[]).includes(value)) {
    const values = allowed.map((v) => (v === fallback ? `"${v}" (default)` : `"${v}"`));
    return {
      error: `the "${name}" input is "${value}", which is not a supported ${noun}. Set it to ${values.join(", ")}`,
    };
  }
  return value as T;
}

export function quoteList(names: string[]): string {
  return names.map((name) => `"${name}"`).join(", ");
}

/** What separates the entries of a list input; a single path can never contain one. */
const LIST_SEPARATOR = /[\n,]/;

/** A comma- or newline-separated list input, trimmed, empty entries dropped. */
function splitList(value: string): string[] {
  return value
    .split(LIST_SEPARATOR)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** The run kinds the `mode` input selects; apply and check run the engine, merge only folds files. */
const MODES = ["apply", "check", "merge"] as const;

/** The `layering` input's values, locked to the engine's Layering type. */
const LAYERINGS = ["merge", "replace"] as const satisfies readonly Layering[];
type _UnlistedLayering = MustBeNever<Exclude<Layering, (typeof LAYERINGS)[number]>>;

/**
 * The inputs only mode: merge reads. Their declared defaults are empty so
 * "explicitly set" is detectable, as with the discovery filters; apply and
 * check reject a set one instead of silently ignoring it.
 */
const MERGE_ONLY_INPUTS = ["merged-file", "layering"] as const satisfies readonly InputName[];

/**
 * The `required-sections` and `sections` inputs as validated key sets: every
 * unknown name in each is reported at once, against its own input name, and
 * a required section the allowlist excludes is rejected.
 */
function readSectionSets():
  | { requiredSections: Set<SectionKey>; onlySections: Set<SectionKey> }
  | { error: string } {
  const readSectionNames = (name: "required-sections" | "sections"): Set<string> =>
    new Set(splitList(input(name)));
  const requiredNames = readSectionNames("required-sections");
  const onlyNames = readSectionNames("sections");
  const knownSections = new Set<string>(SECTION_KEYS);
  const unknownIn = (names: Set<string>, inputName: string): string | null => {
    const unknown = [...names].filter((name) => !knownSections.has(name));
    if (unknown.length === 0) {
      return null;
    }
    const quoted = unknown.map((name) => `"${name}"`).join(", ");
    return unknown.length === 1
      ? `unknown section ${quoted} in the "${inputName}" input; it matches none of: ${SECTION_KEYS.join(", ")}. Fix the name in the workflow's input list`
      : `unknown sections ${quoted} in the "${inputName}" input; each matches none of: ${SECTION_KEYS.join(", ")}. Fix the names in the workflow's input list`;
  };
  const unknownSections = [
    unknownIn(requiredNames, "required-sections"),
    unknownIn(onlyNames, "sections"),
  ].filter((problem): problem is string => problem !== null);
  if (unknownSections.length > 0) {
    return { error: unknownSections.join("; ") };
  }
  // Past the rejection above every name is a known key, so the narrowed sets
  // are honest - the guard is the proof, not a cast.
  const isSectionKey = (name: string): name is SectionKey => knownSections.has(name);
  const requiredSections = new Set([...requiredNames].filter(isSectionKey));
  const onlySections = new Set([...onlyNames].filter(isSectionKey));
  // required-sections is a proof obligation ("this section must not be
  // skipped"), but a `sections` allowlist EXCLUDES sections from running at
  // all - the engine reports them "excluded" without attempting them - so a
  // required section outside a non-empty allowlist would let the run pass
  // green having proven nothing about it. Reject the contradiction up front.
  if (onlySections.size > 0) {
    const excluded = [...requiredSections].filter((name) => !onlySections.has(name));
    if (excluded.length > 0) {
      const quoted = quoteList(excluded);
      const [noun, pronoun] =
        excluded.length === 1 ? (["entry", "it"] as const) : (["entries", "them"] as const);
      return {
        error:
          `the "required-sections" ${noun} ${quoted} ${excluded.length === 1 ? "is" : "are"} ` +
          `excluded by the "sections" allowlist, so the run would pass without ever attempting ` +
          `${pronoun}. Add ${pronoun} to the "sections" input, or remove ${pronoun} from ` +
          `"required-sections"`,
      };
    }
  }
  return { requiredSections, onlySections };
}

/**
 * Resolve and validate the `report-public-key` input against the chosen
 * channel. The key is the age recipient the `artifact` channel encrypts to, so
 * it is required exactly when the channel is `artifact` and rejected otherwise
 * (a key set for `none`/`issue` would silently do nothing). A supplied key is
 * validated through the age library at parse time, so a malformed recipient
 * fails the run before any API work rather than at upload. Returns the trimmed
 * key (empty for the non-artifact channels) or a loud error.
 */
function resolveReportPublicKey(channel: PrivateReportChannel): string | { error: string } {
  const key = input("report-public-key");
  if (channel !== "artifact") {
    if (key) {
      return {
        error: `the "report-public-key" input only applies to private-report: artifact, but the channel is "${channel}", so the key would never be used. Remove report-public-key, or set private-report: artifact`,
      };
    }
    return "";
  }
  if (!key) {
    return {
      error:
        'private-report: artifact needs a "report-public-key" input: the age recipient every ' +
        'report is encrypted to. Generate a keypair with "age-keygen -o key.txt", keep key.txt ' +
        'secret, and set report-public-key to the printed "age1..." recipient (safe to commit)',
    };
  }
  const parsed = parseRecipient(key);
  if (!parsed.ok) {
    return {
      error: `the "report-public-key" input is not a valid age recipient: ${parsed.error}. It must be an "age1..." public key from "age-keygen" (the recipient line, not the AGE-SECRET-KEY identity)`,
    };
  }
  return key;
}

/** The inputs shared by the two engine modes (apply and check). */
interface CommonConfig {
  token: string;
  mode: "apply" | "check";
  onMissingPermission: "fail" | "warn";
  requiredSections: Set<SectionKey>;
  onlySections: Set<SectionKey>;
  apiVersion: string;
  /** Whether to hide private/internal targets from the public view. */
  privateRepos: PrivateReposPolicy;
  /** Where the full unredacted report for a redacted target is delivered. */
  privateReport: PrivateReportChannel;
  /**
   * The age recipient the `artifact` channel encrypts every report to. Empty
   * for the other channels (parse rejects a value supplied without the artifact
   * channel), a validated `age1...` recipient when the channel is `artifact`.
   */
  reportPublicKey: string;
  /**
   * The workflow's own repository (GITHUB_REPOSITORY), read once here so the
   * run flows stay env-free. A target equal to this slug is never redacted:
   * a repository operating on itself leaks nothing.
   */
  selfSlug: string;
  /**
   * Link to the workflow run, for the private report metadata. Built once here
   * from GITHUB_SERVER_URL/GITHUB_REPOSITORY/GITHUB_RUN_ID so the run flows stay
   * env-free; empty when those are unset (local runs), which the report tolerates.
   */
  runUrl: string;
}

/**
 * A mode: merge run: the layers to fold, low to high, and where the result
 * goes. No token, no API version, no target, no section allowlist: merge mode
 * never reaches GitHub and writes every section the layers declare, and the
 * type carries that (no field to read a token or an allowlist from).
 */
export interface MergeConfig {
  kind: "merge";
  settingsFiles: string[];
  mergedFile: string;
  layering: Layering;
}

/** Everything run() needs, already validated; `kind` picks the mode. */
export type RunConfig =
  | (CommonConfig &
      (
        | { kind: "single"; repo: RepoRef; settingsFile: string }
        | {
            kind: "multi";
            reposDir: string;
            reposInput: string;
            defaultsFile: string;
            adminOwner: string;
            discoveryFilters: DiscoveryFilters;
            /** Filter inputs the user explicitly set, for the misuse rejections. */
            discoveryFiltersSet: string[];
          }
      ))
  | MergeConfig;

/**
 * The inputs a mode: merge run reads, plus `token`, which it tolerates unread
 * (a workflow commonly sets it on every step). Every OTHER declared input is
 * an apply/check-time control - a target, the API, a report, the section
 * allowlist - so the merge rejects it unless it holds its declared default,
 * which the runner supplies whether or not the workflow set the input.
 * Derived from the declarations, so a future input is rejected here until it
 * is listed as one the merge reads.
 */
const MERGE_INPUTS = [
  "mode",
  "settings-file",
  "merged-file",
  "layering",
  "token",
] as const satisfies readonly InputName[];

/**
 * The inputs mode: merge rejects when set to a non-default value: every
 * declared input MERGE_INPUTS does not list. Exported so the layering guide's
 * table is pinned to the whole set.
 */
export const MERGE_REJECTED_INPUTS: readonly InputName[] = (
  Object.keys(INPUT_DECLS) as InputName[]
).filter((name) => !(MERGE_INPUTS as readonly string[]).includes(name));

/** Read and validate the mode: merge inputs; the first problem wins. */
function parseMergeConfig(): { config: MergeConfig } | { error: string } {
  const rejected = MERGE_REJECTED_INPUTS.filter((name) => {
    const value = input(name);
    return value !== "" && value !== INPUT_DECLS[name].default;
  });
  if (rejected.length > 0) {
    return {
      error: `the ${quoteList(rejected)} input(s) do not apply to mode: merge, which only folds the settings-file layers into merged-file: it never targets a repository, calls the GitHub API, delivers a report, or narrows the sections it writes. Remove the input(s), or move them to the apply or check step that runs the merged document`,
    };
  }
  const mergedFile = input("merged-file");
  if (!mergedFile) {
    return {
      error:
        'mode: merge needs a "merged-file" input: the path the merged settings document is written to. Set it (for example .github/settings.merged.yml) and feed that path to a later apply or check step as its settings-file',
    };
  }
  const layering = readEnum("layering", LAYERINGS, "merge", "layering");
  if (typeof layering !== "string") {
    return { error: layering.error };
  }
  const settingsFiles = splitList(inputOrDefault("settings-file"));
  if (settingsFiles.length === 0) {
    return {
      error: `the "settings-file" input is "${inputOrDefault("settings-file")}", which lists no file. In mode: merge it is the ordered list of layers to fold, newline- or comma-separated, lowest first; name at least one settings file`,
    };
  }
  // The merge reads every layer, then writes the folded document to
  // merged-file: a merged-file that names a layer would overwrite that layer,
  // and the next run would fold the merged document as if it were a layer.
  // Paths are compared resolved, so "./a.yml" and "a.yml" collide.
  const mergedPath = resolve(mergedFile);
  const collision = settingsFiles.findIndex((layer) => resolve(layer) === mergedPath);
  if (collision !== -1) {
    return {
      error: `the "merged-file" input "${mergedFile}" is layer ${collision + 1} of the "settings-file" list ("${settingsFiles[collision]}"): the merge would overwrite that layer with the folded document, and the next run would fold the merged document as a layer. Write the merged document to a path outside the layer list`,
    };
  }
  return { config: { kind: "merge", settingsFiles, mergedFile, layering } };
}

/** Read and validate every input; the first problem wins. */
export function parseConfig(): { config: RunConfig } | { error: string } {
  // The mode decides which inputs exist at all, so it is read before any of
  // them: a merge never needs the token the engine modes require first.
  const mode = readEnum("mode", MODES, INPUT_DECLS.mode.default, "mode");
  if (typeof mode !== "string") {
    return { error: mode.error };
  }
  if (mode === "merge") {
    return parseMergeConfig();
  }
  const mergeOnly = MERGE_ONLY_INPUTS.filter((name) => input(name) !== "");
  if (mergeOnly.length > 0) {
    return {
      error: `the ${quoteList(mergeOnly)} input(s) only apply to mode: merge, but this run is in ${mode} mode, so ${mergeOnly.length === 1 ? "it" : "they"} would never be used. Remove the input(s), or set mode: merge to fold settings files`,
    };
  }
  const token = input("token") || process.env.GITHUB_TOKEN || "";
  if (!token) {
    return {
      error:
        'cannot call the GitHub API: no token was provided. Set the "token" input on the action step (or export GITHUB_TOKEN)',
    };
  }
  // The workflow's own repository, read once and reused for the self slug, the
  // run URL, the central-mode admin owner, and the single-repo fallback target.
  const githubRepository = process.env.GITHUB_REPOSITORY ?? "";
  const onMissingPermission = readEnum(
    "on-missing-permission",
    ["fail", "warn"] as const,
    INPUT_DECLS["on-missing-permission"].default,
    "policy",
  );
  if (typeof onMissingPermission !== "string") {
    return { error: onMissingPermission.error };
  }
  const sets = readSectionSets();
  if ("error" in sets) {
    return { error: sets.error };
  }
  const { requiredSections, onlySections } = sets;
  const apiVersion = inputOrDefault("api-version");
  const privateRepos = readEnum(
    "private-repos",
    PRIVATE_REPOS_POLICIES,
    INPUT_DECLS["private-repos"].default,
    "private-repository policy",
  );
  if (typeof privateRepos !== "string") {
    return { error: privateRepos.error };
  }
  const privateReport = readEnum(
    "private-report",
    PRIVATE_REPORT_CHANNELS,
    INPUT_DECLS["private-report"].default,
    "private-report channel",
  );
  if (typeof privateReport !== "string") {
    return { error: privateReport.error };
  }
  // A report channel only ever runs for a REDACTED target, so combining it with
  // private-repos: show (which redacts nothing) would silently deliver no
  // report - a silent no-op violates the loud-failure promise, so reject it.
  if (privateReport !== "none" && privateRepos === "show") {
    return {
      error:
        'the "private-report" input delivers reports only for redacted targets, but "private-repos" is "show", so nothing is redacted and no report would ever be sent. Set private-repos: redact, or set private-report: none',
    };
  }
  const reportPublicKey = resolveReportPublicKey(privateReport);
  if (typeof reportPublicKey !== "string") {
    return { error: reportPublicKey.error };
  }
  const serverUrl = process.env.GITHUB_SERVER_URL ?? "";
  const runId = process.env.GITHUB_RUN_ID ?? "";
  const runUrl =
    serverUrl && githubRepository && runId
      ? `${serverUrl}/${githubRepository}/actions/runs/${runId}`
      : "";
  const common: CommonConfig = {
    token,
    mode,
    onMissingPermission,
    requiredSections,
    onlySections,
    apiVersion,
    privateRepos,
    privateReport,
    reportPublicKey,
    selfSlug: githubRepository,
    runUrl,
  };

  const discoveryFiltersSet = FILTER_INPUTS.filter((name) => input(name) !== "");
  const list = (name: FilterInput): string[] => splitList(input(name));
  const visibility = readEnum(
    "visibility",
    VISIBILITY_FILTERS,
    DEFAULT_DISCOVERY_FILTERS.visibility,
    "discovery filter",
  );
  if (typeof visibility !== "string") {
    return { error: visibility.error };
  }
  const archived = readEnum(
    "archived",
    ARCHIVED_FILTERS,
    DEFAULT_DISCOVERY_FILTERS.archived,
    "archived-repository policy",
  );
  if (typeof archived !== "string") {
    return { error: archived.error };
  }
  const forks = readEnum("forks", FORKS_FILTERS, DEFAULT_DISCOVERY_FILTERS.forks, "fork policy");
  if (typeof forks !== "string") {
    return { error: forks.error };
  }
  const affiliation = [...new Set(list("affiliation"))];
  for (const entry of affiliation) {
    if (!(AFFILIATIONS as readonly string[]).includes(entry)) {
      return {
        error: `the "affiliation" input entry "${entry}" is not a supported affiliation, so discovery cannot build the /user/repos query. Use a comma-separated list of ${AFFILIATIONS.map((a) => `"${a}"`).join(", ")}`,
      };
    }
  }
  const exclude = list("exclude");
  for (const pattern of exclude) {
    const parts = pattern.split("/");
    if (parts.length > 2 || (parts.length === 2 && (!parts[0] || !parts[1]))) {
      return {
        error:
          `the "exclude" input pattern "${pattern}" can never match an owner/name repository: a ` +
          `pattern takes at most one "/", with a non-empty glob on each side of it. Use ` +
          `"<name-glob>" or "<owner-glob>/<name-glob>", where "*" matches any characters`,
      };
    }
  }
  const discoveryFilters: DiscoveryFilters = {
    visibility,
    archived,
    forks,
    affiliation: affiliation.length > 0 ? affiliation : DEFAULT_DISCOVERY_FILTERS.affiliation,
    topics: list("topics").map((topic) => topic.toLowerCase()),
    exclude,
  };

  const reposInput = input("repos");
  const reposDir = input("repos-dir");
  const defaultsFile = input("defaults-file");
  const settingsFile = inputOrDefault("settings-file");

  if (reposInput || reposDir) {
    // Multi-repo mode: the single-repo inputs make no sense here.
    if (input("repository")) {
      return {
        error:
          'the "repository" input cannot be combined with "repos" or "repos-dir"; multi-repo targets come from those inputs. Remove "repository", or remove the multi-repo inputs to stay in single-repo mode',
      };
    }
    if (settingsFile !== DEFAULT_SETTINGS_FILE) {
      return {
        error:
          'the "settings-file" input cannot be combined with "repos" or "repos-dir": central targets are read from repos-dir files and remote targets from each repository\'s own .github/settings.yml. Remove the settings-file override',
      };
    }
    const adminOwner = githubRepository.split("/")[0] ?? "";
    return {
      config: {
        ...common,
        kind: "multi",
        reposDir,
        reposInput,
        defaultsFile,
        adminOwner,
        discoveryFilters,
        discoveryFiltersSet,
      },
    };
  }

  // Single-repo mode (unchanged legacy behavior).
  if (discoveryFiltersSet.length > 0) {
    return {
      error: `the discovery filter input(s) ${quoteList(discoveryFiltersSet)} only apply to repos: "*" discovery, but this run is in single-repo mode. Set repos: "*" to discover repositories, or remove the filter input(s)`,
    };
  }
  if (defaultsFile) {
    return {
      error:
        'the "defaults-file" input only applies to multi-repo mode, but this run is in single-repo mode, so the defaults would never apply. Remove the input, or add "repos" or "repos-dir" to switch to multi-repo mode',
    };
  }
  // Only a merge folds a list; the engine modes read exactly one file, so
  // even a stray separator ("only.yml,") is rejected rather than repaired.
  if (LIST_SEPARATOR.test(settingsFile)) {
    return {
      error: `the "settings-file" input is "${settingsFile}", which contains a list separator: ${mode} mode reads exactly one settings file, and only mode: merge takes a newline- or comma-separated list. Name one file, or set mode: merge to fold the list into one document`,
    };
  }
  const rawRepo = input("repository") || githubRepository;
  const repo = parseRepoSlug(rawRepo);
  if (repo === null) {
    return {
      error: `cannot target a repository: "${rawRepo}" is not an owner/name slug. Set the "repository" input (or GITHUB_REPOSITORY) to a value like "octocat/hello-world"`,
    };
  }
  return { config: { ...common, kind: "single", repo, settingsFile } };
}
