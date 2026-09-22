# Contributing to GitHub Settings as Code

The fleet-wide conventions - Conventional Commit titles, squash merges, the `all-green` gate, and the code of conduct - are in [Vivswan/.github's CONTRIBUTING.md](https://github.com/Vivswan/.github/blob/main/CONTRIBUTING.md). This page holds what is specific to this repository.

## Toolchain

- `src/` is TypeScript built with [bun](https://bun.com). The scripts in `package.json` are the commands; `bun run check` is the whole local gate.
- GitHub's OpenAPI descriptor and GraphQL schema come from the `@octokit/openapi` and `@octokit/graphql-schema` devDependencies, so no test or generator touches the network. Dependabot moves the pins; a bump that stops documenting a path the action calls, starts documenting an upstream gap, or retires a field a query selects fails the schema tests on that PR by name.
- `bun run test` and `bun run fuzz` run `bun run build:schema` first: the tests and the fuzzer load the built, gitignored `lib/settings.schema.json`.
- Committed generated output is the table in `.github/scripts/generated.ts`: `src/upstream-gaps/index.ts` and the generated regions of `action.yml` and the docs pages.
- `bun run build:check` regenerates every table entry and fails on drift.
- `lib/index.js` (the action bundle), `lib/settings.schema.json` (the published schema), and `lib/pkg/` (the npm library) are built where they are needed and never committed on `main`. Every runtime dependency is compiled into the bundle and the library.
- [docs/reference/coverage.md](docs/reference/coverage.md) is the inventory of the supported API surface, one link per call. A change that adds or extends a section keeps its `<key>.docs.yml` rows and `.github/scripts/endpoint-docs.yml` in step.

## Backward compatibility

- A compat path that stays (an alias, a retired input still accepted, an arm for an older artifact) carries a comment `COMPAT(vN): <what stays working and what to delete>`, N the major that deletes it: compat kept today for a pre-3 shape is marked v3; compat introduced during 3.x for a 3.0 shape is marked v4. JSON takes no comments, so compat in a JSON file is marked in the code that reads it. A path that must work forever is not compat and gets no marker.
- `bun run check:compat` (in `bun run check` and in CI) rejects a malformed marker and any marker whose major is at or below `package.json`'s, and prints the remaining markers grouped by major.
- A release PR's tree already carries the version it cuts, so the same check makes a major release PR unmergeable until every marker for that major is deleted on `main` first: with 3.0.0 in preparation, every v3-marked path goes before v3 cuts.

## Code conventions

- Line caps: code wraps at biome's `lineWidth` of 100. The fleet's check-file-size caps source, test, workflow, and shell lines at 256 characters; markdown prose has no width cap. A comment block is at most 10 lines.
- Markdown keeps one source line per paragraph or list item, so a long item is split into items, never wrapped.
- A source file under `src/` or `.github/scripts/` opens with a one-paragraph header comment saying what the file owns; test files need none.
- Tests live under `test/`, mirroring `src/`: a section's unit tests, `mock.ts`, `generators.ts`, and `scenarios/` sit in `test/sections/<key>/`; `src/` holds code only.

## Tests

- Every temp directory a test creates is removed on every exit path, failure included: `withTempDir()` from `test/temp-dir.ts`, or a try/finally of its own. A fixture that outlives one test removes its dir when it ends (the release-pipeline fixture in afterAll, the e2e bundle on process exit).
- An Io a test records through is `captureIo()` from `test/io/capture.ts`: every channel in its own list and in one ordered event log.
- A repository-relative path in a test resolves from `ROOT` in `test/root.ts`; a file beside the test resolves from `import.meta.dir`.
- A test in `test/docs` guards an invariant between artifacts (a doc's claim against the code, a workflow against the constant a script prints); a pin of one file's own text is not kept.

## End-to-end tests

The end-to-end tests build the bundle to a temp path and run it as a subprocess against a mock GitHub API, so they exercise the same single-file bundle a release ships.

- `bun run test:e2e` runs the curated scenario corpus.
- Every section ships the standard scenario set under `test/sections/<key>/scenarios/`, named after the section's dashed key: `<slug>-apply-converges`, `<slug>-check-drift` (a section with a planning read), `<slug>-snapshot-roundtrip` (a section with snapshot()), and for a section under the undeclared policy `<slug>-undeclared-delete` and `<slug>-undeclared-keep-note`; `test/sections/scenario-set.test.ts` derives the set from the registry.
- `bun run fuzz` runs seeded property fuzzing: random scenarios, each checked against an oracle that predicts the outcome class from the token mask, policy, and mode.
- The mock serves the section endpoints plus the core routes the action calls outside the sections. A request that matches no registered route fails loudly; the mock never invents a response.
- PR CI runs the full scenario corpus, the endpoint-coverage tripwire, and 25 fuzz iterations on every pull request. The nightly workflow's `e2e` job runs the full corpus and files a red night under the `nightly-failure` issue; the fuzz nightly runs the full fuzz and files under `fuzz-nightly` with a replay command.

The fuzzer is deterministic. It prints a master seed and a per-iteration seed:

```sh
FUZZ_SEED=<masterSeed> bun run fuzz                    # replay a whole run
bun run fuzz --seed <iterationSeed> --iterations 1    # replay one failing iteration
```

## Releases

- Releases run downstream of the `all-green` gate: ci.yml calls the fleet's release workflow, so a release or a release-PR refresh only happens from a green `main`.
- release-please does the version math, the changelog, the version pins, and the release PR; merging that PR cuts the release.
- Every ref a `uses:` pin can name (`vX.Y.Z`, the moving major, `latest`) points at a packaged commit: the child of one `main` commit, carrying its tree plus the built bundle, schema, and library; every green push mints one under a `build/<position>.<sha7>` tag, the ten newest kept. The tags up to v2.0.0 point at `main` commits from when `main` committed the bundle.
- The repo-owned hooks `update-release.yml` and `update-release-pr.yml` mint the tags and keep release-please's boundary (`last-release-sha`) fresh. The git topology lives in `.github/scripts/release-pipeline.ts` and its test.
