---
order: 7
title: "Library API"
---

# Upgrading from v2 to v3: library API

Sections 9, 23, 27, 35, 54, 56, 58, and 60 of the [v2 to v3 guide](../v2-to-v3.md), whose index page carries the summary table and the order of operations.

## 9. Library: the public entry and the v3 names

For `@vivswan/github-settings-as-code` consumers. The old form is the pre-release v3 builds' (v2.0.0's package was private and exported nothing), as in sections 24 and 29. Before and after, one program:

```text
pre-release   import { GithubApi, checkRepository, validateSettings, runForRepo } from "@vivswan/github-settings-as-code";
              const { settings, warnings } = validateSettings(doc)._unsafeUnwrap();
              await checkRepository(client, { repo, settings, onMissingPermission: "fail", sections: SectionSelection.ALL });

v3            import { GitHubApi, checkRepository, validateSettings } from "@vivswan/github-settings-as-code";
              import { runForRepo } from "@vivswan/github-settings-as-code/internal";
              const { settings, log } = validateSettings(doc)._unsafeUnwrap();
              await checkRepository(client, repo, settings);
```

The package now has two entries, and one naming family per layer:

| | pre-release | v3 |
|---|---|---|
| The entry | One, 192 names, all pinned | The public entry: the names the [library page](../../reference/library.md#the-api-by-group) tables document, under semver. The internal entry, `@vivswan/github-settings-as-code/internal`: everything else the action, the CLI, and the tests import, with no promise |
| The verbs | `checkRepository`, `applyRepository`, `snapshotRepository`, `snapshotRepositories`, `validateSettings`, plus `foldLayers` and `mergeLayers` for a merge | The same five, plus `mergeSettings`; every verb takes its inputs positionally and one options object of the same knobs (`sections`, `onMissingPermission`, `io`, ...), each defaulted as the action's input |
| The reports | `RepoRunReport` (`log`), `SnapshotReport` (`log`), `validateSettings` (`warnings: string[]`) | `CheckReport`, `ApplyReport`, `SnapshotReport`, `MergeReport`, `ValidateReport`: one `log: CollectedLine[]` on every report, the annotation level kept beside each line |

Every rename, old to new. An old name fails to compile, naming the missing export; the new name is in the public entry unless the row says the internal entry:

| pre-release | v3 |
|---|---|
| `GithubApi` | `GitHubApi` |
| `GithubClient` | `GitHubClient` |
| `MissingPermissionPolicy` | `OnMissingPermission` (the input's name) |
| `checkRepository(client, { repo, settings, onMissingPermission, sections }, io?)` | `checkRepository(client, repo, settings, { onMissingPermission?, sections?, io?, secretEnv? })`; the document's `secretSource` is `validateSettings`'s knob |
| `applyRepository(client, { repo, settings, onMissingPermission, sections }, io?)` | `applyRepository(client, repo, settings, { onMissingPermission?, sections?, io?, secretEnv? })` |
| `RepoRunReport` | `CheckReport`, `ApplyReport` |
| `RepoRunOptions` | `CheckOptions`, `ApplyOptions` (the knobs alone); the engine's `RepoRunOptions` is in the internal entry |
| `snapshotRepository(client, repo, { sections?, onMissingPermission?, io? })` | Unchanged call; its options type is `SnapshotOptions` |
| `SnapshotLibraryOptions` | `SnapshotOptions` |
| `validateSettings(doc, { source?, sections?: ReadonlySet<SectionKey> })` returning `{ settings, warnings: string[] }` | `validateSettings(doc, { source?, sections?: SectionSelection, io? })` returning `{ settings, log: CollectedLine[] }` (`ValidateOptions`, `ValidateReport`) |
| `foldLayers(layers, sourceLabel, layering, io)` | `mergeSettings(layers, { source?, layering?, io? })` returning `{ settings, notices, yaml, log }` (`MergeOptions`, `MergeReport`); `foldLayers` itself is in the internal entry |
| `mergeLayers`, `canonicalDocument`, `renderCanonicalYaml`, `renderSnapshotYaml` | The internal entry; `MergeReport.yaml` and `SnapshotReport.yaml` carry the rendered file |
| `validateSettingsDoc` | The internal entry: the engine's boundary, which prints its warnings to an `Io`; `validateSettings` collects them into `log` |
| `runForRepo`, `preflightProbe`, `skippedSectionKeys`, `RepoRunResult`, `RepoResult` | The internal entry |
| `SnapshotResult`, `RenderableSnapshot`, `SNAPSHOT_SCHEMA_URL` | The internal entry; `SnapshotReport.yaml` already carries the schema pin in its header |
| `REPO_RESULTS`, `SNAPSHOT_RESULTS`, `MERGE_RESULT` | `RUN_RESULTS` (worst first: `failed`, `drift`, `partial`, `skipped`, `applied`, `clean`, `snapshot`, `rendered`) |
| `SnapshotRunResult` | `RunOutcome` |
| `worstOf(results, check)`, with `check` picking the floor of an empty list | `worstOf(results)`; an empty list throws, since every run concludes over at least one target |
| `INPUT_DECLS`, `InputDecl`, `InputName`, `MODES`, `Mode`, `FILTER_INPUTS`, `SNAPSHOT_INPUTS`, `SNAPSHOT_ONLY_INPUTS`, `SNAPSHOT_REJECTED_INPUTS`, `parseSnapshotFileConfig`, `SnapshotFileConfig`, `DEFAULT_PRIVATE_REPOS`, `DEFAULT_SETTINGS_FILE` | The internal entry |
| `MERGE_INPUTS`, `MERGE_ONLY_INPUTS`, `MERGE_REJECTED_INPUTS` | `RENDER_INPUTS`, `RENDER_ONLY_INPUTS`, `RENDER_REJECTED_INPUTS` in the internal entry ([section 29](layering.md#29-mode-merge-is-mode-render)) |
| `resolveTargets`, `ResolvedTargets`, `TargetsConfig`, `RunFlowConfig` | The internal entry |
| `capturingIo`, `planRedaction`, `publicDetail`, `toPublicView`, `PublicTargetView`, `PRIVATE_REPOS_POLICIES`, `PrivateReposPolicy` | The internal entry |
| `getRepoFile`, `createVisibilityResolver`, `RepoVisibility`, `SECRET_RESPONSE_WITHHELD`, `SECRET_TRANSPORT_WITHHELD`, `TraceIo` | The internal entry |
| `applyMarkerInjection`, `PRIVATE_REPORT_CHANNELS`, `ISSUE_TITLE`, `MARKER_LABEL`, `MARKER_LABEL_CONFIG` | The internal entry |
| `AFFILIATIONS`, `ARCHIVED_FILTERS`, `FORKS_FILTERS`, `VISIBILITY_FILTERS`, `DiscoveryProblem` | The internal entry |
| `stripNulls`, `describeOptOut`, `OptOutNotice` | Removed: the fold reads no `null` as a marker ([section 31](layering.md#31-null-wins-and-means-empty-and-_remove-drops-an-entry)); `describeRemoval` and `RemovalNotice` describe a `_remove` |
| `quoteList`, `RERUN_ADVICE`, `ProblemOf`, `SettingsProblem`, `LayerProblem`, `CentralFileProblem`, `TopLevelShape` | The internal entry |
| `DOCUMENT_DIRECTIVE_KEYS`, `PROBOT_PARITY_KEYS`, `UndeclaredPolicy`, `UndeclaredPolicyList`, `MustBeNever` | The internal entry; `UNDECLARED_POLICY_SECTIONS` and `UndeclaredPolicySection` stay public |
| `denialPosture`, `readGating`, `writeGatedReads`, `sectionOperations`, `SectionMeta`, `KeyedListLayering`, `grantFor`, `PatResource`, `SectionPermission` | The internal entry |
| `Justification`, `PlannedOpBase`, `Tolerance`, `Unverifiable` | The internal entry |
| `concludeSnapshot` set `repos-result` only in the dir form; `concludeMerge` set no `repos-result` | Every conclude sets the three outputs |
| `FinishedSnapshot` carried `view` / `views`: each target already projected into a `SnapshotTargetView` | `FinishedSnapshot` carries `target` / `targets`: each a `TargetOutcome` whose `detail` is sealed for a hidden target; `concludeSnapshot` opens it through `publicDetail` / `toPublicView` |
| `SnapshotTargetView` (snapshot's own redacted projection) | Removed; the shared redaction-safe projection is `PublicTargetView` in the internal entry, which now carries the snapshot `file` |

## 23. Library: one owner per refusal, one selection type

For `@vivswan/github-settings-as-code` consumers.

| v2 | v3 |
|---|---|
| `parseConfig(read, env)`; the command line refused `private-report: artifact` before calling it, and the flows checked for the uploader again (`artifact-uploader-missing`) | `parseConfig(read, env, { artifactUpload })`: the one refusal, `input-artifact-unsupported`; `runSingle` and `runMulti` no longer check |
| `executeRun(cfg, deps): Promise<number>`, with `deps.describe` rewording a fatal problem | `executeRun(cfg, deps): Promise<RunEnd>`, `{ exitCode, fatal? }`; `failRun(io, problem)` takes no wording hook |
| `validateSettings(doc, { sections?: ReadonlySet<SectionKey> })` | `validateSettings(doc, { sections?: SectionSelection })`; `SectionSelection.ALL` for no allowlist |
| `SettingsFileRole`: `settings-file`, `defaults-file`, `layer` | plus `central-file`, the repos-dir file a multi-repo target is read from |

The same change reshaped `validateSettingsDoc`, `parseSnapshotFileConfig`, `snapshotFileDestination`, and `writeReplacing`. All four are internal-entry names, so the intro's rule applies.


## 27. Library: one problem code for a malformed document

For `@vivswan/github-settings-as-code` consumers. The left column is the pre-release v3 builds' shape, as in sections 24 and 29.

| Pre-release | v3 |
|---|---|
| `settings-unknown-directives`: an unknown underscore key stopped the run alone | A line of `settings-malformed-sections`: `unknown underscore key: _owner. ...` |
| `settings-unknown-sections`: an unknown section stopped the run alone | A line of the same problem: `unknown top-level section: stickers (known: ...)` |

A `switch` on `Problem.code` that names either deleted code fails to compile. Drop the case; the lines are in the `issues` of `settings-malformed-sections`, before the section issues: the underscore line first, then the unknown-section line.

## 35. Library: plan() takes only validator-minted input

For `@vivswan/github-settings-as-code` consumers. The old form is the pre-release v3 builds', as in sections 24 and 29.

```text
pre-release   const labels = sectionModule("labels");
              await labels.plan(planContext(labels, client, repo), [{ name: "bug" }, { name: "Bug" }]);
              // compiled: a caller could hand the planner a pair the validator refuses

v3            const { settings } = validateSettings(doc)._unsafeUnwrap();
              if (settings.labels !== undefined) {
                await labels.plan(planContext(labels, client, repo), settings.labels);
              }
              // settings.labels is the ValidatedInput<"labels"> the planner takes, or undefined when the file has no labels section
```

The old call fails to compile with `Property '[validatedInput]' is missing in type '{ name: string; }[]' but required in type 'ValidatedBrand<"labels">'`. Pass the section off a validated document: `validateSettings(doc)`, `mergeSettings(layers)`, or `snapshotRepository(...)` returns `settings`, and each section of it carries the brand. `SectionInput<K>`, the unbranded shape, stays exported for a custom module's `validate` hook.

## 54. Library: a parsed ruleset entry carries `target` and `enforcement`

For `@vivswan/github-settings-as-code` consumers. The old form is the pre-release v3 builds', as in sections 24 and 29. The settings file is unchanged: both keys stay optional there, and the parse fills `target: branch` and `enforcement: active`.

The parsed entry always carries both, so the full-payload PUT sends them and the comparison never reads a live value under either key as omitted. The parsed type says so, and a typed literal that omits them stops compiling.

```text
pre-release   const doc: SettingsFile = { rulesets: [{ name: "main" }] };            // compiles

v3            const doc: SettingsFile = { rulesets: [{ name: "main" }] };            // TS2739: target and enforcement are missing
              const { settings } = validateSettings({ rulesets: [{ name: "main" }] })._unsafeUnwrap();  // parsed: both keys filled
              const doc: SettingsFile = { rulesets: [{ name: "main", target: "branch", enforcement: "active" }] };
```

`sectionModule("rulesets").plan` takes the parsed entry, so a hand-built entry handed to it needs both keys too.

An entry cast past the type gets two omitted-key drift lines, since nothing fills them after the parse.

## 56. Library: `plan()` and `snapshot()` resolve to a `Result`

For `@vivswan/github-settings-as-code` consumers. The old form is the pre-release v3 builds', as in sections 24, 29, 35, and 54.

A section never throws for what a user can cause. `plan()` and `snapshot()` resolve to a neverthrow `Result`: the plan or snapshot on `Ok`, a `SectionFailure` on `Err`, whose `message` is the whole line the action reports and whose `kind` names the policy the engine applies (`"permission-denied"` carries the section, the detail, and the HTTP status beside it). Every line is the one the thrown error carried.

```text
pre-release   const plan = await labels.plan(ctx, declared);          // resolves to the plan, rejects on a denied read
              plan.ops.length;

v3            const planned = await labels.plan(ctx, declared);       // resolves to Result<SectionPlan, SectionFailure>
              if (planned.isErr()) throw new Error(planned.error.message);
              planned.value.ops.length;
```

The change hook of a planned operation, its capture hook, and its `before`, `payload`, and `variables` thunks return a `Result` too; a hook that used to throw its verification failure returns `err(...)` with the same text.

A rejection out of `plan()` or `snapshot()` now means one of three things: the module was handed another section's context (the guard the [library page](../../reference/library.md#sections) describes, unchanged), the `GitHubClient` you supplied threw instead of answering (section 58), or a `BUG:` invariant fired.

Fix: match on the `Result` (`isErr()`, `match`, or `_unsafeUnwrap()` in a test) where the awaited value was read directly, and assert `Err` where a test asserted a rejection.

## 58. Library: `GitHubClient` and `ArtifactUploader` answer, never reject

For `@vivswan/github-settings-as-code` consumers. The old form is the pre-release v3 builds', as in section 56.

`GitHubApi` never rejects. A request with no HTTP answer resolves to the `failed` arm of `ClientAnswer`, carrying the whole line the action reports (the request, the reason, the remedy). The reason is withheld where the request carried a secret, and for a GraphQL request where the repository is redacted.

The engine reads that arm wherever it read the throw:

- a section fails with kind `transport`
- discovery reports its transport problem
- a multi-repo target fails with the line, where the run used to stop
- the private-report channels warn without it

```text
pre-release   const answer = await client.tryRequest("GET", path);      // rejects on a network failure
              if ("error" in answer) ...

v3            const answer = await client.tryRequest("GET", path);      // resolves to ClientAnswer<unknown>
              if ("failed" in answer) throw new Error(answer.failed);
              if ("error" in answer) ...
```

`ArtifactUploader.upload()` resolves to `{ uploaded: true }` or `{ failed }`; `deliverArtifactReport` renders `failed` into its warning as it rendered the throw. A client or uploader that still throws is not classified: a section reports it under kind `thrown`, the report channels warn with their slug-free line.

Fix: add the `failed` arm to every `GitHubClient` double and read it before `error`; return `{ uploaded: true }` from every `ArtifactUploader` double.

## 60. Library: `GitHubClient` lists through `tryList()`

For `@vivswan/github-settings-as-code` consumers. The old form is the pre-release v3 builds', as in section 56.

Every paginated REST list read (labels, rulesets, the secrets envelopes, discovery's `/user/repos`, the report's issue scan) goes through the port's third member, `tryList(path, { perPage, until })`. It resolves to a `ClientAnswer<unknown[]>` whose `data` holds one body per page, in order, as GitHub sent it: a bare list, or the `{total_count, <key>: []}` envelope, which the caller reads by its key. `GitHubApi` follows GitHub's `Link: <url>; rel="next"` header through `@octokit/plugin-paginate-rest`, and keeps every page on the route the caller named, taking only the Link's query (`per_page`, `page`) from GitHub. A 409 surfaces as the error it is. The pre-release builds walked `tryRequest("GET", path?per_page=100&page=N)` themselves and stopped on a short page.

```text
pre-release   tryRequest("GET", "/repos/o/r/labels?per_page=100&page=1")   // the engine asked page by page
              tryRequest("GET", "/repos/o/r/labels?per_page=100&page=2")

v3            tryList("/repos/o/r/labels", { perPage: 100 })               // resolves to { data: [page1Body, page2Body] }
```

Fix: add `tryList` to every `GitHubClient` double: answer the pages your `tryRequest` route table would (`per_page=N&page=K` from 1, until a page is short) and return their bodies as `{ data: [...] }`; a client over another transport returns each page's body as received, and honors `until` by stopping after the first page it accepts.
