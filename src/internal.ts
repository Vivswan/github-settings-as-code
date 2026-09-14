/**
 * The internal entry: what the action, the CLI, and the tests import beyond the public library. Published as the
 * package's `./internal` subpath with no semver promise (a name here may move or go in any release), so a program
 * outside this repository imports from ./index.ts. Declaration-only, like the public entry: each name is defined in
 * the layer that owns it, and the two entries together are the only way the faces reach the rest of src/.
 */

export {
  AFFILIATIONS,
  ARCHIVED_FILTERS,
  type DiscoveryProblem,
  FORKS_FILTERS,
  VISIBILITY_FILTERS,
} from "./discovery/discover.js";
export { canonicalDocument, renderCanonicalYaml } from "./engine/canonical.js";
export { mergeLayers, stripNulls } from "./engine/layers.js";
export {
  preflightProbe,
  type RepoResult,
  type RepoRunOptions,
  type RepoRunResult,
  runForRepo,
  skippedSectionKeys,
  validateSettingsDoc,
} from "./engine/orchestrate.js";
export {
  type RenderableSnapshot,
  renderSnapshotYaml,
  type SnapshotResult,
  type SnapshotRunOptions,
} from "./engine/snapshot.js";
export type { RunFlowConfig } from "./flows/deliver.js";
export {
  DEFAULT_PRIVATE_REPOS,
  FILTER_INPUTS,
  INPUT_DECLS,
  type InputDecl,
  type InputName,
  MERGE_INPUTS,
  MERGE_ONLY_INPUTS,
  MERGE_REJECTED_INPUTS,
  MODES,
  type Mode,
  parseSnapshotFileConfig,
  SNAPSHOT_INPUTS,
  SNAPSHOT_ONLY_INPUTS,
  SNAPSHOT_REJECTED_INPUTS,
  type SnapshotFileConfig,
  snapshotFileDestination,
} from "./flows/inputs.js";
export { type FoldedLayers, foldLayers } from "./flows/layers.js";
export {
  DEFAULT_SETTINGS_FILE,
  type ResolvedTargets,
  resolveTargets,
  type TargetsConfig,
} from "./flows/multi.js";
export {
  capturingIo,
  PRIVATE_REPOS_POLICIES,
  type PrivateReposPolicy,
  type PublicTargetView,
  planRedaction,
  publicDetail,
  toPublicView,
} from "./flows/redact.js";
export { writeReplacing } from "./flows/settings-write.js";
export { SNAPSHOT_SCHEMA_URL } from "./flows/snapshot.js";
export {
  SECRET_RESPONSE_WITHHELD,
  SECRET_TRANSPORT_WITHHELD,
  type TraceIo,
} from "./github/api.js";
export { getRepoFile } from "./github/repo-file.js";
export { createVisibilityResolver, type RepoVisibility } from "./github/repo-visibility.js";
export {
  type CentralFileProblem,
  type LayerProblem,
  type ProblemOf,
  quoteList,
  RERUN_ADVICE,
  type SettingsProblem,
  type TopLevelShape,
} from "./problem.js";
export {
  applyMarkerInjection,
  PRIVATE_REPORT_CHANNELS,
} from "./report/delivery.js";
export { ISSUE_TITLE, MARKER_LABEL, MARKER_LABEL_CONFIG } from "./report/issue-report.js";
export { DOCUMENT_DIRECTIVE_KEYS, PROBOT_PARITY_KEYS } from "./schema.js";
export {
  denialPosture,
  type KeyedListLayering,
  readGating,
  type SectionMeta,
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
export { countNoun } from "./text.js";
export type { MustBeNever, UndeclaredPolicy, UndeclaredPolicyList } from "./types.js";
