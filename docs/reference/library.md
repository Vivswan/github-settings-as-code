---
order: 190
---

# Library

The engine behind the action is also an npm package, `@vivswan/github-settings-as-code`: ESM only, Node 22.14 or newer, one bundled `index.js` with one bundled `index.d.ts`. Everything the action can do, a program can do through it: validate a settings document, fold layers, check or apply one repository, run the single- and multi-repo flows, discover targets, and compose the private report.

## Install

The package is built from this repository:

```bash
bun install
bun run build:lib
```

That writes `lib/pkg/index.js` and `lib/pkg/index.d.ts`, the files the manifest's `exports` point at. Installing from npm or from a packaged commit of the `build` branch arrives with the publishing change.

The package exports three paths: the entry (`.`), the committed settings.yml JSON Schema (`./settings.schema.json`), and its own manifest (`./package.json`).

## The API by group

Every name below is exported from the entry, [src/index.ts](https://github.com/Vivswan/github-settings-as-code/blob/main/src/index.ts). Each group has one short example; the types beside each name are in the bundled declarations.

How a call reports failure depends on its group:

- A call that reads or parses input, or runs a whole flow (`validateSettings`, `readSettingsFile`, `parseRepoSlug`, `mergeLayers`, `discoverRepos`, `parseRecipient`, `runSingle`, `runMulti`, `runMerge`, ...), returns a [neverthrow](https://github.com/supermacro/neverthrow) `Result` (or `ResultAsync`) whose error is a typed `Problem`; `describeProblem` renders one as the message the action would print.
- The engine calls, `checkRepository` and `applyRepository`, always resolve to a report: its `result` field carries the outcome (`clean`, `drift`, `applied`, `partial`, `skipped`, `failed`) and its `outcomes` say what each section did.
- Report delivery: `deliverArtifactReport` never throws and returns `{ uploaded: true }` or `{ warning }`. Two calls throw instead: `encryptReport` on a recipient `parseRecipient` would have rejected (validate it first), and `openReportChannel` when asked for the `artifact` channel without an `ArtifactUploader`.

The examples continue from one another and form one program (the docs tests compile them in page order): each name is imported once, in the first example that uses it, and later examples reuse it, as they do `settings` (the Validate group's validated document), `client` (the Client group's `GithubApi`), and `config` in the Io example (a `SingleConfig`, the action's parsed inputs, declared there).

### Validate and merge

`validateSettings` validates a parsed document; `mergeLayers`, `foldLayers`, and `readLayerFiles` fold layers as `mode: merge` does; `renderMergedYaml` prints the result the way the merged-file output is written; `readSettingsFile` (given the file's role) and `parseSettingsDoc` read YAML.

```ts
import { describeProblem, readSettingsFile, validateSettings } from "@vivswan/github-settings-as-code";

const validated = readSettingsFile(".github/settings.yml", "settings-file").andThen((doc) =>
  validateSettings(doc, { source: ".github/settings.yml" }),
);
if (validated.isErr()) throw new Error(describeProblem(validated.error));
const { settings, warnings } = validated.value;
console.log(warnings);
```

### Schema

`SettingsFile` is the zod schema of the whole document and its inferred type; `SECTION_KEYS` lists every section in execution order; the schema subpath serves the committed JSON Schema.

```ts
import { SECTION_KEYS, SettingsFile } from "@vivswan/github-settings-as-code";
import schema from "@vivswan/github-settings-as-code/settings.schema.json" with { type: "json" };

const parsed = SettingsFile.safeParse({ labels: [] });
console.log(parsed.success, SECTION_KEYS.length, schema.$schema);
```

### Client

`GithubApi` is the REST and GraphQL client the action uses (retries, throttling, the pinned `DEFAULT_API_VERSION`, trace redaction); it takes an options object whose only required field is `token` (`io`, `baseUrl`, and `apiVersion` are optional). `GithubClient` is the interface a test double implements. `isPermissionError` and `isRateLimitError` classify an `ApiError`.

```ts
import { GithubApi } from "@vivswan/github-settings-as-code";

const client = new GithubApi({ token: process.env.GITHUB_TOKEN ?? "" });
```

### Check and apply

`checkRepository` plans and diffs every active section without writing; `applyRepository` executes the plan. Both take the validated settings, the parsed `RepoRef` from `parseRepoSlug`, the permission policy, and a `SectionSelection` (which sections run and which must fully apply; `SectionSelection.ALL` runs every declared section), and return the result plus the lines the run printed.

```ts
import { checkRepository, parseRepoSlug, SectionSelection } from "@vivswan/github-settings-as-code";

const repo = parseRepoSlug("octo-org/api");
if (repo.isErr()) throw new Error(describeProblem(repo.error));
const report = await checkRepository(client, {
  repo: repo.value,
  settings,
  onMissingPermission: "warn",
  sections: SectionSelection.ALL,
});
console.log(report.result, report.outcomes.map((o) => `${o.key}: ${o.status}`), report.log);
```

### Flows

The run flows the action wraps: `runSingle` (one repository from a local file), `runMulti` (repos-dir, discovery, defaults file), `runMerge` (fold files into one), with `concludeRun`, `concludeMerge`, and `failRun` turning a finished run or its problem into outputs and an exit code. `SingleConfig`, `MultiConfig`, and `MergeConfig` are the inputs the action parses into; `parseConfig` builds one from an input reader and the environment the way the action does.

```ts
import { concludeMerge, failRun, runMerge, silentIo } from "@vivswan/github-settings-as-code";

const io = silentIo();
const mergeExitCode = runMerge(
  { settingsFiles: ["base.yml", "team.yml"], mergedFile: "merged.yml", layering: "merge" },
  io,
).match(
  (merged) => concludeMerge(io, merged),
  (problem) => failRun(io, problem),
);
```

### Discovery

`discoverRepos` lists the repositories a token can see, filtered by `DiscoveryFilters` (`DEFAULT_DISCOVERY_FILTERS` is the action's default); `parseReposInput` reads the `repos` input form; `resolveCentralTargets` reads a repos-dir; `dedupeTargets` merges the two sources.

```ts
import { DEFAULT_DISCOVERY_FILTERS, discoverRepos } from "@vivswan/github-settings-as-code";

const found = await discoverRepos(client, { ...DEFAULT_DISCOVERY_FILTERS, topics: ["managed"] });
if (found.isErr()) throw new Error(describeProblem(found.error));
console.log(found.value.repos.map((r) => r.slug));
```

### Report

`composeReport` renders the private, unredacted markdown report for one target; `encryptReport` seals it to an age recipient (`parseRecipient` validates one); `openReportChannel` opens the issue or artifact channel the action delivers through; `deliverArtifactReport` is the artifact half behind an `ArtifactUploader` you supply.

```ts
import { encryptReport, parseRecipient } from "@vivswan/github-settings-as-code";

const recipient = process.env.REPORT_PUBLIC_KEY ?? "";
const checked = parseRecipient(recipient);
if (checked.isErr()) throw new Error(describeProblem(checked.error));
const sealed = await encryptReport(recipient, "# report");
```

### Sections metadata

`SECTIONS` is every section module in execution order; `sectionModule(key)` returns one; `sectionGrant` renders the PAT grant a section needs; `allEndpoints` and `allGraphqlOps` flatten every declared route, tagged with its owner; `endpointMethod` and `endpointPath` split a route.

```ts
import { sectionGrant, sectionModule } from "@vivswan/github-settings-as-code";

const labels = sectionModule("labels");
console.log(labels.key, Object.keys(labels.endpoints), sectionGrant(labels));
```

### Io

`Io` is the output port every flow writes to. `collectingIo()` captures lines, outputs, and summary blocks; `silentIo()` drops them; `prefixedIo(io, prefix)` attributes lines to a target; `maskRegistry` builds the mask pair an `Io` implementation needs. What `collectingIo()` captures is masked the way the action's log is: `redactRanges(text, masked)`, the one redactor, replaces every registered value with `***`, overlapping occurrences as one.

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

The package's `bin` entries, `github-settings-as-code` and `gsac`, run the same flows from a terminal: `check`, `apply`, and `merge` take the action's inputs as `--flags`,
and `validate` and `permissions` read a settings file alone. The [command line guide](../start/cli.md) has every command, the flag rule, and the exit codes.

## Versioning

The package and the action share one version, the one in `.release-please-manifest.json` (release-please rewrites `package.json` from it), so a settings file that validates on the library validates on the action of the same version.

## One-time publishing setup

For the owner, once. npm adds a trusted publisher only to a package that already exists, so the first version is published by hand from a maintainer machine with two-factor authentication. The bootstrap version is a pre-release published under the `next` dist-tag, so no `latest` exists before the first stable release; the exact version command lands with the publishing workflow.

1. Build the library: `bun run build:lib` (the tarball ships `lib/pkg/`, which is built, not committed).
2. Publish the pre-release under `next`, never `latest`: `npm publish --access public --tag next`.
3. On npmjs.com, on the package's settings page, add a trusted publisher: type GitHub Actions, owner `Vivswan`, repository `github-settings-as-code`, workflow filename `ci.yml`, no environment.
4. Under publishing access, choose "Require two-factor authentication and disallow tokens", so the workflow's OIDC identity is the only thing that can publish.
