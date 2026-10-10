import { $ as toPublicView, $n as SECRET_RESPONSE_WITHHELD, $t as sectionOperations, A as InputDecl, B as SNAPSHOT_REJECTED_INPUTS, Bn as TraceIo, C as TargetsConfig, Ct as preflightProbe, D as DEFAULT_PRIVATE_REPOS, Dn as VISIBILITY_FILTERS, En as FORKS_FILTERS, Et as validateSettingsDoc, F as RENDER_INPUTS, Fn as GitHubClient, Gt as Tolerance, H as RunFlowConfig, Ht as PlannedOpBase, I as RENDER_ONLY_INPUTS, J as PublicTargetView, K as PRIVATE_REPOS_POLICIES, Kt as Unverifiable, L as RENDER_REJECTED_INPUTS, N as MODES, O as FILTER_INPUTS, P as Mode, Q as publicDetail, R as SNAPSHOT_INPUTS, S as ResolvedTargets, Sn as ARCHIVED_FILTERS, Tn as DiscoveryProblem, Tt as skippedSectionKeys, X as capturingIo, Xt as denialPosture, Z as planRedaction, Zn as ApiError, Zt as readGating, _n as mergeLayers, _r as TopLevelShape, b as DEFAULT_SETTINGS_FILE, bn as UndeclaredPolicyList, br as DOCUMENT_DIRECTIVE_KEYS, bt as RepoRunResult, c as parseSnapshotFileConfig, ct as RepoVisibility, d as SNAPSHOT_SCHEMA_URL, dn as SectionPermission, dr as LayerProblem, en as writeGatedReads, er as SECRET_TRANSPORT_WITHHELD, et as PRIVATE_REPORT_CHANNELS, fn as grantFor, ft as SnapshotResult, gr as SettingsProblem, in as KeyedListLayering, j as InputName, k as INPUT_DECLS, l as snapshotFileDestination, lt as createVisibilityResolver, mr as RERUN_ADVICE, mt as renderSnapshotYaml, n as foldLayers, nt as applyMarkerInjection, o as SnapshotFileConfig, pr as ProblemOf, pt as SnapshotRunOptions, q as PrivateReposPolicy, t as FoldedLayers, tn as SectionMeta, un as PatResource, ur as CentralFileProblem, ut as RenderableSnapshot, vn as MustBeNever, vt as RepoResult, w as resolveTargets, wt as runForRepo, xn as AFFILIATIONS, xr as PROBOT_PARITY_KEYS, yn as UndeclaredPolicy, yr as quoteList, yt as RepoRunOptions, z as SNAPSHOT_ONLY_INPUTS, zt as Justification } from "./layers-Cv1VLrAL.js";
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