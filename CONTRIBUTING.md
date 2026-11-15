# Contributing to GitHub Settings as Code

The fleet-wide conventions - Conventional Commit titles, squash merges, the `all-green` gate, and the code of conduct - are in [Vivswan/.github's CONTRIBUTING.md](https://github.com/Vivswan/.github/blob/main/CONTRIBUTING.md). This page holds what is specific to this repository.

## Toolchain

- `src/` is TypeScript built with [bun](https://bun.com). The scripts in `package.json` are the commands; `bun run check` is the whole local gate.
- Run `bun install` once after cloning, and again after `lefthook.yml` changes: it installs the dependencies and the git hooks. The hooks themselves never install or fetch anything, and a missing tool fails the commit naming that command.
- GitHub's OpenAPI descriptor, webhooks description, and GraphQL schema come from the `@octokit/openapi`, `@octokit/openapi-webhooks`, and `@octokit/graphql-schema` devDependencies, so no test or generator touches the network. Dependabot moves the pins; a bump that stops documenting a path the action calls, starts documenting an upstream gap, or retires a field a query selects fails the schema tests on that PR by name.
- `bun run build:openapi` (`.github/scripts/gen-openapi.ts`) renders the files the descriptor dictates, the invitation role enums in `src/generated/spec-roles.ts`, the ruleset rule rows in `src/generated/spec-rules.ts`, the passthrough vocabularies and bodies in `src/generated/spec-enums.ts`, and the repository webhook events in `src/generated/spec-webhooks.ts` (from `@octokit/openapi-webhooks`); a descriptor bump regenerates them and `test/scripts/gen-openapi.test.ts` fails on a committed copy that drifted.
- `bun run test` and `bun run fuzz` run `bun run build:schema` first: the tests and the fuzzer load the built, gitignored `lib/settings.schema.json`.
- Committed generated output is the table in `.github/scripts/generated.ts`: the whole files under `src/generated/` and the generated regions of `action.yml` and the docs pages.
- `bun run build:check` regenerates every table entry and fails on drift. Before that, it fails on a GENERATED marker, in a file the table lists, that names a region no generator registers.
- A generated region is everything between its `BEGIN GENERATED: <name>` and `END GENERATED: <name>` markers, and it belongs to its generator: the next regeneration overwrites it without reading it. Hand-written text belongs outside the markers.
- Text typed inside a region, or enclosed by a marker moved over it, is replaced. Committed text shows in the diff of the regenerated file and stays in git; uncommitted text is gone.
- The generator refuses, naming the file and the region, when a marker is missing, repeated, out of order, inside another region, or away from the heading or YAML key its declaration names.
- `lib/index.js` (the action bundle), `lib/settings.schema.json` (the published schema), and `lib/pkg/` (the npm library) are built where they are needed and never committed on `main`.
- The action bundle compiles every runtime dependency in. The library keeps them external: they are the `dependencies` of `package.json`, installed by the consumer's package manager.
- [docs/reference/coverage.md](docs/reference/coverage.md) is the inventory of the supported API surface, one link per call. A change that adds or extends a section keeps its `<key>.docs.yml` rows and `.github/scripts/endpoint-docs.yml` in step.

## Fixes committed to a pull request

The platform's `autofix` module commits two kinds of fix to a same-repository pull request's branch. This repository's part is the hook, `.github/actions/autofix/action.yml`, and the `autofix` lists in `.repo-platform.yml`; the workflow and the push are the platform's ([its guide](https://github.com/Vivswan/repo-platform/blob/stable/docs/modules/autofix.md)).

| Trigger                                                                     | The hook runs                                                    | The commit may carry                                                                  |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| a push to a pull request that changes a generator input (`autofix.push.on`) | `graduate-upstream-gaps.ts`, then every generator in table order | the generated outputs by name, and `src/upstream-gaps/` (the one place a fix deletes) |
| the `fix-lint` label                                                        | `bun run lint:fix`                                               | what biome changed in a file outside `.github/`; never a deletion                     |

- **Each trigger keeps one comment on the pull request,** its notice: what was pushed, dropped, or refused.
- **A red push run** means the hook failed or the fix was refused, and usually that nothing was committed; check the branch, since a run can fail after its push landed. A pull request with a type error stops in the graduation, by design. A generator that wrote a file outside `autofix.push.paths` is refused, and the notice names the path.
- **The label never fixes a file under `.github/`:** the notice names it, and `bun run lint:fix` on your machine is the fix.
- **The fix commit's checks wait for approval.** GitHub holds the run a workflow token's push starts; approve it from the merge box, or push a commit.
- **A Dependabot pull request** is regenerated by the push run, since `package.json` and `bun.lock` are generator inputs; that run's token may be read-only there, and then nothing is pushed. The `fix-lint` label, added by a person, formats and nothing more. Commit-back never refreshes a stale `bun.lock`: the frozen install fails and the run is red.
- **A fork's pull request is not fixed:** run `bun run build` and `bun run lint:fix` and commit the result.
- **The lists are read from `main`,** so a pull request that adds a generated file gets no fix for it until it merges: commit that file's first copy by hand. `test/scripts/autofix-registration.test.ts` fails when a generator, a module it imports, a docs file the registry loads, or one of its outputs is missing from the lists or the hook. A file a generator reads at run time without importing it is not seen, and is listed by hand.

## Backward compatibility

- A compat path that stays (an alias, a retired input still accepted, an arm for an older artifact) carries a comment `COMPAT(vN): <what stays working and what to delete>`, N the major that deletes it.
- N is above the current major: compat kept for a shape of the current major is marked with the next one.
- JSON takes no comments, so compat in a JSON file is marked in the code that reads it.
- A path that must work forever is not compat and gets no marker.
- `bun run check:compat` (in `bun run check` and in CI) rejects a malformed marker and any marker whose major is at or below `package.json`'s, and prints the remaining markers grouped by major.
- A release PR's tree already carries the version it cuts, so the same check makes a major release PR unmergeable until every marker for that major is deleted on `main` first.

## Code conventions

- Line caps: code wraps at biome's `lineWidth` of 100. The fleet's check-file-size caps source, test, workflow, and shell lines at 256 characters; markdown prose has no width cap. A comment block is at most 10 lines.
- Markdown keeps one source line per paragraph or list item, so a long item is split into items, never wrapped.
- A source file under `src/` or `.github/scripts/` opens with a one-paragraph header comment saying what the file owns; test files need none.
- Tests live under `test/`, mirroring `src/`: a section's unit tests, `mock.ts`, `generators.ts`, and `scenarios/` sit in `test/sections/<key>/`, except that a mock fragment or snapshot row that is one family-factory call lives in the family table instead; `src/` holds code only.

## Tests

- Every temp directory a test creates is removed on every exit path, failure included: `withTempDir()` from `test/temp-dir.ts`, or a try/finally of its own. A fixture that outlives one test removes its dir when it ends (the release-pipeline fixture in afterAll, the e2e bundle on process exit).
- An Io a test records through is `captureIo()` from `test/io/capture.ts`: every channel in its own list and in one ordered event log.
- A repository-relative path in a test resolves from `ROOT` in `test/root.ts`; a file beside the test resolves from `import.meta.dir`.
- A test in `test/docs`, `test/workflows`, or `test/config` guards an invariant between artifacts (a doc's claim against the code, a workflow against the constant a script prints); a pin of one file's own text is not kept.

## End-to-end tests

The end-to-end tests build the bundle to a temp path and run it as a subprocess against a mock GitHub API, so they exercise the same single-file bundle a release ships.

- `bun run test:e2e` runs the curated scenario corpus.
- Every section ships the standard scenario set under `test/sections/<key>/scenarios/`, named after the section's dashed key: `<slug>-apply-converges`, `<slug>-check-drift` (a section with a planning read), `<slug>-snapshot-roundtrip` (a section with snapshot()), and for a section under the undeclared policy `<slug>-undeclared-delete` and `<slug>-undeclared-keep-note`; `test/sections/scenario-set.test.ts` derives the set from the registry.
- `bun run fuzz` runs seeded property fuzzing: random scenarios, each checked against an oracle that predicts the outcome class from the token mask, policy, and mode.
- The mock serves the section endpoints plus the core routes the action calls outside the sections. A request that matches no registered route fails loudly; the mock never invents a response.
- PR CI runs the full scenario corpus, the endpoint-coverage tripwire, and 25 fuzz iterations on every pull request, and uploads the e2e failure artifacts.
- The release gate (`.github/workflows/release-gate.yml`) runs the deep fuzz and the OpenAPI drift probe on the release PR, on a manual dispatch, and every night. It is required under `all-green` on the release PR and on a manual dispatch.
- The nightly workflow covers the Octokit freshness probes (the packages that describe GitHub's API, at their latest releases) and runs the full gate against them, covers the float canary, and opens the `@octokit/openapi` bump PR once the committed bump passes the full gate. A red night, the release gate included, files under the `nightly-failure` issue.
- The fuzz workflow runs by dispatch alone, for a seeded replay or an ad-hoc soak, and files under `fuzz-nightly` with a replay command.

The fuzzer is deterministic. It prints a master seed and a per-iteration seed:

```sh
FUZZ_SEED=<masterSeed> bun run fuzz                    # replay a whole run
bun run fuzz --seed <iterationSeed> --iterations 1    # replay one failing iteration
PROPERTY_SEED=<seed> bun test <file>                  # replay one seed alone through a file's in-process properties
```

The in-process property tests run their fixed seeds plus fresh ones on every run. A failing seed is printed with that replay line. A count across seeds is taken over the fixed seeds alone, so it is the same on every run.

## Releases

- Releases run downstream of the `all-green` gate: ci.yml calls the fleet's release workflow, so a release or a release-PR refresh only happens from a green `main`.
- release-please does the version math, the changelog, the version pins, and the release PR; merging that PR cuts the release.
- Merge the release PR only after release-please has rebuilt it for the newest `fix` or `feat` on `main`: a commit that lands after the PR's notes were built ships in that release and appears in no changelog.
- release-please tags each release merge on `main` as `source-vX.Y.Z` and finds its previous release by that tag. It is a marker, not a pin: `main` carries no built action. The `source-tags` ruleset freezes it.
- Every ref a `uses:` pin can name (`vX.Y.Z`, the moving major, `latest`) points at a packaged commit: the child of one `main` commit, carrying its tree plus the built bundle, schema, and library; every green push mints one under a `build/<position>.<sha7>` tag, the ten newest kept. The tags up to v2.0.0 point at `main` commits from when `main` committed the bundle.

Two repo-owned hooks share the ref work; the git topology lives in `.github/scripts/release-pipeline/tags.ts` and its test.

- `post-green.yml` packages every green push under its `build/` tag, prunes the window, and moves `latest`.
- `update-release.yml` checks the release's `source-vX.Y.Z` marker, mints `vX.Y.Z`, and moves the major. It packages the merge commit when no build tag does, and reconciles `latest` and the build-tag window as post-green does. It then renames the draft release to `vX.Y.Z`.

The npm package publishes through the platform's npm module, not from a hook: ci.yml's `npm-next` leg on a release-PR refresh, its `npm-latest` leg after `update-release.yml` and before the release goes live.

- `.github/actions/npm-build/action.yml` is this repository's part: it builds the schema and the library and drops `scripts.prepare` from the published manifest.
- The version, the verdicts, the publish, and the dist-tags are the module's ([Versioning](docs/reference/library.md#versioning)).
- `update-release-pr.yml` is the platform's no-op starter.
