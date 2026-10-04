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
import { LIST_SEPARATOR } from "../discovery/repos-input.js";
import { parseRepoSlug, type RepoRef } from "../discovery/targets.js";
import { LAYERINGS, type Layering, UNDECLARED_POLICIES } from "../engine/layers.js";
import { SectionSelection } from "../engine/section-selection.js";
import { DEFAULT_API_VERSION } from "../github/api.js";
import type { Problem } from "../problem.js";
import { parseRecipient } from "../report/artifact-report.js";
import { PRIVATE_REPORT_CHANNELS, type PrivateReportChannel } from "../report/delivery.js";
import { SECTION_KEYS, type SectionKey } from "../schema.js";
import type { MustBeNever, UndeclaredPolicy } from "../types.js";
import type { RunFlowConfig } from "./deliver.js";
import { DEFAULT_SETTINGS_FILE, type MultiConfig } from "./multi.js";
import { PRIVATE_REPOS_POLICIES, type PrivateReposPolicy } from "./redact.js";
import type { RenderConfig } from "./render.js";
import type { SingleConfig } from "./single.js";
import type { SnapshotConfig } from "./snapshot.js";

/** Default `private-repos`, pinned against action.yml by the contract test. */
export const DEFAULT_PRIVATE_REPOS = "redact" satisfies PrivateReposPolicy;

/** Default `private-report`, pinned against action.yml by the contract test. */
const DEFAULT_PRIVATE_REPORT = "none" satisfies PrivateReportChannel;

/** The `layering` input's effective default; its declared default stays empty so "explicitly set" is detectable. */
const DEFAULT_LAYERING = "deep" satisfies Layering;

/**
 * One input's action.yml entry. The runner applies the defaults; parseConfig() falls back to them outside the
 * runner.
 */
export interface InputDecl {
  /**
   * The action.yml description; the generator folds it to width. Plain prose: action-docs runs it through a
   * markdown renderer for the docs table, so a paired "*" or "_" would italicize, "..." would become an
   * ellipsis, a "|" would split the cell, and a "<" would open a tag (test/docs/inputs.test.ts pins the rendering).
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
 * The single source action.yml is generated from (bun run build:action-docs), in its listing order; the inputs
 * reference page's table is action-docs's rendering of that action.yml (bun run build:inputs-table). Adding an
 * input here is the whole declaration. A new mode's inputs go beside their mode's.
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
      'Comma- or newline-separated wildcard patterns removing repositories from repos: "*" ' +
      "discovery.",
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

/**
 * An enum input: unset reads as `fallback`, which is one of the values or, for an input whose unset state means "no
 * value" (`undeclared` leaves each list its own default), undefined.
 */
function readEnum<T extends string, F extends T | undefined>(
  input: Inputs,
  name: InputName,
  allowed: readonly T[],
  fallback: F,
  noun: string,
): Result<T | F, Problem> {
  const value = input.value(name);
  if (value === "") {
    return ok(fallback);
  }
  const match = allowed.find((candidate) => candidate === value);
  if (match === undefined) {
    return err({
      code: "input-unsupported-value",
      input: name,
      value,
      noun,
      allowed,
      fallback: fallback ?? null,
    });
  }
  return ok(match);
}

function readUndeclared(input: Inputs): Result<UndeclaredPolicy | undefined, Problem> {
  return readEnum(input, "undeclared", UNDECLARED_POLICIES, undefined, "undeclared policy");
}

function splitList(value: string): string[] {
  return value
    .split(LIST_SEPARATOR)
    .map((s) => s.trim())
    .filter(Boolean);
}

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
  | ({ kind: "render" } & RenderConfig)
  | ({ kind: "snapshot" } & Pick<CommonConfig, "token" | "apiVersion"> & SnapshotConfig);

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

function parseRenderConfig(input: Inputs): Result<Extract<RunConfig, { kind: "render" }>, Problem> {
  return safeTry(function* () {
    const rejected = RENDER_REJECTED_INPUTS.filter((name) => {
      const value = input.value(name);
      return value !== "" && value !== INPUT_DECLS[name].default;
    });
    if (rejected.length > 0) {
      return err({ code: "input-rejected-in-render", inputs: rejected });
    }
    const renderedFile = input.value("rendered-file");
    if (!renderedFile) {
      return err({ code: "input-rendered-file-missing" });
    }
    const layering = yield* readEnum(input, "layering", LAYERINGS, DEFAULT_LAYERING, "layering");
    const undeclared = yield* readUndeclared(input);
    const settingsFiles = input.list("settings-file");
    if (settingsFiles.length === 0) {
      return err({
        code: "input-settings-file-empty",
        value: input.orDefault("settings-file"),
      });
    }
    return ok({ kind: "render", settingsFiles, renderedFile, layering, undeclared });
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

/** The file form of a mode: snapshot run: one repository written to snapshotFile. */
export type SnapshotFileConfig = Extract<RunConfig, { kind: "snapshot"; form: "file" }>;

/** What both snapshot forms read before the destination picks the arm. */
function readSnapshotBase(input: Inputs, env: ConfigEnv) {
  return safeTry(function* () {
    const token = yield* readToken(input, env);
    const policies = yield* readPolicies(input);
    const filters = yield* readDiscoveryFilters(input);
    return ok({
      base: {
        kind: "snapshot" as const,
        token,
        apiVersion: input.orDefault("api-version"),
        onMissingPermission: policies.onMissingPermission,
        sections: policies.sections,
        privateRepos: policies.privateRepos,
        selfSlug: env.GITHUB_REPOSITORY ?? "",
      },
      filters,
    });
  });
}

/** The file arm: one repository, the fleet inputs refused. */
function parseSnapshotFileArm(
  input: Inputs,
  env: ConfigEnv,
  snapshotFile: string,
): Result<SnapshotFileConfig, Problem> {
  return safeTry(function* () {
    const { base, filters } = yield* readSnapshotBase(input, env);
    if (input.value("repos") || input.value("repos-dir")) {
      return err({ code: "input-snapshot-file-with-multi" });
    }
    if (filters.discoveryFiltersSet.length > 0) {
      return err({
        code: "discovery-filters-without-wildcard",
        filters: filters.discoveryFiltersSet,
        targets: "snapshot-file",
      });
    }
    const repo = yield* readSingleTarget(input, base.selfSlug);
    return ok({ ...base, form: "file" as const, repo, snapshotFile });
  });
}

/**
 * The file the `settings-file` input names, or its declared default: known before any parsing, so a failure can
 * name it. The CLI's init writes that file, the one apply and check read.
 */
export function snapshotFileDestination(read: InputReader): string {
  return inputs(read).orDefault("settings-file");
}

/**
 * The file arm for the CLI's init, whose destination is the `settings-file` input
 * (refusing a list separator as apply and check do) and can never be the dir form.
 */
export function parseSnapshotFileConfig(
  read: InputReader,
  env: ConfigEnv,
): Result<SnapshotFileConfig, Problem> {
  const path = snapshotFileDestination(read);
  if (LIST_SEPARATOR.test(path)) {
    return err({ code: "input-settings-file-is-list", value: path, mode: "init" });
  }
  return parseSnapshotFileArm(inputs(read), env, path);
}

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
    if (snapshotFile) {
      return parseSnapshotFileArm(input, env, snapshotFile);
    }
    const { base, filters } = yield* readSnapshotBase(input, env);
    if (input.value("repository")) {
      return err({ code: "input-repository-with-snapshot-dir" });
    }
    const reposInput = input.value("repos");
    const reposDir = input.value("repos-dir");
    if (!reposInput && !reposDir) {
      return err({ code: "input-snapshot-dir-without-targets" });
    }
    return ok({
      ...base,
      form: "dir" as const,
      snapshotDir,
      reposInput,
      reposDir,
      adminOwner: base.selfSlug.split("/")[0] ?? "",
      discoveryFilters: filters.discoveryFilters,
      discoveryFiltersSet: filters.discoveryFiltersSet,
    });
  });
}

/**
 * What the face running the config can do; parseConfig refuses an input that needs a capability the face lacks, so
 * the refusal has one owner and the flows never re-check it.
 */
export interface RunCapabilities {
  /** The face hands the run a workflow-artifact uploader (the Actions runner); without it `private-report: artifact` is refused. */
  readonly artifactUpload: boolean;
}

/** Read and validate every input through `read`; the first problem wins. */
export function parseConfig(
  read: InputReader,
  env: ConfigEnv,
  capabilities: RunCapabilities,
): Result<RunConfig, Problem> {
  const input = inputs(read);
  return safeTry(function* () {
    // The mode decides which inputs exist at all, so it is read first: a merge never needs the token.
    const mode = yield* readEnum(input, "mode", MODES, INPUT_DECLS.mode.default, "mode");
    if (mode === "render") {
      return parseRenderConfig(input);
    }
    if (mode === "snapshot") {
      return parseSnapshotConfig(input, env);
    }
    const renderOnly = RENDER_ONLY_INPUTS.filter((name) => input.value(name) !== "");
    if (renderOnly.length > 0) {
      return err({ code: "input-render-only", inputs: renderOnly, mode });
    }
    const snapshotOnly = SNAPSHOT_ONLY_INPUTS.filter((name) => input.value(name) !== "");
    if (snapshotOnly.length > 0) {
      return err({ code: "input-snapshot-only", inputs: snapshotOnly, mode });
    }
    const token = yield* readToken(input, env);
    const githubRepository = env.GITHUB_REPOSITORY ?? "";
    const { onMissingPermission, sections, privateRepos } = yield* readPolicies(input);
    const undeclared = yield* readUndeclared(input);
    const apiVersion = input.orDefault("api-version");
    const privateReport = yield* readEnum(
      input,
      "private-report",
      PRIVATE_REPORT_CHANNELS,
      INPUT_DECLS["private-report"].default,
      "private-report channel",
    );
    // Refused before the channel's key is asked for: a face with no upload has no use for the key either.
    if (privateReport === "artifact" && !capabilities.artifactUpload) {
      return err({ code: "input-artifact-unsupported" });
    }
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
      undeclared,
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
