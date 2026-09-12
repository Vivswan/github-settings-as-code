---
order: 190
---

# Library

The engine behind the action is also an npm package, `@vivswan/github-settings-as-code`: ESM only, Node 22.14 or newer, one bundled `index.js` with one bundled `index.d.ts`. Everything the action can do, a program can do through it: validate a settings document, fold layers, check or apply one repository, run the single- and multi-repo flows, discover targets, and compose the private report.

## Install

Three ways in, one package:

```bash
npm install @vivswan/github-settings-as-code          # the released version (npm dist-tag latest)
npm install @vivswan/github-settings-as-code@next     # the newest green main commit, a pre-release
npm install github:Vivswan/github-settings-as-code#<packaged sha>   # one packaged commit of the build branch
```

`bun add` takes the same three forms. A pre-release version looks like `2.0.1-main.412.gb8df084`; the [Versioning](#versioning) section says how the three relate. The `github:` form works for every commit packaged since the library joined the packaged branch: such a commit carries `lib/pkg/` (the library build) beside `lib/index.js` (the action bundle), both built from its source commit by the workflow run named in its message, so nothing is built on your side. Older packaged commits, and the tags cut from them (v2.0.0 and earlier), carry the action bundle alone. To build the package from a checkout instead, `bun install && bun run build:lib` writes `lib/pkg/index.js` and `lib/pkg/index.d.ts`, the files the manifest's `exports` point at.

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

`Io` is the output port every flow writes to. `collectingIo()` captures lines, outputs, and summary blocks; `silentIo()` drops them; `prefixedIo(io, prefix)` attributes lines to a target; `maskRegistry` builds the mask pair an `Io` implementation needs.

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

| npm dist-tag | Publishes on | Version | Install |
|---|---|---|---|
| `next` | Every green push to `main` | The manifest's next patch, then `-main.<run number>.g<sha7>`: `2.0.1-main.412.gb8df084` | `npm install @vivswan/github-settings-as-code@next` |
| `latest` | Every release cut | The released version: `2.1.0`. Until the first release it names the bootstrap pre-release, which npm tags `latest` as a package's first publish | `npm install @vivswan/github-settings-as-code` |
| none | Every packaged commit on the `build` branch since the library joined it | The commit itself | `npm install github:Vivswan/github-settings-as-code#<packaged sha>` |

The npm dist-tag `latest` is not the git tag `latest`: the git tag names the newest packaged commit on the `build` branch (every green push moves it), the dist-tag names the newest release on the registry.

- A pre-release sorts above the last release and below the next one whatever its bump, and later runs sort later: run numbers only grow, and the sha makes each run's version its own. The one pre-release that sorts above a release is the release merge commit's own: its manifest already carries the new version, so `next` moves to `2.1.1-main.<run>.g<sha7>` in the same run that publishes `2.1.0`, which is the order the two channels are meant to keep (next above latest).
- The `g` before the short sha marks a git object id, as `git describe` writes it; a bare all-digit sha such as `0123456` would be read by npm as the number 123456.
- `next` publishes nothing when its version is already on the registry (a rerun of that run) or when the dist-tag `next` or `latest` already names a version that is not older (a retry of an old run after newer ones published, or after a release). `latest` publishes nothing when the version is already there or when the dist-tag `latest` names a newer release (a rerun of an older release's job); it does not look at `next`. Neither dist-tag ever moves backward.
- Both channels publish through npm trusted publishing (OIDC) from this repository's CI workflow: no registry token exists anywhere, and npm attaches a provenance attestation to every version CI publishes, which `npm audit signatures` checks in a project that installs it. The one hand-published version is the bootstrap pre-release below, recognizable by its run number 0.
- The `github:` form installs a packaged commit's `lib/pkg/`, built from its source commit by the same workflow run that built its `lib/index.js`, with no registry and no build step on your side.

## One-time publishing setup

For the owner, once. npm adds a trusted publisher only to a package that already exists, so the first version is published by hand from a maintainer machine with two-factor authentication; it is the only publish a person ever makes.

1. From a clean checkout of `main`, build the library (the tarball ships `lib/pkg/`, which is built, not committed), stamp the bootstrap pre-release version, and publish it under `next`, never `latest` by request:

```bash
bun install --frozen-lockfile && bun run build:lib
version="$(GITHUB_SHA="$(git rev-parse HEAD)" GITHUB_RUN_NUMBER=0 bun .github/scripts/release-pipeline.ts prerelease-version)"
npm version "$version" --no-git-tag-version && npm publish --access public --tag next
git checkout package.json
```

2. On npmjs.com, on the package's settings page, add a trusted publisher: GitHub Actions, owner `Vivswan`, repository `github-settings-as-code`, workflow filename `ci.yml` (the caller of both hooks), no environment.
3. Under publishing access, choose "Require two-factor authentication and disallow tokens", so the workflow's OIDC identity is the only thing that can publish.

Until step 2 is done, the release hook's `publish-npm` job fails and the GitHub release stays a draft, and `publish-next` fails the same way on the next green push; re-run the failed jobs once the publisher exists.
