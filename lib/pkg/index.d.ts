import { $n as RepoRef, A as SingleConfig, An as DEFAULT_API_VERSION, At as TaggedEndpoint, B as runMulti, Bn as isRateLimitError, Bt as ValidatedInput, Cn as DiscoveryFilters, D as SnapshotConfig, Dn as discoverRepos, Dt as SectionSelection, Fn as RequestMark, Ft as SectionInput, G as failRun, Gn as OutputName, Hn as CollectedLine, I as MultiConfig, Jn as prefixedIo, Jt as OnMissingPermission, Kn as collectingIo, Kt as DenialPolicy, Lt as SectionModule, M as runSingle, Mn as GitHubApiOptions, Mt as allGraphqlOps, N as RenderConfig, Nn as GitHubClient, Nt as sectionModule, O as concludeSnapshot, On as ApiError, Ot as SettingsSource, P as runRender, Pn as GraphqlOp, Qn as RemoteTarget, Qt as SnapshotContext, Rt as SectionSnapshot, S as parseConfig, Sn as DEFAULT_DISCOVERY_FILTERS, St as ValidatedSettings, T as FinishedSnapshot, U as concludeRender, Un as Io, Ut as sectionGrant, V as FinishedRender, Vn as AnnotationLevel, W as concludeRun, Wn as MaskPair, Xn as silentIo, Y as TargetOutcome, Yn as redactRanges, Yt as PlanContext, Zn as CentralTarget, Zt as SectionPlan, _ as RunConfig, _r as SettingsFile, _t as worstOf, an as EndpointDecl, ar as Problem, at as deliverArtifactReport, br as Layering, bt as RepoRunResult, cn as endpointPath, cr as SettingsFileRole, dr as describeProblem, dt as SectionSnapshotOutcome, er as Target, fn as FoldOptions, ft as SnapshotResult, g as RunCapabilities, gr as SectionKey, gt as RunOutcome, hn as describeRemoval, hr as SECTION_KEYS, ht as RUN_RESULTS, i as ConfigEnv, in as SectionFailure, ir as LayerProblem, it as ArtifactUploader, j as SingleOutcome, jn as GitHubApi, jt as allEndpoints, k as runSnapshot, kn as ClientAnswer, kt as SECTIONS, lr as SettingsProblem, mn as RemovalNotice, nn as snapshotContext, nr as parseRepoSlug, on as Route, or as ProblemOf, ot as encryptReport, pn as Layer, qn as maskRegistry, r as readLayerFiles, rn as GraphqlOpDecl, rt as openReportChannel, sn as endpointMethod, st as parseRecipient, tn as planContext, tr as dedupeTargets, tt as PrivateReportChannel, u as InputReader, ut as RenderableSnapshot, vn as UndeclaredPolicy, vr as UNDECLARED_POLICY_SECTIONS, xt as SectionOutcome, yr as UndeclaredPolicySection, yt as RepoRunOptions, zn as isPermissionError, zt as ValidatedBrand } from "./layers-CzQ_6juY.js";
import { Result } from "neverthrow";
//#region src/discovery/central.d.ts
export declare function resolveCentralTargets(reposDir: string, adminOwner: string): Result<{
  targets: CentralTarget[];
  warnings: string[];
}, ProblemOf<"repos-dir-missing" | "repos-dir-unreadable" | "repos-dir-invalid-files">>;
//#endregion
//#region src/discovery/repos-input.d.ts
export declare function parseReposInput(raw: string): Result<{
  slugs: string[];
  discover: boolean;
}, ProblemOf<"repos-input-wildcard-mixed" | "repos-input-invalid-entries">>;
//#endregion
//#region src/flows/execute.d.ts
/** What a face hands the executor; the config carries everything else. */
interface RunDeps {
  readonly io: Io;
  /** Opens the client a config's token authorizes; a merge never asks for one. */
  readonly createClient: (token: string, io: Io, apiVersion: string) => GitHubClient;
  /** The artifact channel's uploader; parseConfig refuses that channel for a face that declares no upload capability. */
  readonly uploader?: ArtifactUploader;
}
/**
 * How a run ended: its exit code, and the problem it ended in when it never reached a target (the outputs and the
 * error line are already through `deps.io`; the command line's --json envelope carries the problem's text beside them).
 */
interface RunEnd {
  readonly exitCode: number;
  readonly fatal?: Problem;
}
export declare function executeRun(cfg: RunConfig, deps: RunDeps): Promise<RunEnd>;
//#endregion
//#region src/flows/library.d.ts
/** The knobs every verb over a document takes. */
interface ValidateOptions {
  /** How the document is named in problems and warnings; a file path, usually. */
  source?: string;
  /** The `sections` allowlist: an unknown top-level key outside a non-empty one is a warning, not an error. */
  sections?: SectionSelection;
  /** Where the warnings print; without one they come back as the report's `log`. */
  io?: Io;
  /** The action's `undeclared` input: the fallback policy below a list's wrapper and the file's own; unset by default. */
  undeclared?: UndeclaredPolicy;
  /** Who authored the document: "operator" (the default) honors `$NAME` secret references, "target" refuses them. */
  secretSource?: SettingsSource;
}
interface ValidateReport {
  settings: ValidatedSettings;
  log: CollectedLine[];
}
/** Validate a parsed document into the branded settings every other verb takes. */
export declare function validateSettings(doc: unknown, options?: ValidateOptions): Result<ValidateReport, SettingsProblem>;
interface MergeOptions {
  /** How the merged document is named in problems and warnings. */
  source?: string;
  /** How the list sections fold across layers; the action's `layering` input, "deep" unless set. */
  layering?: FoldOptions["layering"];
  /** The action's `undeclared` input: the fallback policy below a list's wrapper and the file's own; unset by default. */
  undeclared?: UndeclaredPolicy;
  io?: Io;
}
/** The fold's result: the merged document, its removal notices, and the file text mode: render writes, byte for byte. */
interface MergeReport {
  settings: ValidatedSettings;
  notices: RemovalNotice[];
  yaml: string;
  log: CollectedLine[];
}
/** Fold an ordered list of layers into one validated document, as mode: render does. */
export declare function mergeSettings(layers: readonly Layer[], options?: MergeOptions): Result<MergeReport, SettingsProblem | LayerProblem>;
/** The knobs a run over one repository takes, each defaulted as the action's input of the same name. */
interface RepositoryOptions {
  sections?: SectionSelection;
  onMissingPermission?: RepoRunOptions["onMissingPermission"];
  io?: Io;
  secretEnv?: RepoRunOptions["secretEnv"];
}
type CheckOptions = RepositoryOptions;
type ApplyOptions = RepositoryOptions;
/** The engine's result plus every line the run printed when the caller brought no Io of their own. */
interface RepositoryReport extends RepoRunResult {
  log: CollectedLine[];
}
type CheckReport = RepositoryReport;
type ApplyReport = RepositoryReport;
/** Plan and diff every active section without writing. */
export declare function checkRepository(client: GitHubClient, repo: RepoRef, settings: ValidatedSettings, options?: CheckOptions): Promise<CheckReport>;
/** Execute the plan: the repository converges on the document. */
export declare function applyRepository(client: GitHubClient, repo: RepoRef, settings: ValidatedSettings, options?: ApplyOptions): Promise<ApplyReport>;
/** The knobs a snapshot takes: the same three, since a snapshot never writes. */
interface SnapshotOptions {
  sections?: SectionSelection;
  onMissingPermission?: RepoRunOptions["onMissingPermission"];
  io?: Io;
}
/**
 * The engine's snapshot result plus the file text mode: snapshot would write
 * (absent exactly when the result is failed, which carries no document), the
 * moment the reads began (`takenAt`: the file carries no date, and the report
 * is the library's summary, so it states the moment where the action's summary
 * and notice do), and every line the run printed when the caller brought no Io
 * of their own.
 */
type SnapshotReport = ((RenderableSnapshot & {
  yaml: string;
}) | (Extract<SnapshotResult, {
  result: "failed";
}> & {
  yaml?: never;
})) & {
  takenAt: string;
  log: CollectedLine[];
};
/** Read one repository's supported sections back as a settings document and its rendered file. */
export declare function snapshotRepository(client: GitHubClient, repo: RepoRef, options?: SnapshotOptions): Promise<SnapshotReport>;
/** Snapshot several repositories in order, one report each; a failed target never stops the rest. */
export declare function snapshotRepositories(client: GitHubClient, repos: readonly RepoRef[], options?: SnapshotOptions): Promise<SnapshotReport[]>;
//#endregion
//#region src/flows/settings-read.d.ts
/**
 * `logLevel: "error"` is load-bearing: at its default the parser reports a warning (an unresolved tag, an anchor ending
 * in ":") on a SUCCESSFUL parse through process.emitWarning, quoting the offending source line with its values straight
 * to stderr, which nothing here redacts. Empty and null documents become {}.
 *
 * "error"   -> warnings silent; a syntax error still throws into the error path
 * "silent"  -> would also swallow the syntax errors
 *
 * `merge: true` resolves `<<` merge keys as the Probot app's js-yaml did; off, the key survives as literal data.
 */
export declare function parseSettingsDoc(raw: string): Result<unknown, ProblemOf<"yaml-invalid">>;
export declare function readSettingsFile(path: string, role: SettingsFileRole): Result<unknown, ProblemOf<"settings-file-unreadable">>;
//#endregion
//#region src/report/composer.d.ts
interface TranscriptLine {
  level?: AnnotationLevel;
  line: string;
}
interface OutcomeRow {
  key: string;
  status: string;
  detail: string[];
}
interface ReportInput {
  /** The target's owner/name slug, unredacted: this document is private. */
  target: string;
  adminRepo: string;
  runUrl: string;
  mode: string;
  result: string;
  timestamp: string;
  outcomes: OutcomeRow[];
  transcript: TranscriptLine[];
}
export declare function composeReport(input: ReportInput): string;
//#endregion
export { type AnnotationLevel, type ApiError, type ApplyOptions, type ApplyReport, type ArtifactUploader, type CentralTarget, type CheckOptions, type CheckReport, type ClientAnswer, type CollectedLine, type ConfigEnv, DEFAULT_API_VERSION, DEFAULT_DISCOVERY_FILTERS, type DenialPolicy, type DiscoveryFilters, type EndpointDecl, type FinishedRender, type FinishedSnapshot, GitHubApi, type GitHubApiOptions, type GitHubClient, type GraphqlOp, type GraphqlOpDecl, type InputReader, type Io, type Layer, type Layering, type MaskPair, type MergeOptions, type MergeReport, type MultiConfig, type OnMissingPermission, type OutputName, type PlanContext, type PrivateReportChannel, type Problem, RUN_RESULTS, type RemoteTarget, type RemovalNotice, type RenderConfig, type RepoRef, type ReportInput, type RequestMark, type Route, type RunCapabilities, type RunConfig, type RunDeps, type RunEnd, type RunOutcome, SECTIONS, SECTION_KEYS, type SectionFailure, type SectionInput, type SectionKey, type SectionModule, type SectionOutcome, type SectionPlan, SectionSelection, type SectionSnapshot, type SectionSnapshotOutcome, SettingsFile, type SettingsFileRole, type SingleConfig, type SingleOutcome, type SnapshotConfig, type SnapshotContext, type SnapshotOptions, type SnapshotReport, type TaggedEndpoint, type Target, type TargetOutcome, UNDECLARED_POLICY_SECTIONS, type UndeclaredPolicySection, type ValidateOptions, type ValidateReport, type ValidatedBrand, type ValidatedInput, type ValidatedSettings, allEndpoints, allGraphqlOps, collectingIo, concludeRender, concludeRun, concludeSnapshot, dedupeTargets, deliverArtifactReport, describeProblem, describeRemoval, discoverRepos, encryptReport, endpointMethod, endpointPath, failRun, isPermissionError, isRateLimitError, maskRegistry, openReportChannel, parseConfig, parseRecipient, parseRepoSlug, planContext, prefixedIo, readLayerFiles, redactRanges, runMulti, runRender, runSingle, runSnapshot, sectionGrant, sectionModule, silentIo, snapshotContext, worstOf };