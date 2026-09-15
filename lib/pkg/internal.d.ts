import { $ as toPublicView, $n as LayerProblem, $t as MustBeNever, Bt as Tolerance, C as parseSnapshotFileConfig, Ct as preflightProbe, E as SNAPSHOT_SCHEMA_URL, Et as validateSettingsDoc, F as ResolvedTargets, Gt as SectionMeta, H as RunFlowConfig, I as TargetsConfig, J as PublicTargetView, Jt as denialPosture, K as PRIVATE_REPOS_POLICIES, L as resolveTargets, Lt as PlannedOpBase, Mn as SECRET_TRANSPORT_WITHHELD, N as DEFAULT_SETTINGS_FILE, Nn as TraceIo, On as GitHubClient, Pt as Justification, Q as publicDetail, Qn as CentralFileProblem, Qt as writeGatedReads, Sn as VISIBILITY_FILTERS, Tt as skippedSectionKeys, Vt as Unverifiable, Wt as KeyedListLayering, X as capturingIo, Yt as readGating, Z as planRedaction, Zt as sectionOperations, _n as ARCHIVED_FILTERS, a as DEFAULT_PRIVATE_REPOS, ar as TopLevelShape, b as SNAPSHOT_REJECTED_INPUTS, bn as DiscoveryProblem, bt as RepoRunResult, c as InputDecl, cn as SectionPermission, cr as DOCUMENT_DIRECTIVE_KEYS, ct as RepoVisibility, d as MERGE_INPUTS, en as UndeclaredPolicy, et as PRIVATE_REPORT_CHANNELS, f as MERGE_ONLY_INPUTS, ft as SnapshotResult, gn as AFFILIATIONS, h as Mode, hn as stripNulls, ir as SettingsProblem, jn as SECRET_RESPONSE_WITHHELD, l as InputName, ln as grantFor, lr as PROBOT_PARITY_KEYS, lt as createVisibilityResolver, m as MODES, mn as mergeLayers, mt as renderSnapshotYaml, n as foldLayers, nr as RERUN_ADVICE, nt as applyMarkerInjection, o as FILTER_INPUTS, p as MERGE_REJECTED_INPUTS, pt as SnapshotRunOptions, q as PrivateReposPolicy, s as INPUT_DECLS, sn as PatResource, sr as quoteList, t as FoldedLayers, tn as UndeclaredPolicyList, tr as ProblemOf, ut as RenderableSnapshot, v as SNAPSHOT_INPUTS, vt as RepoResult, w as snapshotFileDestination, wn as ApiError, wt as runForRepo, x as SnapshotFileConfig, xn as FORKS_FILTERS, y as SNAPSHOT_ONLY_INPUTS, yt as RepoRunOptions } from "./layers-D_4LQCVR.js";
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
export { AFFILIATIONS, ARCHIVED_FILTERS, type CentralFileProblem, DEFAULT_PRIVATE_REPOS, DEFAULT_SETTINGS_FILE, DOCUMENT_DIRECTIVE_KEYS, type DiscoveryProblem, FILTER_INPUTS, FORKS_FILTERS, type FoldedLayers, INPUT_DECLS, type InputDecl, type InputName, type Justification, type KeyedListLayering, type LayerProblem, MERGE_INPUTS, MERGE_ONLY_INPUTS, MERGE_REJECTED_INPUTS, MODES, type Mode, type MustBeNever, PRIVATE_REPORT_CHANNELS, PRIVATE_REPOS_POLICIES, PROBOT_PARITY_KEYS, type PatResource, type PlannedOpBase, type PrivateReposPolicy, type ProblemOf, type PublicTargetView, RERUN_ADVICE, type RenderableSnapshot, type RepoResult, type RepoRunOptions, type RepoRunResult, type RepoVisibility, type ResolvedTargets, type RunFlowConfig, SECRET_RESPONSE_WITHHELD, SECRET_TRANSPORT_WITHHELD, SNAPSHOT_INPUTS, SNAPSHOT_ONLY_INPUTS, SNAPSHOT_REJECTED_INPUTS, SNAPSHOT_SCHEMA_URL, type SectionMeta, type SectionPermission, type SettingsProblem, type SnapshotFileConfig, type SnapshotResult, type SnapshotRunOptions, type TargetsConfig, type Tolerance, type TopLevelShape, type TraceIo, type UndeclaredPolicy, type UndeclaredPolicyList, type Unverifiable, VISIBILITY_FILTERS, applyMarkerInjection, capturingIo, createVisibilityResolver, denialPosture, foldLayers, grantFor, mergeLayers, parseSnapshotFileConfig, planRedaction, preflightProbe, publicDetail, quoteList, readGating, renderSnapshotYaml, resolveTargets, runForRepo, sectionOperations, skippedSectionKeys, snapshotFileDestination, stripNulls, toPublicView, validateSettingsDoc, writeGatedReads };