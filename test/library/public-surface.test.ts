/**
 * The public entry's contract: src/index.ts exports exactly the pinned names
 * (a new or dropped export is a deliberate edit here), and the action reaches
 * the rest of src/ only through it - a direct import is seen failing.
 */

import { describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSync } from "oxc-parser";
import { ARCHITECTURE_PATH, lintArchitecture } from "../../.github/scripts/arch-lint.js";

const ROOT = join(import.meta.dir, "..", "..");
const ENTRY = "src/index.ts";

/** Every name src/index.ts exports, runtime and type-only alike, sorted. */
function exportedNames(): string[] {
  const path = join(ROOT, ENTRY);
  const { module } = parseSync(path, readFileSync(path, "utf8"));
  return module.staticExports
    .flatMap((statement) => statement.entries.map((entry) => entry.exportName.name))
    .filter((name): name is string => name !== null && name !== undefined)
    .sort();
}

describe("the public entry", () => {
  test("exports exactly the pinned names", () => {
    expect(exportedNames()).toEqual([
      "AFFILIATIONS",
      "ARCHIVED_FILTERS",
      "AnnotationLevel",
      "ApiError",
      "ArtifactUploader",
      "CentralFileProblem",
      "CentralTarget",
      "CollectedLine",
      "DEFAULT_API_VERSION",
      "DEFAULT_DISCOVERY_FILTERS",
      "DEFAULT_SETTINGS_FILE",
      "DOCUMENT_DIRECTIVE_KEYS",
      "DiscoveryFilters",
      "DiscoveryProblem",
      "EndpointDecl",
      "FORKS_FILTERS",
      "FinishedMerge",
      "GithubApi",
      "GithubClient",
      "GraphqlOp",
      "GraphqlOpDecl",
      "ISSUE_TITLE",
      "Io",
      "KeyedListLayering",
      "Layer",
      "LayerProblem",
      "Layering",
      "MARKER_LABEL",
      "MARKER_LABEL_CONFIG",
      "MERGE_RESULT",
      "MaskPair",
      "MergeConfig",
      "MultiConfig",
      "MustBeNever",
      "OptOutNotice",
      "OutputName",
      "PRIVATE_REPORT_CHANNELS",
      "PRIVATE_REPOS_POLICIES",
      "PROBOT_PARITY_KEYS",
      "PatResource",
      "PrivateReportChannel",
      "PrivateReposPolicy",
      "Problem",
      "ProblemOf",
      "PublicTargetView",
      "REPO_RESULTS",
      "RERUN_ADVICE",
      "RemoteTarget",
      "RepoRef",
      "RepoResult",
      "RepoRunOptions",
      "RepoRunReport",
      "RepoRunResult",
      "RepoVisibility",
      "ReportInput",
      "Route",
      "RunFlowConfig",
      "SECTIONS",
      "SECTION_KEYS",
      "SectionKey",
      "SectionMeta",
      "SectionModule",
      "SectionOutcome",
      "SectionPermission",
      "SettingsFile",
      "SettingsFileRole",
      "SettingsProblem",
      "SingleConfig",
      "SingleOutcome",
      "TaggedEndpoint",
      "Target",
      "TargetOutcome",
      "TopLevelShape",
      "TraceIo",
      "UNDECLARED_POLICY_SECTIONS",
      "UndeclaredPolicy",
      "UndeclaredPolicyList",
      "UndeclaredPolicySection",
      "VISIBILITY_FILTERS",
      "ValidatedSettings",
      "allEndpoints",
      "allGraphqlOps",
      "applyMarkerInjection",
      "applyRepository",
      "capturingIo",
      "checkRepository",
      "collectingIo",
      "composeReport",
      "concludeMerge",
      "concludeRun",
      "createVisibilityResolver",
      "dedupeTargets",
      "deliverArtifactReport",
      "denialPosture",
      "describeOptOut",
      "describeProblem",
      "discoverRepos",
      "encryptReport",
      "endpointMethod",
      "endpointPath",
      "failRun",
      "foldLayers",
      "getRepoFile",
      "grantFor",
      "isPermissionError",
      "isRateLimitError",
      "maskRegistry",
      "mergeLayers",
      "openReportChannel",
      "parseRecipient",
      "parseRepoSlug",
      "parseReposInput",
      "parseSettingsDoc",
      "planRedaction",
      "prefixedIo",
      "preflightProbe",
      "publicDetail",
      "quoteList",
      "readGating",
      "readLayerFiles",
      "readSettingsFile",
      "renderMergedYaml",
      "resolveCentralTargets",
      "runForRepo",
      "runMerge",
      "runMulti",
      "runSingle",
      "sectionGrant",
      "sectionModule",
      "sectionOperations",
      "silentIo",
      "skippedSectionKeys",
      "stripNulls",
      "toPublicView",
      "validateSettings",
      "validateSettingsDoc",
      "worstOf",
      "writeGatedReads",
    ]);
  });

  test("a src/action file importing src/engine directly fails the architecture lint (negative control)", () => {
    // A copy of src/ plus the offending file: the real tree draws every declared
    // edge, so the forbidden import is the whole verdict.
    const root = mkdtempSync(join(tmpdir(), "public-surface-"));
    try {
      cpSync(join(ROOT, "src"), join(root, "src"), { recursive: true });
      cpSync(join(ROOT, ARCHITECTURE_PATH), join(root, ARCHITECTURE_PATH));
      writeFileSync(
        join(root, "src/action/direct.ts"),
        'import { runForRepo } from "../engine/orchestrate.js";\nexport const direct = runForRepo;\n',
      );
      expect(lintArchitecture(root)).toEqual([
        "forbidden import action -> engine: src/action/direct.ts -> src/engine/orchestrate.ts; move it or declare the edge",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
