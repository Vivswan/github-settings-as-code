/**
 * The public entry: the documented library, and nothing else. Every name here has a row in docs/reference/library.md
 * (test/library/public-surface.test.ts derives the pin from that page), and a rename is a major. The action, the
 * CLI, and the tests reach the rest of src/ through ./internal.ts, the entry with no semver promise.
 */

export { resolveCentralTargets } from "./discovery/central.js";
export {
  DEFAULT_DISCOVERY_FILTERS,
  type DiscoveryFilters,
  discoverRepos,
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
  type OptOutNotice,
} from "./engine/layers.js";
export type { SectionOutcome, ValidatedSettings } from "./engine/orchestrate.js";
export { RUN_RESULTS, type RunOutcome, worstOf } from "./engine/outcome.js";
export { SectionSelection } from "./engine/section-selection.js";
export type { SectionSnapshotOutcome } from "./engine/snapshot.js";
export {
  concludeMerge,
  concludeRun,
  type FinishedMerge,
  failRun,
} from "./flows/deliver.js";
export { executeRun, type RunDeps, type RunEnd } from "./flows/execute.js";
export {
  type ConfigEnv,
  type InputReader,
  parseConfig,
  type RunCapabilities,
  type RunConfig,
} from "./flows/inputs.js";
export { readLayerFiles } from "./flows/layers.js";
export {
  type ApplyOptions,
  type ApplyReport,
  applyRepository,
  type CheckOptions,
  type CheckReport,
  checkRepository,
  type MergeOptions,
  type MergeReport,
  mergeSettings,
  type SnapshotOptions,
  type SnapshotReport,
  snapshotRepositories,
  snapshotRepository,
  type ValidateOptions,
  type ValidateReport,
  validateSettings,
} from "./flows/library.js";
export { type MergeConfig, runMerge } from "./flows/merge.js";
export { type MultiConfig, runMulti } from "./flows/multi.js";
export type { TargetOutcome } from "./flows/redact.js";
export { parseSettingsDoc, readSettingsFile } from "./flows/settings-read.js";
export { runSingle, type SingleConfig, type SingleOutcome } from "./flows/single.js";
export {
  concludeSnapshot,
  type FinishedSnapshot,
  runSnapshot,
  type SnapshotConfig,
} from "./flows/snapshot.js";
export {
  type ApiError,
  DEFAULT_API_VERSION,
  GitHubApi,
  type GitHubApiOptions,
  type GitHubClient,
  type GraphqlOp,
  isPermissionError,
  isRateLimitError,
  type RequestMark,
} from "./github/api.js";
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
export { describeProblem, type Problem, type SettingsFileRole } from "./problem.js";
export {
  type ArtifactUploader,
  deliverArtifactReport,
  encryptReport,
  parseRecipient,
} from "./report/artifact-report.js";
export { composeReport, type ReportInput } from "./report/composer.js";
export { openReportChannel, type PrivateReportChannel } from "./report/delivery.js";
export {
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
  type SectionModule,
  type SectionSnapshot,
  sectionGrant,
} from "./sections/contract/module.js";
export {
  type DenialPolicy,
  type OnMissingPermission,
  type PlanContext,
  planContext,
  type SectionPlan,
  type SnapshotContext,
  snapshotContext,
} from "./sections/contract/plan.js";
export {
  allEndpoints,
  allGraphqlOps,
  SECTIONS,
  sectionModule,
  type TaggedEndpoint,
} from "./sections/registry.js";
