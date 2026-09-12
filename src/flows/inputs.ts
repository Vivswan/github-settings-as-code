/**
 * parseConfig() validates every input read through a caller-supplied port (each problem names the input and the fix)
 * into the RunConfig the run executes, so no execution code touches a raw input and a CLI reads the same declarations
 * the action does.
 */

import { err, ok, type Result, safeTry } from "neverthrow";
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
import { SectionSelection } from "../engine/section-selection.js";
import { DEFAULT_API_VERSION } from "../github/api.js";
import type { Problem } from "../problem.js";
import { parseRecipient } from "../report/artifact-report.js";
import { PRIVATE_REPORT_CHANNELS, type PrivateReportChannel } from "../report/delivery.js";
import { SECTION_KEYS, type SectionKey } from "../schema.js";
import type { MustBeNever } from "../types.js";
import type { RunFlowConfig } from "./deliver.js";
import type { MergeConfig } from "./merge.js";
import { DEFAULT_SETTINGS_FILE, type MultiConfig } from "./multi.js";
import { PRIVATE_REPOS_POLICIES, type PrivateReposPolicy } from "./redact.js";
import type { SingleConfig } from "./single.js";
import type { SnapshotConfig } from "./snapshot.js";

/** Default `private-repos`, pinned against action.yml by the contract test. */
export const DEFAULT_PRIVATE_REPOS = "redact" satisfies PrivateReposPolicy;

/** Default `private-report`, pinned against action.yml by the contract test. */
const DEFAULT_PRIVATE_REPORT = "none" satisfies PrivateReportChannel;

/**
 * One input's action.yml entry and its row in the generated Inputs table on docs/reference/inputs.md. The runner
 * applies the defaults; parseConfig() falls back to them outside the runner.
 */
export interface InputDecl {
  /** The action.yml description; the generator folds it to width. */
  readonly description: string;
  /** The action.yml default, verbatim (an empty string means "unset"). */
  readonly default: string;
  /** The Inputs table's Meaning cell: the one-line gist. */
  readonly summary: string;
  /**
   * The Inputs table's Default cell when the raw default is not what a reader should see: an expression, a prose
   * fallback, or the effective value for an empty raw default.
   */
  readonly shownDefault?: string;
  /**
   * A comma- or newline-separated list. parseConfig reads such an input only
   * through its list() port (repos is split by the target resolver instead),
   * and the CLI lets the flag repeat; a single-value input has no `list`.
   */
  readonly list?: true;
}

/**
 * The single source the inputs reference page and action.yml are generated from (bun run build:action-docs), in their
 * listing order; adding an input here is the whole declaration. A new mode's inputs go beside their mode's.
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
      "Path to the settings YAML file: exactly one in apply and check. In mode: merge, the ordered " +
      "list of settings files to fold instead, newline- or comma-separated, lowest layer first. " +
      "Newlines and commas are list separators in every mode, so a settings-file path can never " +
      "contain a comma. Single-repo and merge modes only; multi-repo targets read repos-dir files " +
      "or each repository's own .github/settings.yml, so overriding it alongside repos or " +
      "repos-dir fails the run.",
    default: DEFAULT_SETTINGS_FILE,
    summary:
      "Settings file path (single-repo mode); in `mode: merge`, the ordered list of layers to fold, low to high",
    list: true,
  },
  mode: {
    description:
      "apply (mutate), check (report drift, exit 1 on any), merge (fold the settings-file layers " +
      "into one document written to merged-file, with no token and no GitHub API call; merge reads " +
      "only settings-file, merged-file, and layering, ignores token, and rejects every other input " +
      "set to a non-default value, since each controls an apply or check run), or snapshot (read " +
      "the live settings of the target repositories back and write each as a settings document to " +
      "snapshot-file or under snapshot-dir; nothing is written to GitHub, the document reaches only " +
      "the file, and every input that controls an apply, a check, or a merge is rejected). check " +
      "makes no settings changes, though a private report may still be delivered.",
    default: "apply",
    summary:
      "`apply` mutates; `check` reports drift and exits 1 on any, making no settings changes (a " +
      "private report may still be delivered); `merge` folds the settings-file layers into " +
      "merged-file without touching GitHub; `snapshot` writes the live settings to snapshot-file " +
      "or snapshot-dir",
  },
  "merged-file": {
    description:
      "mode: merge only, and required there: the path the merged settings document is written to " +
      "(parent directories are created). The file holds exactly what apply would run: every " +
      "section validated, each section that takes an undeclared policy in its policy-wrapper form " +
      "with the policy made explicit, the other sections in their own shape, and private " +
      "underscore keys and the _layering directives dropped. Feed it to a later apply or check " +
      "step as its settings-file. Must not name one of the settings-file layers (the merge would " +
      "overwrite it). Fails when set in apply or check.",
    default: "",
    summary:
      "`mode: merge` only (required there): where the merged document is written, exactly what `apply` would run",
  },
  "snapshot-file": {
    description:
      "mode: snapshot only, and exactly one of snapshot-file and snapshot-dir is required there: " +
      "the path one repository's live settings are written to as a settings document (parent " +
      "directories are created). The target is the repository input, defaulting to the current " +
      "repository, so it cannot be combined with repos or repos-dir. The header pins the schema, " +
      "names the repository and the moment, and lists every section note; secret values GitHub " +
      "never reveals become $NAME references to export before an apply. Must not be " +
      ".github/settings.yml, the file apply and check read: the snapshot would overwrite the " +
      "document you author, so write it beside that file and copy it over deliberately. Fails " +
      "when set in apply, check, or merge.",
    default: "",
    summary:
      "`mode: snapshot` only (one of the two required there): where one repository's live settings are written as a settings document",
  },
  "snapshot-dir": {
    description:
      "mode: snapshot only, and exactly one of snapshot-file and snapshot-dir is required there: " +
      "the directory the multi-repo targets' live settings are written under, one " +
      "<owner>/<name>.yml per target (the repos-dir layout, so the directory can later serve as a " +
      "repos-dir). The targets come from repos and repos-dir exactly as in a multi-repo apply, " +
      "discovery filters included; defaults-file does not apply. Must be disjoint from the " +
      "repos-dir (not the same directory, not above it, not below it): the snapshots would " +
      "overwrite the central files or be read back as central files. Fails when set in apply, " +
      "check, or merge.",
    default: "",
    summary:
      "`mode: snapshot` only (one of the two required there): directory receiving one `<owner>/<name>.yml` per multi-repo target",
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
    list: true,
  },
  sections: {
    description:
      "Optional comma-separated allowlist of sections to process. apply, check, and snapshot only: mode: merge writes every section its layers declare, so the allowlist belongs on the step that runs the merged document and fails the merge when set.",
    default: "",
    summary:
      "Comma-separated allowlist of sections to process (apply, check, and snapshot; rejected in `mode: merge`)",
    shownDefault: "(all declared)",
    list: true,
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
    list: true,
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
      "mode: merge only: merge (default) or replace, the run-wide default for how the keyed list " +
      "sections (labels, rulesets) combine with the layers below them; a layer's own _layering " +
      "directive, at its top level or on a section's {entries} wrapper, overrides it per file or " +
      "per section. Every other list is replaced by the higher layer's. Fails when set in apply " +
      "or check.",
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
    list: true,
  },
  topics: {
    description:
      'Comma- or newline-separated topics; repos: "*" discovery keeps only repositories carrying at least one of them. Unrelated to the topics settings section. Fails if set without repos: "*".',
    default: "",
    summary: "Discovery-only: keep repositories carrying at least one listed topic",
    list: true,
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
    list: true,
  },
} as const satisfies Record<string, InputDecl>;

export type InputName = keyof typeof INPUT_DECLS;

/** The inputs declared `list: true`, the only names the list() port accepts. */
type ListInput = {
  [K in InputName]: (typeof INPUT_DECLS)[K] extends { readonly list: true } ? K : never;
}[InputName];

/** Empty when unset; parseConfig trims, so a port need not. */
export type InputReader = (name: InputName) => string;

/**
 * process.env's shape; a caller outside Actions passes what it has, or nothing.
 *   GITHUB_TOKEN                       -> the token fallback
 *   GITHUB_REPOSITORY                  -> the workflow's own repository
 *   GITHUB_SERVER_URL, GITHUB_RUN_ID   -> the run URL
 */
export type ConfigEnv = Readonly<Record<string, string | undefined>>;

interface Inputs {
  readonly value: InputReader;
  readonly orDefault: (name: InputName) => string;
  /** A declared list input, split; the default when unset. */
  readonly list: (name: ListInput) => string[];
}

function inputs(read: InputReader): Inputs {
  // The runner's getInput trims; a CLI's port may not. Trimming here gives every port one rule.
  const value: InputReader = (name) => read(name).trim();
  const orDefault = (name: InputName): string => value(name) || INPUT_DECLS[name].default;
  return { value, orDefault, list: (name) => splitList(orDefault(name)) };
}

export const FILTER_INPUTS = [
  "visibility",
  "archived",
  "forks",
  "exclude",
  "topics",
  "affiliation",
] as const satisfies readonly (keyof DiscoveryFilters)[];

type FilterInput = (typeof FILTER_INPUTS)[number];

type _UnlistedFilter = MustBeNever<Exclude<keyof DiscoveryFilters, FilterInput>>;

function readEnum<T extends string>(
  input: Inputs,
  name: InputName,
  allowed: readonly T[],
  fallback: T,
  noun: string,
): Result<T, Problem> {
  const value = input.value(name) || fallback;
  const match = allowed.find((candidate) => candidate === value);
  if (match === undefined) {
    return err({ code: "input-unsupported-value", input: name, value, noun, allowed, fallback });
  }
  return ok(match);
}

/** What separates the entries of a list input; a single path can never contain one. */
const LIST_SEPARATOR = /[\n,]/;

function splitList(value: string): string[] {
  return value
    .split(LIST_SEPARATOR)
    .map((s) => s.trim())
    .filter(Boolean);
}

export const MODES = ["apply", "check", "merge", "snapshot"] as const;

export type Mode = (typeof MODES)[number];

const LAYERINGS = ["merge", "replace"] as const satisfies readonly Layering[];
type _UnlistedLayering = MustBeNever<Exclude<Layering, (typeof LAYERINGS)[number]>>;

/**
 * Their declared defaults are empty so "explicitly set" is detectable, as with the discovery filters; apply and check
 * reject a set one instead of silently ignoring it.
 */
export const MERGE_ONLY_INPUTS = [
  "merged-file",
  "layering",
] as const satisfies readonly InputName[];
export const SNAPSHOT_ONLY_INPUTS = [
  "snapshot-file",
  "snapshot-dir",
] as const satisfies readonly InputName[];

function readSectionSelection(input: Inputs): Result<SectionSelection, Problem> {
  const sectionInputs = ["required-sections", "sections"] as const;
  const names = sectionInputs.map((name) => ({
    input: name,
    names: input.list(name),
  }));
  const knownSections = new Set<string>(SECTION_KEYS);
  const unknown = names
    .map(({ input: name, names: listed }) => ({
      input: name,
      names: [...new Set(listed)].filter((entry) => !knownSections.has(entry)),
    }))
    .filter((entry) => entry.names.length > 0);
  if (unknown.length > 0) {
    return err({ code: "input-unknown-sections", unknown, known: SECTION_KEYS });
  }
  const isSectionKey = (name: string): name is SectionKey => knownSections.has(name);
  const [required = [], only = []] = names.map((entry) => entry.names.filter(isSectionKey));
  return SectionSelection.of({ only, required });
}

/**
 * The key is required exactly when the channel is `artifact` and rejected otherwise (set for another channel it would
 * silently do nothing); it is parsed through the age library here so a malformed recipient fails before any API work.
 */
function resolveReportPublicKey(
  input: Inputs,
  channel: PrivateReportChannel,
): Result<string, Problem> {
  const key = input.value("report-public-key");
  if (channel !== "artifact") {
    return key ? err({ code: "input-report-key-unused", channel }) : ok("");
  }
  if (!key) {
    return err({ code: "input-report-key-missing" });
  }
  return parseRecipient(key)
    .map(() => key)
    .mapErr((invalid) => ({ code: "input-report-key-invalid", reason: invalid.reason }));
}

/** selfSlug (GITHUB_REPOSITORY) and runUrl are read from the environment once here, so the run flows stay env-free. */
interface CommonConfig extends RunFlowConfig {
  token: string;
  apiVersion: string;
}

export type RunConfig =
  | (CommonConfig & (({ kind: "single" } & SingleConfig) | ({ kind: "multi" } & MultiConfig)))
  | ({ kind: "merge" } & MergeConfig)
  | ({ kind: "snapshot" } & Pick<CommonConfig, "token" | "apiVersion"> & SnapshotConfig);

/**
 * `token` is tolerated unread (a workflow commonly sets it on every step). Every declared input NOT listed here is an
 * apply/check control, so the merge rejects it unless it holds its declared default, which the runner supplies whether
 * or not the workflow set the input.
 */
export const MERGE_INPUTS = [
  "mode",
  "settings-file",
  "merged-file",
  "layering",
  "token",
] as const satisfies readonly InputName[];

/**
 * Derived from the declarations, so a future input is rejected by the merge until listed in MERGE_INPUTS; exported so
 * the layering guide's table is pinned to the whole set.
 */
export const MERGE_REJECTED_INPUTS: readonly InputName[] = (
  Object.keys(INPUT_DECLS) as InputName[]
).filter((name) => !(MERGE_INPUTS as readonly string[]).includes(name));

function parseMergeConfig(input: Inputs): Result<Extract<RunConfig, { kind: "merge" }>, Problem> {
  return safeTry(function* () {
    const rejected = MERGE_REJECTED_INPUTS.filter((name) => {
      const value = input.value(name);
      return value !== "" && value !== INPUT_DECLS[name].default;
    });
    if (rejected.length > 0) {
      return err({ code: "input-rejected-in-merge", inputs: rejected });
    }
    const mergedFile = input.value("merged-file");
    if (!mergedFile) {
      return err({ code: "input-merged-file-missing" });
    }
    const layering = yield* readEnum(input, "layering", LAYERINGS, "merge", "layering");
    const settingsFiles = input.list("settings-file");
    if (settingsFiles.length === 0) {
      return err({
        code: "input-settings-file-empty",
        value: input.orDefault("settings-file"),
      });
    }
    return ok({ kind: "merge", settingsFiles, mergedFile, layering });
  });
}

/** The token the API modes call with: the input, else the environment's. */
function readToken(input: Inputs, env: ConfigEnv): Result<string, Problem> {
  const token = input.value("token") || env.GITHUB_TOKEN || "";
  return token ? ok(token) : err({ code: "input-token-missing" });
}

/** The policies every API mode reads, each validated against its own vocabulary. */
function readPolicies(input: Inputs): Result<
  {
    onMissingPermission: "fail" | "warn";
    sections: SectionSelection;
    privateRepos: PrivateReposPolicy;
  },
  Problem
> {
  return safeTry(function* () {
    const onMissingPermission = yield* readEnum(
      input,
      "on-missing-permission",
      ["fail", "warn"] as const,
      INPUT_DECLS["on-missing-permission"].default,
      "policy",
    );
    const sections = yield* readSectionSelection(input);
    const privateRepos = yield* readEnum(
      input,
      "private-repos",
      PRIVATE_REPOS_POLICIES,
      INPUT_DECLS["private-repos"].default,
      "private-repository policy",
    );
    return ok({ onMissingPermission, sections, privateRepos });
  });
}

/** The validated filters plus the names the workflow set explicitly, which the misuse rejections name. */
function readDiscoveryFilters(
  input: Inputs,
): Result<{ discoveryFilters: DiscoveryFilters; discoveryFiltersSet: string[] }, Problem> {
  return safeTry(function* () {
    const discoveryFiltersSet = FILTER_INPUTS.filter((name) => input.value(name) !== "");
    const visibility = yield* readEnum(
      input,
      "visibility",
      VISIBILITY_FILTERS,
      DEFAULT_DISCOVERY_FILTERS.visibility,
      "discovery filter",
    );
    const archived = yield* readEnum(
      input,
      "archived",
      ARCHIVED_FILTERS,
      DEFAULT_DISCOVERY_FILTERS.archived,
      "archived-repository policy",
    );
    const forks = yield* readEnum(
      input,
      "forks",
      FORKS_FILTERS,
      DEFAULT_DISCOVERY_FILTERS.forks,
      "fork policy",
    );
    const affiliation = [...new Set(input.list("affiliation"))];
    const unsupported = affiliation.find(
      (entry) => !(AFFILIATIONS as readonly string[]).includes(entry),
    );
    if (unsupported !== undefined) {
      return err({
        code: "input-affiliation-unsupported",
        entry: unsupported,
        allowed: AFFILIATIONS,
      });
    }
    const exclude = input.list("exclude");
    const unmatchable = exclude.find((pattern) => {
      const parts = pattern.split("/");
      return parts.length > 2 || (parts.length === 2 && (!parts[0] || !parts[1]));
    });
    if (unmatchable !== undefined) {
      return err({ code: "input-exclude-pattern-invalid", pattern: unmatchable });
    }
    const discoveryFilters: DiscoveryFilters = {
      visibility,
      archived,
      forks,
      affiliation: affiliation.length > 0 ? affiliation : DEFAULT_DISCOVERY_FILTERS.affiliation,
      topics: input.list("topics").map((topic) => topic.toLowerCase()),
      exclude,
    };
    return ok({ discoveryFilters, discoveryFiltersSet });
  });
}

/** The single-repo target: the repository input, else the workflow's own repository. */
function readSingleTarget(input: Inputs, githubRepository: string): Result<RepoRef, Problem> {
  const rawRepo = input.value("repository") || githubRepository;
  return parseRepoSlug(rawRepo).mapErr(
    (): Problem => ({ code: "input-repository-not-slug", value: rawRepo }),
  );
}

/**
 * Every declared input NOT listed here is an apply, check, or merge control, so the snapshot rejects it unless it
 * holds its declared default, which the runner supplies whether or not the workflow set the input.
 */
export const SNAPSHOT_INPUTS = [
  "token",
  "repository",
  "mode",
  "snapshot-file",
  "snapshot-dir",
  "on-missing-permission",
  "sections",
  "api-version",
  "repos",
  "repos-dir",
  "private-repos",
  ...FILTER_INPUTS,
] as const satisfies readonly InputName[];

/**
 * Derived from the declarations, so a future input is rejected by the snapshot until listed in SNAPSHOT_INPUTS;
 * exported so the snapshot guide's table is pinned to the whole set.
 */
export const SNAPSHOT_REJECTED_INPUTS: readonly InputName[] = (
  Object.keys(INPUT_DECLS) as InputName[]
).filter((name) => !(SNAPSHOT_INPUTS as readonly string[]).includes(name));

/** Read and validate the mode: snapshot inputs; the first problem wins. */
function parseSnapshotConfig(
  input: Inputs,
  env: ConfigEnv,
): Result<Extract<RunConfig, { kind: "snapshot" }>, Problem> {
  return safeTry(function* () {
    const rejected = SNAPSHOT_REJECTED_INPUTS.filter((name) => {
      const value = input.value(name);
      return value !== "" && value !== INPUT_DECLS[name].default;
    });
    if (rejected.length > 0) {
      return err({ code: "input-rejected-in-snapshot", inputs: rejected });
    }
    const snapshotFile = input.value("snapshot-file");
    const snapshotDir = input.value("snapshot-dir");
    if (snapshotFile && snapshotDir) {
      return err({ code: "input-snapshot-destinations-both" });
    }
    if (!snapshotFile && !snapshotDir) {
      return err({ code: "input-snapshot-destination-missing" });
    }
    const token = yield* readToken(input, env);
    const githubRepository = env.GITHUB_REPOSITORY ?? "";
    const policies = yield* readPolicies(input);
    const filters = yield* readDiscoveryFilters(input);
    const base = {
      kind: "snapshot" as const,
      token,
      apiVersion: input.orDefault("api-version"),
      onMissingPermission: policies.onMissingPermission,
      sections: policies.sections,
      privateRepos: policies.privateRepos,
      selfSlug: githubRepository,
    };
    const reposInput = input.value("repos");
    const reposDir = input.value("repos-dir");
    if (snapshotFile) {
      if (reposInput || reposDir) {
        return err({ code: "input-snapshot-file-with-multi" });
      }
      if (filters.discoveryFiltersSet.length > 0) {
        return err({
          code: "discovery-filters-without-wildcard",
          filters: filters.discoveryFiltersSet,
          targets: "snapshot-file",
        });
      }
      const repo = yield* readSingleTarget(input, githubRepository);
      return ok({ ...base, form: "file" as const, repo, snapshotFile });
    }
    if (input.value("repository")) {
      return err({ code: "input-repository-with-snapshot-dir" });
    }
    if (!reposInput && !reposDir) {
      return err({ code: "input-snapshot-dir-without-targets" });
    }
    return ok({
      ...base,
      form: "dir" as const,
      snapshotDir,
      reposInput,
      reposDir,
      adminOwner: githubRepository.split("/")[0] ?? "",
      discoveryFilters: filters.discoveryFilters,
      discoveryFiltersSet: filters.discoveryFiltersSet,
    });
  });
}

/** Read and validate every input through `read`; the first problem wins. */
export function parseConfig(read: InputReader, env: ConfigEnv): Result<RunConfig, Problem> {
  const input = inputs(read);
  return safeTry(function* () {
    // The mode decides which inputs exist at all, so it is read first: a merge never needs the token.
    const mode = yield* readEnum(input, "mode", MODES, INPUT_DECLS.mode.default, "mode");
    if (mode === "merge") {
      return parseMergeConfig(input);
    }
    if (mode === "snapshot") {
      return parseSnapshotConfig(input, env);
    }
    const mergeOnly = MERGE_ONLY_INPUTS.filter((name) => input.value(name) !== "");
    if (mergeOnly.length > 0) {
      return err({ code: "input-merge-only", inputs: mergeOnly, mode });
    }
    const snapshotOnly = SNAPSHOT_ONLY_INPUTS.filter((name) => input.value(name) !== "");
    if (snapshotOnly.length > 0) {
      return err({ code: "input-snapshot-only", inputs: snapshotOnly, mode });
    }
    const token = yield* readToken(input, env);
    const githubRepository = env.GITHUB_REPOSITORY ?? "";
    const { onMissingPermission, sections, privateRepos } = yield* readPolicies(input);
    const apiVersion = input.orDefault("api-version");
    const privateReport = yield* readEnum(
      input,
      "private-report",
      PRIVATE_REPORT_CHANNELS,
      INPUT_DECLS["private-report"].default,
      "private-report channel",
    );
    // A report channel only ever runs for a REDACTED target, so combined with private-repos: show it would silently deliver nothing.
    if (privateReport !== "none" && privateRepos === "show") {
      return err({ code: "input-report-without-redaction" });
    }
    const reportPublicKey = yield* resolveReportPublicKey(input, privateReport);
    const serverUrl = env.GITHUB_SERVER_URL ?? "";
    const runId = env.GITHUB_RUN_ID ?? "";
    const runUrl =
      serverUrl && githubRepository && runId
        ? `${serverUrl}/${githubRepository}/actions/runs/${runId}`
        : "";
    const common: CommonConfig = {
      token,
      mode,
      onMissingPermission,
      sections,
      apiVersion,
      privateRepos,
      privateReport,
      reportPublicKey,
      selfSlug: githubRepository,
      runUrl,
    };

    const { discoveryFilters, discoveryFiltersSet } = yield* readDiscoveryFilters(input);

    const reposInput = input.value("repos");
    const reposDir = input.value("repos-dir");
    const defaultsFile = input.value("defaults-file");
    const settingsFile = input.orDefault("settings-file");

    if (reposInput || reposDir) {
      if (input.value("repository")) {
        return err({ code: "input-repository-with-multi" });
      }
      if (settingsFile !== DEFAULT_SETTINGS_FILE) {
        return err({ code: "input-settings-file-with-multi" });
      }
      const adminOwner = githubRepository.split("/")[0] ?? "";
      return ok({
        ...common,
        kind: "multi",
        reposDir,
        reposInput,
        defaultsFile,
        adminOwner,
        discoveryFilters,
        discoveryFiltersSet,
      });
    }

    if (discoveryFiltersSet.length > 0) {
      return err({
        code: "discovery-filters-without-wildcard",
        filters: discoveryFiltersSet,
        targets: "single-repo",
      });
    }
    if (defaultsFile) {
      return err({ code: "input-defaults-file-without-multi" });
    }
    // The engine modes read exactly one file, so even a stray separator ("only.yml,") is rejected rather than repaired.
    if (LIST_SEPARATOR.test(settingsFile)) {
      return err({ code: "input-settings-file-is-list", value: settingsFile, mode });
    }
    const repo = yield* readSingleTarget(input, githubRepository);
    return ok({ ...common, kind: "single", repo, settingsFile });
  });
}
