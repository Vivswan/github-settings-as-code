/**
 * parseConfig() validates every input read through a caller-supplied port (each problem names the input and the fix)
 * into the RunConfig the run executes, so no execution code touches a raw input and a CLI reads the same declarations
 * the action does.
 */

import { err, ok, type Result, safeTry } from "neverthrow";
import { LIST_SEPARATOR } from "../discovery/repos-input.js";
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
