import { $ as toPublicView, $t as Tolerance, C as parseSnapshotFileConfig, Ct as preflightProbe, E as SNAPSHOT_SCHEMA_URL, En as VISIBILITY_FILTERS, Et as validateSettingsDoc, F as DEFAULT_SETTINGS_FILE, Gt as writeGatedReads, H as RunFlowConfig, Ht as readGating, In as SECRET_RESPONSE_WITHHELD, It as SectionMeta, J as PublicTargetView, K as PRIVATE_REPOS_POLICIES, L as ResolvedTargets, Ln as SECRET_TRANSPORT_WITHHELD, Nn as GitHubClient, On as ApiError, Pt as KeyedListLayering, Q as publicDetail, R as TargetsConfig, Rn as TraceIo, Tn as FORKS_FILTERS, Tt as skippedSectionKeys, Vt as denialPosture, Wt as sectionOperations, X as capturingIo, Xt as PlannedOpBase, Z as planRedaction, _n as MustBeNever, a as DEFAULT_PRIVATE_REPOS, b as SNAPSHOT_REJECTED_INPUTS, bn as AFFILIATIONS, bt as RepoRunResult, c as InputDecl, ct as RepoVisibility, d as MODES, dn as grantFor, en as Unverifiable, et as PRIVATE_REPORT_CHANNELS, f as Mode, fr as quoteList, ft as SnapshotResult, gn as mergeLayers, h as RENDER_REJECTED_INPUTS, ir as LayerProblem, l as InputName, ln as PatResource, lr as SettingsProblem, lt as createVisibilityResolver, m as RENDER_ONLY_INPUTS, mr as PROBOT_PARITY_KEYS, mt as renderSnapshotYaml, n as foldLayers, nt as applyMarkerInjection, o as FILTER_INPUTS, or as ProblemOf, p as RENDER_INPUTS, pr as DOCUMENT_DIRECTIVE_KEYS, pt as SnapshotRunOptions, q as PrivateReposPolicy, qt as Justification, rr as CentralFileProblem, s as INPUT_DECLS, sr as RERUN_ADVICE, t as FoldedLayers, un as SectionPermission, ur as TopLevelShape, ut as RenderableSnapshot, v as SNAPSHOT_INPUTS, vn as UndeclaredPolicy, vt as RepoResult, w as snapshotFileDestination, wn as DiscoveryProblem, wt as runForRepo, x as SnapshotFileConfig, xn as ARCHIVED_FILTERS, y as SNAPSHOT_ONLY_INPUTS, yn as UndeclaredPolicyList, yt as RepoRunOptions, z as resolveTargets } from "./layers-MA87H-hC.js";
import { Result } from "neverthrow";
//#region src/engine/canonical.d.ts
/** The document as a fresh tree in the canonical order; the input is left as it was. */
export declare function canonicalDocument(document: Readonly<Record<string, unknown>>): Record<string, unknown>;
/**
 * The document's YAML, the one rendering the snapshot file and the merged file share. The walk rebuilds every node,
 * so the writer meets no shared object and emits no alias (an alias would trip the reader's cap on the next run).
 */
export declare function renderCanonicalYaml(document: Readonly<Record<string, unknown>>): string;
//#endregion
//#region src/flows/settings-write.d.ts
/**
 * The error is the filesystem's own reason; each caller names the input that chose the path. The staging file sits in
 * the destination's directory, spelled as the caller spelled it up to the leaf (a `link/..` segment is the OS's to
 * resolve, the same way for both names; a drive-relative `C:x` stays on that drive's current directory, which dirname
 * or join would turn into the drive root), under a short name of its own (the destination's leaf may already be at
 * NAME_MAX), and takes an existing regular destination's mode, so a replaced 0600 file stays 0600.
 */
export declare function writeReplacing(path: string, text: string): Result<void, string>;
//#endregion
//#region src/github/repo-file.d.ts
export declare function getRepoFile(api: GitHubClient, slug: string, filePath: string): Promise<{
  content: string;
} | {
  missing: true;
} | {
  unproven: string;
} | {
  error: ApiError;
} | {
  failed: string;
}>;
//#endregion
//#region src/report/issue-report.d.ts
/** The lookup key: one exact-titled report issue per repo, forever reused. */
export declare const ISSUE_TITLE = "[automated] settings-as-code: private settings report";
/** Makes the lookup one indexed request; the search API is eventually consistent and separately throttled, so it is never used. */
export declare const MARKER_LABEL = "settings-as-code-report";
export declare const MARKER_LABEL_CONFIG: {
  readonly name: "settings-as-code-report";
  readonly color: "0e2a47";
  readonly description: "managed by settings-as-code private reporting - do not remove";
};
//#endregion
//#region src/text.d.ts
export declare function countNoun(count: number, one: string, many: string): string;
//#endregion
export { AFFILIATIONS, ARCHIVED_FILTERS, type CentralFileProblem, DEFAULT_PRIVATE_REPOS, DEFAULT_SETTINGS_FILE, DOCUMENT_DIRECTIVE_KEYS, type DiscoveryProblem, FILTER_INPUTS, FORKS_FILTERS, type FoldedLayers, INPUT_DECLS, type InputDecl, type InputName, type Justification, type KeyedListLayering, type LayerProblem, MODES, type Mode, type MustBeNever, PRIVATE_REPORT_CHANNELS, PRIVATE_REPOS_POLICIES, PROBOT_PARITY_KEYS, type PatResource, type PlannedOpBase, type PrivateReposPolicy, type ProblemOf, type PublicTargetView, RENDER_INPUTS, RENDER_ONLY_INPUTS, RENDER_REJECTED_INPUTS, RERUN_ADVICE, type RenderableSnapshot, type RepoResult, type RepoRunOptions, type RepoRunResult, type RepoVisibility, type ResolvedTargets, type RunFlowConfig, SECRET_RESPONSE_WITHHELD, SECRET_TRANSPORT_WITHHELD, SNAPSHOT_INPUTS, SNAPSHOT_ONLY_INPUTS, SNAPSHOT_REJECTED_INPUTS, SNAPSHOT_SCHEMA_URL, type SectionMeta, type SectionPermission, type SettingsProblem, type SnapshotFileConfig, type SnapshotResult, type SnapshotRunOptions, type TargetsConfig, type Tolerance, type TopLevelShape, type TraceIo, type UndeclaredPolicy, type UndeclaredPolicyList, type Unverifiable, VISIBILITY_FILTERS, applyMarkerInjection, capturingIo, createVisibilityResolver, denialPosture, foldLayers, grantFor, mergeLayers, parseSnapshotFileConfig, planRedaction, preflightProbe, publicDetail, quoteList, readGating, renderSnapshotYaml, resolveTargets, runForRepo, sectionOperations, skippedSectionKeys, snapshotFileDestination, toPublicView, validateSettingsDoc, writeGatedReads };