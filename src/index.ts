/**
 * The public entry: everything a library consumer, the action included, may
 * import from src/. Declaration-only: each name is defined in the layer that
 * owns it, and src/action/ reaches the rest of src/ through this file alone
 * (architecture.yml declares that as its one edge).
 */

// Discovery
export { resolveCentralTargets } from "./discovery/central.js";
export {
  AFFILIATIONS,
  ARCHIVED_FILTERS,
  DEFAULT_DISCOVERY_FILTERS,
  type DiscoveryFilters,
  discoverRepos,
  FORKS_FILTERS,
  VISIBILITY_FILTERS,
} from "./discovery/discover.js";
export { parseReposInput } from "./discovery/repos-input.js";
// Check and apply one repository
export {
  type CentralTarget,
  dedupeTargets,
  parseRepoSlug,
  type RemoteTarget,
  type RepoRef,
  type Target,
} from "./discovery/targets.js";
// Validate and merge
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
// The run flows
export { concludeRun, failRun, MERGE_RESULT, type RunFlowConfig } from "./flows/deliver.js";
export { foldLayers, readLayerFiles } from "./flows/layers.js";
export {
  applyRepository,
  checkRepository,
  type RepoRunReport,
  renderMergedYaml,
  validateSettings,
} from "./flows/library.js";
export { type MergeConfig, runMerge } from "./flows/merge.js";
export { DEFAULT_SETTINGS_FILE, type MultiConfig, quoteList, runMulti } from "./flows/multi.js";
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
export { runSingle, type SingleConfig } from "./flows/single.js";
// The client
export {
  type ApiError,
  DEFAULT_API_VERSION,
  GithubApi,
  type GithubClient,
  type GraphqlOp,
  isPermissionError,
  isRateLimitError,
  RERUN_ADVICE,
  type TraceIo,
} from "./github/api.js";
export { getRepoFile } from "./github/repo-file.js";
export { createVisibilityResolver, type RepoVisibility } from "./github/repo-visibility.js";
// The Io port
export {
  type AnnotationLevel,
  type CollectedLine,
  collectingIo,
  type Io,
  type MaskPair,
  maskRegistry,
  type OutputName,
  prefixedIo,
  silentIo,
} from "./io.js";
// The private report
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
// The settings document
export {
  DOCUMENT_DIRECTIVE_KEYS,
  PROBOT_PARITY_KEYS,
  SECTION_KEYS,
  type SectionKey,
  SettingsFile,
  UNDECLARED_POLICY_SECTIONS,
  type UndeclaredPolicySection,
} from "./schema.js";

// Section metadata
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
export {
  allEndpoints,
  allGraphqlOps,
  SECTIONS,
  sectionModule,
  type TaggedEndpoint,
} from "./sections/registry.js";
export type { MustBeNever, UndeclaredPolicy, UndeclaredPolicyList } from "./types.js";
