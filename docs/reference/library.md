---
order: 190
---

# Library

The engine behind the action is also an npm package, `@vivswan/github-settings-as-code`: ESM only, Node 22.14 or newer. Everything the action can do, a program can do through it: validate a settings document, merge layers, check or apply one repository, snapshot one, run the action's flows, discover targets, and compose the private report.

## Install

Three ways in, one package:

```bash
npm install @vivswan/github-settings-as-code@next     # the pre-release of the main commit the release PR was last refreshed on; ask for it until the first stable release
npm install @vivswan/github-settings-as-code          # the released version (npm dist-tag latest), a 0.0.0 placeholder until the first stable release
npm install github:Vivswan/github-settings-as-code#<packaged sha>   # one packaged commit: a build tag's or a release tag's
```

`bun add` takes the same three forms. A pre-release version looks like `2.0.1-main.446.20260913.g95d081d`; the [Versioning](#versioning) section says how the three relate.

The `github:` form installs a packaged commit: the child of one `main` commit, carrying that commit's tree plus `lib/pkg/` (the library build) beside `lib/index.js` (the action bundle), both built from that commit; a package CI minted names its workflow run in its message, one minted by hand in the release recovery does not.

- Its `package.json` carries none of the scripts npm's git fetcher takes as a reason to install devDependencies and run a prepare step (`prepare`, `prepack`, `build`, the install hooks), so nothing is built or installed on your side.
- Every green push to `main` mints one under the tag `build/<position>.<sha7>` and then prunes the tags to the ten newest: once ten newer commits have been packaged, a tag is deleted and GitHub may collect its commit, so a pin taken from an old tag can go on the next merge. A durable pin names a release tag's commit (`git rev-parse v2.1.0`) or an npm version.
- The tags up to v2.0.0 point at release commits on `main` from when main still committed the bundle, not at packaged commits; the packaged commits minted before the per-commit tags lived on the `build` branch, deleted on 2026-09-13.

To build the package from a checkout instead, `bun install && bun run build:lib` writes `lib/pkg/`: the entry and the internal entry with their declarations, and the CLI, the files the manifest's `exports` and `bin` point at.

## The two entries

| Import path | What it holds | Promise |
|---|---|---|
| `@vivswan/github-settings-as-code` | The documented library: every name in [the API by group](#the-api-by-group), and nothing else | Semver: a rename or a removal is a major, listed in the [upgrading guide](../upgrading/README.md) |
| `@vivswan/github-settings-as-code/internal` | What the action, the CLI, and this repository's tests import beyond the library (the input declarations, the engine's per-repository run, the redaction helpers, ...) | None: a name here may move or go in any release. Nothing outside this repository should import it |

Two more paths ride along: the committed settings.yml JSON Schema (`./settings.schema.json`) and the package's own manifest (`./package.json`).

The entries are [src/index.ts](https://github.com/Vivswan/github-settings-as-code/blob/main/src/index.ts) and [src/internal.ts](https://github.com/Vivswan/github-settings-as-code/blob/main/src/internal.ts), each a list of re-exports. The tables below are the public entry's contract: a test derives the list of names from this page and fails when `src/index.ts` exports a name no table names, or names one it does not export.

## The API by group

One table per group: the name, what kind of thing it is, and what it says. Each group has one short example; the full signatures are in the bundled declarations.

How a call reports failure depends on its group:

- A call that reads or parses input, or runs a whole flow (`validateSettings`, `mergeSettings`, `readSettingsFile`, `parseRepoSlug`, `discoverRepos`, `parseRecipient`, `runSingle`, `runMulti`, `runRender`, ...), returns a [neverthrow](https://github.com/supermacro/neverthrow) `Result` (or `ResultAsync`) whose error is a typed `Problem`; `describeProblem` renders one as the message the action would print.
- The repository verbs, `checkRepository`, `applyRepository`, and `snapshotRepository`, always resolve to a report: its `result` field carries the outcome (`clean`, `drift`, `applied`, `partial`, `skipped`, `failed`, `snapshot`) and its `outcomes` say what each section did. Every result word of every mode, the render's `rendered` included, is a `RunOutcome`; `RUN_RESULTS` ranks them worst first and `worstOf` folds a run's targets through that ranking.
- Report delivery: `deliverArtifactReport` never throws and returns `{ uploaded: true }` or `{ warning }`. Two calls throw instead: `encryptReport` on a recipient `parseRecipient` would have rejected (validate it first), and `openReportChannel` when asked for the `artifact` channel without an `ArtifactUploader`.

Every verb takes its inputs positionally and one options object of the same knobs, each defaulted as the action's input of the same name:

| Knob | Default | On |
|---|---|---|
| `sections` | `SectionSelection.ALL`: every declared section, none required | validate, check, apply, snapshot |
| `onMissingPermission` | `"fail"` | check, apply, snapshot |
| `source` | `"the settings document"`, or `"the rendered settings document"` for a merge | validate, merge |
| `layering` | `"deep"` | merge |
| `io` | A collector: the lines the call prints come back as the report's `log`, a `CollectedLine[]` (the annotation level beside each line); with your own `Io` the log is empty | every verb |

The examples continue from one another and form one program (the docs tests compile them in page order): each name is imported once, in the first example that uses it, and later examples reuse it, as they do `settings` (the Validate group's validated document), `client` (the Client group's `GitHubApi`), `repo` (the Check group's parsed slug), and `config` in the Io example (a `SingleConfig`, the action's parsed inputs, declared there).

### Validate and merge

| Name | Kind | Says |
|---|---|---|
| `validateSettings` | function | Validate a parsed document into the branded `ValidatedSettings` every other verb takes; a `null` is a declared value, refused where the key has no empty state |
| `ValidateOptions` | type | `source`, `sections`, `io`, `undeclared` (the action's input of that name: the fallback policy below a list's wrapper and the file's top-level `_undeclared`), `secretSource` (who authored the document: `operator`, the default, honors `$NAME` secret references; `target` refuses them) |
| `ValidateReport` | type | `settings` and `log` |
| `ValidatedSettings` | type | The document as zod parsed it, branded by validation, every knobbed list in `{_undeclared, entries}` form with its policy resolved; `validateSettings`, `mergeSettings`, and a snapshot that did not fail hand one out |
| `mergeSettings` | function | Fold an ordered list of `Layer`s into one validated document, as `mode: render` does: each layer validated alone, folded, validated again; its `yaml` is byte for byte the file `mode: render` writes, the fold in the canonical order every rendered document shares (sections in execution order, keys as the schema declares them, the entries of every list section by identity; `branches`, `bypass_actors`, `reviewers`, and scalar lists as written), so no layer's key order reaches the file |
| `MergeOptions` | type | `source`, `layering` (`"deep"` unless set), `undeclared` (unset unless given), `io` |
| `MergeReport` | type | `settings`, `notices` (one per `_remove: true` entry that dropped a lower entry), `yaml` (the file text `mode: render` writes, byte for byte), and `log` (the lines the fold printed) |
| `Layer` | type | One layer: its `name` (a path, usually) and its parsed `doc` |
| `Layering` | type | `"replace"`, `"shallow"`, or `"deep"`: how every list section's entries fold across layers, by the section's key |
| `RemovalNotice` | type | A `_remove: true` entry that dropped what a lower layer declared: the layer and the entry's path |
| `describeRemoval` | function | One notice as the line the action prints |
| `readLayerFiles` | function | Read paths into `Layer`s in order; the first unreadable file is the problem |
| `readSettingsFile` | function | Read and parse one YAML file, given its role (`settings-file`, `defaults-file`, `layer`, `central-file`), so the problem's advice fits |
| `SettingsFileRole` | type | The four roles |
| `parseSettingsDoc` | function | Parse YAML text into an unknown document |
| `Problem` | type | Every typed failure a call can return, keyed by `code` |
| `describeProblem` | function | A `Problem` as the message the action prints |

```ts
import { describeProblem, readSettingsFile, validateSettings } from "@vivswan/github-settings-as-code";

const validated = readSettingsFile(".github/settings.yml", "settings-file").andThen((doc) =>
  validateSettings(doc, { source: ".github/settings.yml" }),
);
if (validated.isErr()) throw new Error(describeProblem(validated.error));
const { settings, log } = validated.value;
console.log(log.map((entry) => `${entry.level ?? "log"}: ${entry.line}`));
```

```ts
import { mergeSettings, readLayerFiles } from "@vivswan/github-settings-as-code";

const merged = readLayerFiles(["fleet.yml", "team.yml"]).andThen((layers) => mergeSettings(layers));
if (merged.isErr()) throw new Error(describeProblem(merged.error));
console.log(merged.value.yaml, merged.value.notices.length);
```

### Schema

| Name | Kind | Says |
|---|---|---|
| `SettingsFile` | const | The zod schema of the whole document, and its inferred type |
| `SECTION_KEYS` | const | Every section key in execution order |
| `SectionKey` | type | One of them |
| `UNDECLARED_POLICY_SECTIONS` | const | The list sections whose wrapper takes `_undeclared` beside `_layering`; `environments`, `branches`, and `workflows` layer by key too, through a `{_layering, entries}` wrapper of their own (`LIST_SECTIONS` in the schema module) |
| `UndeclaredPolicySection` | type | One of them |

The schema subpath serves the committed JSON Schema.

```ts
import { SECTION_KEYS, SettingsFile } from "@vivswan/github-settings-as-code";
import schema from "@vivswan/github-settings-as-code/settings.schema.json" with { type: "json" };

const parsed = SettingsFile.safeParse({ labels: [] });
console.log(parsed.success, SECTION_KEYS.length, schema.$schema);
```

### Client

| Name | Kind | Says |
|---|---|---|
| `GitHubApi` | class | The REST and GraphQL client the action uses: retries, throttling, the pinned API version, trace redaction |
| `GitHubApiOptions` | type | Its constructor's options: `token` required; `io` (the trace sink), `baseUrl`, `apiVersion`, `retryBaseMs` (real milliseconds per plugin second), `scheduler` (the throttling limiter), `userAgent` optional |
| `GitHubClient` | type | The port every verb reads and writes through, and the interface a test double implements; it answers, never rejects |
| `ClientAnswer` | type | What one request ends in: `data`, an `error` (GitHub's answer, an `ApiError`), or `failed` (the whole line for a request with no HTTP answer: not sent, the transport failed, a GraphQL body off the wire contract) |
| `DEFAULT_API_VERSION` | const | The `X-GitHub-Api-Version` the action pins |
| `ApiError` | type | A failed request as the port returns it: `status`, `message`, `body` |
| `GraphqlOp` | type | A GraphQL operation as the port takes it |
| `RequestMark` | type | The per-request options; `carriesSecret` marks a payload holding a resolved secret |
| `isPermissionError` | function | Whether an `ApiError` is a denial |
| `isRateLimitError` | function | Whether an `ApiError` is the rate limit |

A request whose payload holds a resolved secret reaches the client marked `carriesSecret`, and whatever error that client returns or throws for it is withheld on the engine's side of the port, so an echoed value never reaches an outcome, the log, or a report, whichever client is in use.

```ts
import { GitHubApi } from "@vivswan/github-settings-as-code";

const client = new GitHubApi({ token: process.env.GITHUB_TOKEN ?? "" });
```

### Check and apply

| Name | Kind | Says |
|---|---|---|
| `checkRepository` | function | Plan and diff every active section without writing |
| `CheckOptions` | type | `sections`, `onMissingPermission`, `io`, and `secretEnv`, the environment `applyRepository` resolves the secret references from; check mode reads none |
| `CheckReport` | type | `repo`, `result`, `outcomes` (one `SectionOutcome` per section), `preflightDenied`, `log` |
| `applyRepository` | function | Execute the plan: the repository converges on the document |
| `ApplyOptions` | type | The same knobs as `CheckOptions` |
| `ApplyReport` | type | The same shape as `CheckReport` |
| `parseRepoSlug` | function | `owner/name` into a `RepoRef`, or the problem naming what is wrong with it |
| `RepoRef` | type | A parsed slug: `owner`, `name`, `slug` |
| `SectionSelection` | class | Which sections run (`only`) and which must fully apply (`required`); `SectionSelection.of(...)` is the one constructor, `SectionSelection.ALL` the default |
| `OnMissingPermission` | type | `"fail"` or `"warn"`: how a read the token is denied classifies |
| `SectionOutcome` | type | One section's end state: `key`, `status`, `detail`, and the denial's `httpStatus` when there was one |

```ts
import { checkRepository, parseRepoSlug, SectionSelection } from "@vivswan/github-settings-as-code";

const repo = parseRepoSlug("octo-org/api");
if (repo.isErr()) throw new Error(describeProblem(repo.error));
const report = await checkRepository(client, repo.value, settings, {
  onMissingPermission: "warn",
  sections: SectionSelection.ALL,
});
console.log(report.result, report.outcomes.map((o) => `${o.key}: ${o.status}`), report.log);
```

### Snapshot

| Name | Kind | Says |
|---|---|---|
| `snapshotRepository` | function | Read one repository's supported sections back as a settings document |
| `snapshotRepositories` | function | The same over several repositories in order; a failed target never stops the rest |
| `SnapshotOptions` | type | `sections`, `onMissingPermission`, `io` |
| `SnapshotReport` | type | `repo`, `result`, `outcomes`, `takenAt` (the moment the reads began; the report states it, since the file carries no date), `log`, and on any result but `failed` the `settings` and the `yaml` `mode: snapshot` writes: the schema pin, one comment per note, then the document in the canonical order, with no timestamp, so two snapshots of an unchanged repository are the same bytes |
| `SectionSnapshotOutcome` | type | One section's end state: `snapshot`, `skipped`, `unsupported`, or `failed`, with its `detail` |

```ts
import { snapshotRepository } from "@vivswan/github-settings-as-code";

const snapshot = await snapshotRepository(client, repo.value);
console.log(snapshot.result, snapshot.yaml ?? "(failed: no document)");
```

### Flows

| Name | Kind | Says |
|---|---|---|
| `executeRun` | function | The executor the action and the CLI share: a `RunConfig` plus a face's `RunDeps` runs to its `RunEnd` |
| `RunDeps` | type | What a face hands in: the `io`, the client factory, and the artifact `uploader` only the Actions runner has |
| `RunEnd` | type | How the run ended: its `exitCode`, and the fatal `Problem` when it never reached a target |
| `RunConfig` | type | The action's parsed inputs: a `SingleConfig`, `MultiConfig`, `RenderConfig`, or `SnapshotConfig`, discriminated by `kind` |
| `parseConfig` | function | Build a `RunConfig` from an input reader, the environment, and the face's `RunCapabilities`, the way the action does; a face without an artifact upload is refused `private-report: artifact` here |
| `RunCapabilities` | type | What the face can do: `artifactUpload`, whether it hands the run a workflow-artifact uploader |
| `InputReader` | type | `(name) => string`: how `parseConfig` reads an input |
| `ConfigEnv` | type | The environment `parseConfig` reads |
| `runSingle` | function | One repository from a local settings file, in check or apply |
| `SingleConfig` | type | Its config |
| `SingleOutcome` | type | Its result: the target's `result`, `outcomes`, and detail |
| `runMulti` | function | The fleet: repos-dir files, the `repos` list, discovery, the defaults fallback |
| `MultiConfig` | type | Its config |
| `TargetOutcome` | type | One fleet target's result, with its `source` |
| `runRender` | function | Fold settings files into `rendered-file`; no token, no API call |
| `RenderConfig` | type | Its config: `settingsFiles`, `renderedFile`, `layering`, `undeclared` |
| `FinishedRender` | type | Its result: the layers and the written file |
| `runSnapshot` | function | The live settings of one repository to a file, or of every fleet target to a directory |
| `SnapshotConfig` | type | Its config, in the `file` or the `dir` form |
| `FinishedSnapshot` | type | Its result: every target's public view |
| `concludeRun` | function | A finished single or multi run into the outputs, the summary, and the exit code |
| `concludeRender` | function | The same for a finished render |
| `concludeSnapshot` | function | The same for a finished snapshot |
| `failRun` | function | A fatal `Problem` into the failed outputs and exit 1 |
| `RunOutcome` | type | Every result word of every mode |
| `RUN_RESULTS` | const | Those words ranked worst first |
| `worstOf` | function | The worst result across a run's targets |

All four flows conclude alike: the three outputs (`result`, `skipped-sections`, `repos-result`) are always set, the result is `worstOf` the targets, and the exit code is 1 exactly when it is `failed`, or `drift` in check mode.

```ts
import { concludeRender, failRun, runRender, silentIo } from "@vivswan/github-settings-as-code";

const io = silentIo();
const renderExitCode = runRender(
  { settingsFiles: ["base.yml", "team.yml"], renderedFile: "rendered.yml", layering: "deep" },
  io,
).match(
  (finished) => concludeRender(io, finished),
  (problem) => failRun(io, problem),
);
```

### Discovery

| Name | Kind | Says |
|---|---|---|
| `discoverRepos` | function | The repositories a token can see, filtered |
| `DiscoveryFilters` | type | The filters: `visibility`, `archived`, `forks`, `affiliation`, `topics`, `exclude` |
| `DEFAULT_DISCOVERY_FILTERS` | const | The action's defaults |
| `parseReposInput` | function | The `repos` input form: slugs, or `"*"` for discovery |
| `resolveCentralTargets` | function | The `<owner>/<name>.yml` files of a repos-dir as targets, with warnings for the files it skipped |
| `dedupeTargets` | function | Merge the central and the remote targets, central first; a remote target whose slug a central one already names is dropped with a notice |
| `Target` | type | A `CentralTarget` or a `RemoteTarget` |
| `CentralTarget` | type | A target with a settings file in the repos-dir |
| `RemoteTarget` | type | A target whose settings file is fetched from the repository itself |

```ts
import { DEFAULT_DISCOVERY_FILTERS, discoverRepos } from "@vivswan/github-settings-as-code";

const found = await discoverRepos(client, { ...DEFAULT_DISCOVERY_FILTERS, topics: ["managed"] });
if (found.isErr()) throw new Error(describeProblem(found.error));
console.log(found.value.repos.map((r) => r.slug));
```

### Report

| Name | Kind | Says |
|---|---|---|
| `composeReport` | function | The private, unredacted markdown report for one target |
| `ReportInput` | type | What it renders: the target, the admin repository, the run URL, the mode and result, the outcomes, the transcript |
| `encryptReport` | function | Seal a report to an age recipient |
| `parseRecipient` | function | Validate an age recipient before sealing to it |
| `openReportChannel` | function | The issue or artifact channel the action delivers through |
| `PrivateReportChannel` | type | `none`, `issue`, `issue-on-failure`, or `artifact` |
| `deliverArtifactReport` | function | The artifact half, behind an uploader you supply; never throws |
| `ArtifactUploader` | type | `upload(name, file)`: the port the Actions runner implements; it resolves to `{ uploaded: true }` or `{ failed }` with the reason |

```ts
import { encryptReport, parseRecipient } from "@vivswan/github-settings-as-code";

const recipient = process.env.REPORT_PUBLIC_KEY ?? "";
const checked = parseRecipient(recipient);
if (checked.isErr()) throw new Error(describeProblem(checked.error));
const sealed = await encryptReport(recipient, "# report");
```

### Sections

| Name | Kind | Says |
|---|---|---|
| `SECTIONS` | const | Every section module in execution order |
| `sectionModule` | function | One module by key |
| `SectionModule` | type | A module: its `key`, `endpoints`, `permission`, `plan()`, `snapshot()` when it has one, and `validate()` on a list section (its file-only checks, run by document validation) |
| `ValidatedInput` | type | What `plan()` takes: one section's value read off a `ValidatedSettings` document (`settings.labels`); only validation mints it, so a hand-built entry list does not compile |
| `ValidatedBrand` | type | The mark a `ValidatedInput` carries: a type-level property holding the section key the value was validated as, with no runtime field; a declaration spells a planner's input as the section's value `& ValidatedBrand<"labels">` |
| `SectionInput` | type | The section's value without the brand, as the schema types it; what a list module's `validate()` hook takes, since it runs inside validation |
| `sectionGrant` | function | The PAT grant a section needs, as prose |
| `allEndpoints` | function | Every declared REST route, tagged with its owner |
| `allGraphqlOps` | function | Every declared GraphQL operation, tagged with its owner |
| `TaggedEndpoint` | type | A route beside the section that declares it |
| `endpointMethod` | function | The method half of a `Route` |
| `endpointPath` | function | The path half of a `Route` |
| `Route` | type | `"GET /repos/{owner}/{repo}/labels"` and its kin |
| `EndpointDecl` | type | A REST endpoint as a section declares it: the route, the statuses it tolerates, the permission |
| `GraphqlOpDecl` | type | A GraphQL operation as a section declares it |
| `planContext` | function | The context `plan()` reads through, from your client and a `RepoRef` |
| `PlanContext` | type | That context |
| `snapshotContext` | function | The context `snapshot()` reads through: the plan context plus the denial policy |
| `SnapshotContext` | type | That context |
| `DenialPolicy` | type | The policy as `snapshot()` sees it; only `snapshotContext` mints one |
| `SectionPlan` | type | What `plan()` resolves to on `Ok`: the operations, notes, and drift |
| `SectionSnapshot` | type | What `snapshot()` resolves to on `Ok`: the section's value and notes |
| `SectionFailure` | type | What `plan()` or `snapshot()` resolves to on `Err`: the whole line as `message`, and a `kind` for policy (`"permission-denied"` also carries the section, the detail, and the HTTP status) |

```ts
import { planContext, sectionGrant, sectionModule, snapshotContext } from "@vivswan/github-settings-as-code";

const labels = sectionModule("labels");
console.log(labels.key, Object.keys(labels.endpoints), sectionGrant(labels));
```

A module's `plan()` and `snapshot()` are callable directly, each over a context built from your `GitHubClient` and a `RepoRef`:

- `planContext(module, client, repo)` for `plan()`.
- `snapshotContext(module, client, repo, onMissingPermission)` for `snapshot()`; the fourth argument is the `OnMissingPermission`, `"fail"` or `"warn"`. The context carries it as a `DenialPolicy` only this factory mints, so a literal object cannot stand in for one.
- A context belongs to the module it was built from: `labels.plan(planContext(branches, ...))` does not compile, and a module handed another section's context at runtime rejects with an error naming both sections before it reads anything.
- `plan()` takes the section's value off a validated document (`settings.labels`, a `ValidatedInput<"labels">`), never a list you built by hand. Only `validateSettings()`, `mergeSettings()`, and a `snapshotRepository()` that did not fail mint that type.
- `plan()` and `snapshot()` resolve to a neverthrow `Result`: the plan or snapshot on `Ok`, a `SectionFailure` on `Err` (a denied read, a live state the section cannot reconcile, a duplicated live pair). Neither rejects for anything a settings file or the network can cause; a rejection is the wrong-context refusal above, a `GitHubClient` that throws instead of answering (breaking its contract), or a `BUG:` invariant.
- A module's own `snapshot()` value is unbranded and goes through `validateSettings()` first. So the file-only checks (two entries naming one label) have run before any planner reads.
- The brand names the section: on a module named by its key, a validated `branches` list is not a `labels` input. The erased `SectionModule` view is one key on both sides, as it is for contexts, so only the key-named module carries that check.
- A `null` section value (`pages`, `interaction_limits`) carries no brand, since it holds nothing to check.

Prefer `checkRepository()` and `snapshotRepository()` for the whole document: one run over every selected section, permission failures classified per section, and one report or rendered file at the end.

```ts
import type { SectionFailure, SectionPlan, SectionSnapshot, ValidatedInput } from "@vivswan/github-settings-as-code";

const declaredLabels: ValidatedInput<"labels"> | undefined = settings.labels;
if (declaredLabels === undefined) throw new Error("the document declares no labels");
const planned = await labels.plan(planContext(labels, client, repo.value), declaredLabels);
if (planned.isErr()) {
  const failure: SectionFailure = planned.error;
  throw new Error(`${failure.kind}: ${failure.message}`);
}
const labelsPlan: SectionPlan = planned.value;
const read = await labels.snapshot?.(snapshotContext(labels, client, repo.value, "warn"));
let labelsSnapshot: SectionSnapshot<"labels"> | undefined;
if (read !== undefined) {
  if (read.isErr()) throw new Error(read.error.message);
  labelsSnapshot = read.value;
}
console.log(labelsPlan.ops.length, labelsSnapshot?.value, labelsSnapshot?.notes);
```

### Io

| Name | Kind | Says |
|---|---|---|
| `Io` | type | The output port every flow writes to: `log`, `debug`, `annotate`, `summary`, `output`, and the mask pair |
| `collectingIo` | function | An `Io` that records lines, outputs, and summary blocks, masked as the action's log is |
| `CollectedLine` | type | One recorded line and, for an annotation, its `level` |
| `silentIo` | function | An `Io` that drops everything |
| `prefixedIo` | function | An `Io` that attributes every line to a target |
| `maskRegistry` | function | The mask pair an `Io` implementation needs, over a sink such as `core.setSecret` |
| `MaskPair` | type | `mask(value)` and the `masked` set |
| `redactRanges` | function | The one redactor: every registered value in a text becomes `***`, overlapping occurrences as one |
| `AnnotationLevel` | type | `notice`, `warning`, or `error` |
| `OutputName` | type | `result`, `skipped-sections`, or `repos-result` |

```ts
import { collectingIo, concludeRun, runSingle, type SingleConfig } from "@vivswan/github-settings-as-code";

declare const config: SingleConfig;
const collected = collectingIo();
const exitCode = await runSingle(client, config, collected.io).match(
  (target) => concludeRun(collected.io, { kind: "single", mode: config.mode, target }),
  (problem) => failRun(collected.io, problem),
);
console.log(exitCode, collected.outputs.result, collected.lines.map((entry) => entry.line));
```

## CLI

The package's `bin` entries, `github-settings-as-code` and `gsac`, run the same flows from a terminal: `check`, `apply`, and `render` take the action's inputs as `--flags`,
and `validate` and `permissions` read a settings file alone. The [command line guide](../start/cli.md) has every command, the flag rule, and the exit codes.

## Versioning

The package and the action share one version, the one in `.release-please-manifest.json` (release-please rewrites `package.json` from it), so a settings file that validates on the library validates on the action of the same version.

| npm dist-tag | Publishes on | Version | Install |
|---|---|---|---|
| `next` | Every refresh of the release PR: release-please creates or refreshes it when a releasable commit (feat, fix, perf, revert, or a breaking marker) lands on `main` | The manifest's next patch, then `-main.<count>.<date>.g<sha7>`: `2.0.1-main.446.20260913.g95d081d` | `npm install @vivswan/github-settings-as-code@next` |
| `latest` | Every release cut | The released version: `2.1.0`. Until the first stable release it names the `0.0.0` placeholder that reserved the package name: a packument always carries `latest` (npm/registry REGISTRY-API.md, "dist-tags: an object with at least one key, latest"), so the first publish took it, and the first stable release moves it; ask for `@next` until then | `npm install @vivswan/github-settings-as-code` |
| none | Every green push to `main` (`build/<position>.<sha7>`, the ten newest kept) and every release tag | The commit itself | `npm install github:Vivswan/github-settings-as-code#<packaged sha>` |

The npm dist-tag `latest` is not the git tag `latest`: the git tag names the packaged commit of the newest `main` commit (every green push moves it forward, never back), the dist-tag names the newest release on the registry.

- A pre-release version is a pure function of its main commit. `2.0.1-main.446.20260913.g95d081d` reads:
  - `446`: the commits reachable from it along first parents (`git rev-list --count --first-parent <sha>`), one more per merge to main.
  - `20260913`: its committer date in UTC.
  - `g95d081d`: its short sha; the `g` marks a git object id, as `git describe` writes it (a bare all-digit sha such as `0123456` would be read by npm as the number 123456).
  - Two runs for one commit mint the same string, whenever they run.
- A pre-release sorts above the last release and below the next one whatever its bump, and later commits on main sort later: npm compares the count first, and it grows by one with each merge (the date is for the reader; two merges on one day share it).
  - A release merge refreshes no release PR, so it publishes no pre-release: after `2.1.0` publishes, `next` names the last pre-release below it (`2.0.1-main...`) until the first releasable commit of the next cycle opens the next release PR, whose refresh publishes `2.1.1-main.<count>.<date>.g<sha7>`. `npm install ...@next` resolves the dist-tag whatever the ordering.
- `next` moves only to a descendant. The pre-publish guard resolves the sha in every published `-main.` version in its full checkout and places it against this run's commit:
  - a pre-release whose source is a strict descendant: this run is stale and publishes nothing, whatever order the two runs finished in;
  - a sha the checkout cannot resolve, or one that is neither ancestor nor descendant (off main): ignored, with a notice in the log;
  - the run's own version already on the registry (a rerun of that commit): publishes nothing.
- A `next` build appears when release-please creates or refreshes the release PR, and nowhere else: the release hook `update-release-pr.yml` publishes in the run that refreshed it, from the commit the refresh was built on.
  - release-please refreshes the PR only when the release notes change (`always-update` is off in `release-please-config.json`), which a releasable commit does: feat, fix, perf, revert, or a breaking marker. A merge of hidden types alone (chore, build, ci, test, docs, refactor) refreshes nothing and publishes nothing, a dependency bump under `build(deps)` included.
  - No check of the repository's own decides a publish. The guard above is a safety on registry state: a rerun of the run, or a stale retry after a newer commit published, publishes nothing, so `next` never moves backward; a published source the checkout cannot place is ignored with a notice.
- `latest` publishes nothing when the version is already there or when the dist-tag `latest` names a newer release (a rerun of an older release's job); it does not look at `next`.
- Every registry read misses the CDN cache (a cached packument lags a publish by up to 300 s), and a `next` publish job holds the npm-publish lane until the registry's record shows its version (up to 15 reads, 20 s apart: three of the first five publishes were still unreadable after 80 s, so the hold covers that lag with margin).
  - So the run after it judges against a record that carries it. Neither dist-tag moves backward on what its run could see.
- The residual window: a publish the registry has not made readable within that bound is invisible to the run after it, which then moves `next` back to its older version.
  - That run fails with an error naming the drift once the record shows both versions; it warns if its own never shows within the bound.
  - It passes without naming the drift if its own shows while the overtaken one still does not.
  - A rerun of it publishes nothing and passes, and the next release-PR refresh moves `next` forward again (its commit descends from every published one).
  - No run moves a dist-tag by hand: trusted publishing authenticates `npm publish` alone, not `npm dist-tag add`.
- Both channels publish through npm trusted publishing (OIDC) from this repository's CI workflow: no registry token exists anywhere.
  - npm attaches a provenance attestation to every version CI publishes, which `npm audit signatures` checks in a project that installs it.
- The `github:` form installs a packaged commit's `lib/pkg/`, built from its source commit by the same workflow run that built its `lib/index.js`, with no registry and no build step on your side.

## Publishing setup

The package exists on the registry and every version on it is CI-published through the trusted publisher: GitHub Actions, owner `Vivswan`, repository `github-settings-as-code`, workflow `ci.yml` (the caller of both hooks), no environment. Publishing access is "Require two-factor authentication and disallow tokens", so the workflow's OIDC identity is the only thing that can publish; nothing is published by hand.
