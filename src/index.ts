/**
 * The public entry: everything a library consumer, the action included, may
 * import from src/. Declaration-only: each name is defined in the layer that
 * owns it, and src/action/ reaches the rest of src/ through this file alone
 * (architecture.yml declares that as its one edge).
 */

export { resolveCentralTargets } from "./discovery/central.js";
export {
  AFFILIATIONS,
  ARCHIVED_FILTERS,
  DEFAULT_DISCOVERY_FILTERS,
  type DiscoveryFilters,
  type DiscoveryProblem,
  discoverRepos,
  FORKS_FILTERS,
  VISIBILITY_FILTERS,
} from "./discovery/discover.js";
export { parseReposInput } from "./discovery/repos-input.js";
export {
  type CentralTarget,
  dedupeTargets,
  parseRepoSlug,
  type RemoteTarget,
  type RepoRef,
  type Target,
} from "./discovery/targets.js";
export {
  describeOptOut,
  type Layer,
  type Layering,
  mergeLayers,
  type OptOutNotice,
  stripNulls,
} from "./engine/layers.js";
export {
  preflightProbe,
  REPO_RESULTS,
  type RepoResult,
  type RepoRunOptions,
  type RepoRunResult,
  runForRepo,
  type SectionOutcome,
  skippedSectionKeys,
  type ValidatedSettings,
  validateSettingsDoc,
  worstOf,
} from "./engine/orchestrate.js";
export { SectionSelection } from "./engine/section-selection.js";
export {
  type RenderableSnapshot,
  renderSnapshotYaml,
  type SnapshotResult,
} from "./engine/snapshot.js";
export {
  concludeMerge,
  concludeRun,
  type FinishedMerge,
  failRun,
  MERGE_RESULT,
  type RunFlowConfig,
} from "./flows/deliver.js";
export {
  type ConfigEnv,
  DEFAULT_PRIVATE_REPOS,
  FILTER_INPUTS,
  INPUT_DECLS,
  type InputDecl,
  type InputName,
  type InputReader,
  MERGE_INPUTS,
  MERGE_ONLY_INPUTS,
  MERGE_REJECTED_INPUTS,
  MODES,
  type Mode,
  parseConfig,
  type RunConfig,
  SNAPSHOT_INPUTS,
  SNAPSHOT_ONLY_INPUTS,
  SNAPSHOT_REJECTED_INPUTS,
} from "./flows/inputs.js";
export { foldLayers, readLayerFiles } from "./flows/layers.js";
export {
  applyRepository,
  checkRepository,
  type RepoRunReport,
  renderMergedYaml,
  type SnapshotLibraryOptions,
  type SnapshotReport,
  snapshotRepositories,
  snapshotRepository,
  validateSettings,
} from "./flows/library.js";
export { type MergeConfig, runMerge } from "./flows/merge.js";
export {
  DEFAULT_SETTINGS_FILE,
  type MultiConfig,
  type ResolvedTargets,
  resolveTargets,
  runMulti,
  type TargetsConfig,
} from "./flows/multi.js";
export {
  capturingIo,
  PRIVATE_REPOS_POLICIES,
  type PrivateReposPolicy,
  type PublicTargetView,
  planRedaction,
  publicDetail,
  type TargetOutcome,
  toPublicView,
} from "./flows/redact.js";
export { parseSettingsDoc, readSettingsFile } from "./flows/settings-read.js";
export { runSingle, type SingleConfig, type SingleOutcome } from "./flows/single.js";
export {
  concludeSnapshot,
  type FinishedSnapshot,
  runSnapshot,
  SNAPSHOT_RESULTS,
  SNAPSHOT_SCHEMA_URL,
  type SnapshotConfig,
  type SnapshotRunResult,
  type SnapshotTargetView,
} from "./flows/snapshot.js";
export {
  type ApiError,
  DEFAULT_API_VERSION,
  GithubApi,
  type GithubClient,
  type GraphqlOp,
  isPermissionError,
  isRateLimitError,
  type RequestMark,
  SECRET_RESPONSE_WITHHELD,
  SECRET_TRANSPORT_WITHHELD,
  type TraceIo,
} from "./github/api.js";
export { getRepoFile } from "./github/repo-file.js";
export { createVisibilityResolver, type RepoVisibility } from "./github/repo-visibility.js";
export {
  type AnnotationLevel,
  type CollectedLine,
  collectingIo,
  type Io,
  type MaskPair,
  maskRegistry,
  type OutputName,
  prefixedIo,
  redactRanges,
  silentIo,
} from "./io.js";
// Problems
export {
  type CentralFileProblem,
  describeProblem,
  type LayerProblem,
  type Problem,
  type ProblemOf,
  quoteList,
  RERUN_ADVICE,
  type SettingsFileRole,
  type SettingsProblem,
  type TopLevelShape,
} from "./problem.js";

export {
  type ArtifactUploader,
  deliverArtifactReport,
  encryptReport,
  parseRecipient,
} from "./report/artifact-report.js";
export { composeReport, type ReportInput } from "./report/composer.js";
export {
  applyMarkerInjection,
  openReportChannel,
  PRIVATE_REPORT_CHANNELS,
  type PrivateReportChannel,
} from "./report/delivery.js";
export { ISSUE_TITLE, MARKER_LABEL, MARKER_LABEL_CONFIG } from "./report/issue-report.js";
export {
  DOCUMENT_DIRECTIVE_KEYS,
  PROBOT_PARITY_KEYS,
  SECTION_KEYS,
  type SectionKey,
  SettingsFile,
  UNDECLARED_POLICY_SECTIONS,
  type UndeclaredPolicySection,
} from "./schema.js";

export {
  type EndpointDecl,
  endpointMethod,
  endpointPath,
  type Route,
} from "./sections/contract/endpoints.js";
export type { GraphqlOpDecl } from "./sections/contract/graphql.js";
export {
  denialPosture,
  type KeyedListLayering,
  readGating,
  type SectionMeta,
  type SectionModule,
  sectionGrant,
  sectionOperations,
  writeGatedReads,
} from "./sections/contract/module.js";
export {
  grantFor,
  type PatResource,
  type SectionPermission,
} from "./sections/contract/permissions.js";
export type {
  Justification,
  PlannedOpBase,
  Tolerance,
  Unverifiable,
} from "./sections/contract/plan.js";
export {
  allEndpoints,
  allGraphqlOps,
  SECTIONS,
  sectionModule,
  type TaggedEndpoint,
} from "./sections/registry.js";
export type { MustBeNever, UndeclaredPolicy, UndeclaredPolicyList } from "./types.js";
