/**
 * parseConfig() validates every input read through a caller-supplied port (each problem names the input and the fix)
 * into the RunConfig the run executes, so no execution code touches a raw input and a CLI reads the same declarations
 * the action does.
 */

import { err, ok, type Result, safeTry } from "neverthrow";
import type { DiscoveryFilters } from "../discovery/discover.js";
import { LIST_SEPARATOR, parseReposInput } from "../discovery/repos-input.js";
import { LAYERINGS } from "../engine/layers.js";
import type { Problem } from "../problem.js";
import { PRIVATE_REPORT_CHANNELS } from "../report/delivery.js";
import type { RunFlowConfig } from "./deliver.js";
import {
  type Inputs,
  inputs,
  readDiscoveryFilters,
  readEnum,
  readPolicies,
  readSingleTarget,
  readToken,
  readUndeclared,
  resolveReportPublicKey,
} from "./input-readers.js";
import {
  type ConfigEnv,
  DEFAULT_LAYERING,
  INPUT_DECLS,
  type InputName,
  type InputReader,
  MODES,
  RENDER_ONLY_INPUTS,
  RENDER_REJECTED_INPUTS,
  SNAPSHOT_ONLY_INPUTS,
  SNAPSHOT_REJECTED_INPUTS,
} from "./inputs.js";
import { DEFAULT_SETTINGS_FILE, type MultiConfig } from "./multi.js";
import type { RenderConfig } from "./render.js";
import type { SingleConfig } from "./single.js";
import type { SnapshotConfig } from "./snapshot.js";

/** selfSlug (GITHUB_REPOSITORY) and runUrl are read from the environment once here, so the run flows stay env-free. */
interface CommonConfig extends RunFlowConfig {
  token: string;
  apiVersion: string;
}

export type RunConfig =
  | (CommonConfig & (({ kind: "single" } & SingleConfig) | ({ kind: "multi" } & MultiConfig)))
  | ({ kind: "render" } & RenderConfig)
  | ({ kind: "snapshot" } & Pick<CommonConfig, "token" | "apiVersion"> & SnapshotConfig);

/** The validated discovery filters, and the names the workflow set explicitly, which the misuse rejections name. */
interface DiscoveryInputs {
  readonly discoveryFilters: DiscoveryFilters;
  readonly discoveryFiltersSet: string[];
}

/** The target inputs apply and check read once, since the arm they take depends on them. */
interface TargetInputs {
  readonly reposInput: string;
  readonly reposDir: string;
  readonly defaultsFile: string;
  readonly settingsFile: string;
}

/** The inputs among `names` set to something other than their declared default. */
function setOffDefault<N extends InputName>(input: Inputs, names: readonly N[]): N[] {
  return names.filter((name) => {
    const value = input.value(name);
    return value !== "" && value !== INPUT_DECLS[name].default;
  });
}

/** The inputs among `names` the workflow set at all. */
function setInputs<N extends InputName>(input: Inputs, names: readonly N[]): N[] {
  return names.filter((name) => input.value(name) !== "");
}

function parseRenderConfig(input: Inputs): Result<Extract<RunConfig, { kind: "render" }>, Problem> {
  return safeTry(function* () {
    const rejected = setOffDefault(input, RENDER_REJECTED_INPUTS);
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

/** The file form of a mode: snapshot run: one repository written to snapshotFile. */
export type SnapshotFileConfig = Extract<RunConfig, { kind: "snapshot"; form: "file" }>;

/** The dir form of a mode: snapshot run: the multi-repo targets written under snapshotDir. */
type SnapshotDirConfig = Extract<RunConfig, { kind: "snapshot"; form: "dir" }>;

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

/**
 * The target problems the inputs alone decide: a repos list that mixes "*" with names or carries a bad entry, and
 * discovery filters set where no "*" discovery runs. Refused here, before any file is read, so an unreadable
 * repos-dir cannot hide them; resolveTargets meets the same problems for a library caller that builds the config
 * by hand.
 */
function refuseTargetInputs(
  reposInput: string,
  discoveryFiltersSet: readonly string[],
): Result<void, Problem> {
  const filtersWithout = (targets: "explicit-repos" | "repos-dir"): Result<void, Problem> =>
    discoveryFiltersSet.length > 0
      ? err({ code: "discovery-filters-without-wildcard", filters: discoveryFiltersSet, targets })
      : ok(undefined);
  if (!reposInput) {
    return filtersWithout("repos-dir");
  }
  return parseReposInput(reposInput).andThen((parsed) =>
    parsed.discover ? ok(undefined) : filtersWithout("explicit-repos"),
  );
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

/** The dir arm: the fleet inputs, the single-repo one refused. */
function parseSnapshotDirArm(
  input: Inputs,
  env: ConfigEnv,
  snapshotDir: string,
): Result<SnapshotDirConfig, Problem> {
  return safeTry(function* () {
    const { base, filters } = yield* readSnapshotBase(input, env);
    if (input.value("repository")) {
      return err({ code: "input-repository-with-snapshot-dir" });
    }

    const reposInput = input.value("repos");
    const reposDir = input.value("repos-dir");
    if (!reposInput && !reposDir) {
      return err({ code: "input-snapshot-dir-without-targets" });
    }

    yield* refuseTargetInputs(reposInput, filters.discoveryFiltersSet);
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

/** Read and validate the mode: snapshot inputs; the first problem wins. */
function parseSnapshotConfig(
  input: Inputs,
  env: ConfigEnv,
): Result<Extract<RunConfig, { kind: "snapshot" }>, Problem> {
  const rejected = setOffDefault(input, SNAPSHOT_REJECTED_INPUTS);
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

  return parseSnapshotDirArm(input, env, snapshotDir);
}

/**
 * What the face running the config can do; parseConfig refuses an input that needs a capability the face lacks, so
 * the refusal has one owner and the flows never re-check it.
 */
export interface RunCapabilities {
  /** The face hands the run a workflow-artifact uploader (the Actions runner); without it `private-report: artifact` is refused. */
  readonly artifactUpload: boolean;
}

/** The workflow run's URL; empty outside a run, where the runner's three variables are not all set. */
function runUrlOf(env: ConfigEnv, githubRepository: string): string {
  const serverUrl = env.GITHUB_SERVER_URL ?? "";
  const runId = env.GITHUB_RUN_ID ?? "";
  return serverUrl && githubRepository && runId
    ? `${serverUrl}/${githubRepository}/actions/runs/${runId}`
    : "";
}

/**
 * What apply and check share, read in input order. The report channel is refused for a face without the upload it
 * needs, and beside `private-repos: show`, where it would silently deliver nothing.
 */
function readCommon(
  input: Inputs,
  env: ConfigEnv,
  mode: "apply" | "check",
  capabilities: RunCapabilities,
): Result<CommonConfig, Problem> {
  return safeTry(function* () {
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
    return ok({
      token,
      mode,
      onMissingPermission,
      sections,
      apiVersion,
      privateRepos,
      privateReport,
      reportPublicKey,
      selfSlug: githubRepository,
      runUrl: runUrlOf(env, githubRepository),
      undeclared,
    });
  });
}

/** The multi-repo arm: the single-repo inputs refused, then the target problems the inputs alone decide. */
function parseMultiArm(
  input: Inputs,
  common: CommonConfig,
  filters: DiscoveryInputs,
  targets: TargetInputs,
): Result<Extract<RunConfig, { kind: "multi" }>, Problem> {
  if (input.value("repository")) {
    return err({ code: "input-repository-with-multi" });
  }
  if (targets.settingsFile !== DEFAULT_SETTINGS_FILE) {
    return err({ code: "input-settings-file-with-multi" });
  }

  return refuseTargetInputs(targets.reposInput, filters.discoveryFiltersSet).map(() => ({
    ...common,
    kind: "multi" as const,
    reposDir: targets.reposDir,
    reposInput: targets.reposInput,
    defaultsFile: targets.defaultsFile,
    adminOwner: common.selfSlug.split("/")[0] ?? "",
    discoveryFilters: filters.discoveryFilters,
    discoveryFiltersSet: filters.discoveryFiltersSet,
  }));
}

/** The single-repo arm: the fleet inputs refused, the one settings file read as written. */
function parseSingleArm(
  input: Inputs,
  common: CommonConfig,
  filters: DiscoveryInputs,
  targets: TargetInputs,
): Result<Extract<RunConfig, { kind: "single" }>, Problem> {
  if (filters.discoveryFiltersSet.length > 0) {
    return err({
      code: "discovery-filters-without-wildcard",
      filters: filters.discoveryFiltersSet,
      targets: "single-repo",
    });
  }
  if (targets.defaultsFile) {
    return err({ code: "input-defaults-file-without-multi" });
  }
  // The engine modes read exactly one file, so even a stray separator ("only.yml,") is rejected rather than repaired.
  if (LIST_SEPARATOR.test(targets.settingsFile)) {
    return err({
      code: "input-settings-file-is-list",
      value: targets.settingsFile,
      mode: common.mode,
    });
  }

  return readSingleTarget(input, common.selfSlug).map((repo) => ({
    ...common,
    kind: "single" as const,
    repo,
    settingsFile: targets.settingsFile,
  }));
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

    const renderOnly = setInputs(input, RENDER_ONLY_INPUTS);
    if (renderOnly.length > 0) {
      return err({ code: "input-render-only", inputs: renderOnly, mode });
    }
    const snapshotOnly = setInputs(input, SNAPSHOT_ONLY_INPUTS);
    if (snapshotOnly.length > 0) {
      return err({ code: "input-snapshot-only", inputs: snapshotOnly, mode });
    }

    const common = yield* readCommon(input, env, mode, capabilities);
    const filters = yield* readDiscoveryFilters(input);
    const targets: TargetInputs = {
      reposInput: input.value("repos"),
      reposDir: input.value("repos-dir"),
      defaultsFile: input.value("defaults-file"),
      settingsFile: input.orDefault("settings-file"),
    };
    if (targets.reposInput || targets.reposDir) {
      return parseMultiArm(input, common, filters, targets);
    }

    return parseSingleArm(input, common, filters, targets);
  });
}
