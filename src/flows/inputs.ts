/**
 * The input declarations: INPUT_DECLS is the single source action.yml and the inputs reference are generated from,
 * and the per-mode lists beside it say which declared inputs each mode reads, so a CLI reads the same declarations
 * the action does.
 */

import type { DiscoveryFilters } from "../discovery/discover.js";
import type { Layering } from "../engine/layers.js";
import { DEFAULT_API_VERSION } from "../github/api.js";
import type { PrivateReportChannel } from "../report/delivery.js";
import type { MustBeNever } from "../types.js";
import { DEFAULT_SETTINGS_FILE } from "./multi.js";
import type { PrivateReposPolicy } from "./redact.js";

/** Default `private-repos`, pinned against action.yml by the contract test. */
export const DEFAULT_PRIVATE_REPOS = "redact" satisfies PrivateReposPolicy;

/** Default `private-report`, pinned against action.yml by the contract test. */
const DEFAULT_PRIVATE_REPORT = "none" satisfies PrivateReportChannel;

/** The `layering` input's effective default; its declared default stays empty so "explicitly set" is detectable. */
export const DEFAULT_LAYERING = "deep" satisfies Layering;

/**
 * One input's action.yml entry. The runner applies the defaults; parseConfig() falls back to them outside the
 * runner.
 */
export interface InputDecl {
  /**
   * The action.yml description; the generator folds it to width. Plain prose: the inputs table renders it inside
   * an HTML cell, so a "|" would split the row and a "<" would open a tag; gen-inputs-table.ts refuses both.
   */
  readonly description: string;
  /** The action.yml default, verbatim (an empty string means "unset"). */
  readonly default: string;
  /**
   * A comma- or newline-separated list. parseConfig reads such an input only
   * through its list() port (repos is split by the target resolver instead),
   * and the CLI lets the flag repeat; a single-value input has no `list`.
   */
  readonly list?: true;
}

/**
 * The single source action.yml (bun run build:action-docs) and the inputs reference page's table (bun run
 * build:inputs-table) are generated from, in its listing order. Adding an input here is the whole declaration. A
 * new mode's inputs go beside their mode's.
 */
export const INPUT_DECLS = {
  token: {
    description:
      "The token for the API calls: a fine-grained PAT, since the default GITHUB_TOKEN can never " +
      "hold the Administration grant most sections need.",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a workflow expression the runner resolves, not a JS template
    default: "${{ github.token }}",
  },
  repository: {
    description: "The owner/name repository to run against, the current repository by default.",
    default: "",
  },
  "settings-file": {
    description:
      "The settings document to run, or in mode: render the ordered list of layers to fold, " +
      "lowest first.",
    default: DEFAULT_SETTINGS_FILE,
    list: true,
  },
  mode: {
    description:
      "apply (write the file's settings), check (report drift, exit 1 on any), render (fold " +
      "settings-file layers into rendered-file), or snapshot (write the live settings back as a " +
      "settings file).",
    default: "apply",
  },
  "rendered-file": {
    description:
      "mode: render only, and required there: the path the rendered settings document is " +
      "written to.",
    default: "",
  },
  "snapshot-file": {
    description:
      "mode: snapshot only, for one repository: the path its live settings are written to as a " +
      "settings document.",
    default: "",
  },
  "snapshot-dir": {
    description:
      "mode: snapshot only, for a fleet: the directory receiving one owner/name.yml per repos " +
      "or repos-dir target.",
    default: "",
  },
  "on-missing-permission": {
    description:
      "fail (default) or warn: whether a section the token cannot access fails the run or is " +
      "skipped with a warning.",
    default: "fail",
  },
  "required-sections": {
    description:
      "Comma- or newline-separated sections that must fully apply even under on-missing-permission: warn.",
    default: "",
    list: true,
  },
  sections: {
    description:
      "Comma- or newline-separated allowlist of the sections to process, every declared section when unset.",
    default: "",
    list: true,
  },
  "api-version": {
    description:
      "The X-GitHub-Api-Version header value, to opt into a newer REST API version before this " +
      "action defaults to it.",
    default: DEFAULT_API_VERSION,
  },
  repos: {
    description:
      "Comma- or newline-separated owner/name targets, each applied from its own " +
      '.github/settings.yml, or "*" alone to discover every repository the token\'s user owns.',
    default: "",
    list: true,
  },
  "repos-dir": {
    description:
      "A directory in the checked-out admin repository holding one settings file per target, as " +
      "name.yml or owner/name.yml.",
    default: "",
  },
  "defaults-file": {
    description:
      "A settings document applied whole to every multi-repo target that has no settings file " +
      "of its own.",
    default: "",
  },
  layering: {
    description:
      "mode: render only: replace, shallow, or deep (default), how every list section's entries " +
      "combine with the layers below them.",
    default: "",
  },
  undeclared: {
    description:
      "keep or delete: the fallback for what apply does to a live resource a list does not " +
      "declare, unset by default so each list's own default applies.",
    default: "",
  },
  "private-repos": {
    description:
      "redact (default) or show: whether private and internal targets are hidden from the run's " +
      "public logs, summary, and outputs.",
    default: DEFAULT_PRIVATE_REPOS,
  },
  "private-report": {
    description:
      "none (default), issue, issue-on-failure, or artifact: the private channel that delivers " +
      "the full report of each target the visibility probe proves private or internal.",
    default: DEFAULT_PRIVATE_REPORT,
  },
  "report-public-key": {
    description:
      "The age recipient (a public key starting with age1) the artifact channel encrypts every " +
      "report to, required by private-report: artifact and rejected otherwise.",
    default: "",
  },
  visibility: {
    description:
      'Keeps only repositories of this visibility in repos: "*" discovery: all (default), ' +
      "public, private, or internal.",
    default: "",
  },
  archived: {
    description:
      'Archived-repository policy for repos: "*" discovery: skip (default), include, or only.',
    default: "",
  },
  forks: {
    description: 'Fork policy for repos: "*" discovery: include (default), exclude, or only.',
    default: "",
  },
  exclude: {
    description:
      'Comma- or newline-separated glob patterns removing repositories from repos: "*" discovery, compared ' +
      'case-insensitively against owner/name when the pattern has a "/" and against the name alone ' +
      'otherwise. A star matches any run of characters, "?" one character, "[abc]" one of a set, "[!abc]" ' +
      'or "[^abc]" one outside it, and one leading "!" negates the pattern. Beyond those a pattern holds ' +
      'only letters, digits, ".", "-", and "_", with at most one "/", nothing empty around it, and no side ' +
      'that is just "." or ".."; anything else (a leading "./", a run of stars, a regex token such as ' +
      '"(a)+") fails the run naming the fix.',
    default: "",
    list: true,
  },
  topics: {
    description:
      'Comma- or newline-separated topics, of which repos: "*" discovery keeps the repositories ' +
      "carrying at least one.",
    default: "",
    list: true,
  },
  affiliation: {
    description:
      'Comma- or newline-separated affiliations for repos: "*" discovery: owner (default), ' +
      "collaborator, or organization_member.",
    default: "",
    list: true,
  },
} as const satisfies Record<string, InputDecl>;

export type InputName = keyof typeof INPUT_DECLS;

/** The inputs declared `list: true`, the only names the list() port accepts. */
export type ListInput = {
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
export const MODES = ["apply", "check", "render", "snapshot"] as const;

export type Mode = (typeof MODES)[number];

/**
 * Their declared defaults are empty so "explicitly set" is detectable, as with the discovery filters; apply and check
 * reject a set one instead of silently ignoring it.
 */
export const RENDER_ONLY_INPUTS = [
  "rendered-file",
  "layering",
] as const satisfies readonly InputName[];
export const SNAPSHOT_ONLY_INPUTS = [
  "snapshot-file",
  "snapshot-dir",
] as const satisfies readonly InputName[];
/**
 * `token` is tolerated unread (a workflow commonly sets it on every step). Every declared input NOT listed here is an
 * apply/check control, so the merge rejects it unless it holds its declared default, which the runner supplies whether
 * or not the workflow set the input.
 */
export const RENDER_INPUTS = [
  "mode",
  "settings-file",
  "rendered-file",
  "layering",
  "undeclared",
  "token",
] as const satisfies readonly InputName[];

/**
 * Derived from the declarations, so a future input is rejected by the merge until listed in RENDER_INPUTS; exported so
 * the layering guide's table is pinned to the whole set.
 */
export const RENDER_REJECTED_INPUTS: readonly InputName[] = (
  Object.keys(INPUT_DECLS) as InputName[]
).filter((name) => !(RENDER_INPUTS as readonly string[]).includes(name));
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
