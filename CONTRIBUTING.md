# Contributing to GitHub Settings as Code

The fleet-wide conventions - Conventional Commit titles, squash merges, the `all-green` gate, and the code of conduct - are in [Vivswan/.github's CONTRIBUTING.md](https://github.com/Vivswan/.github/blob/main/CONTRIBUTING.md). This page holds what is specific to this repository.

## Toolchain

- `src/` is TypeScript built with [bun](https://bun.com). The scripts in `package.json` are the commands; `bun run check` is the whole local gate.
- `lib/settings.schema.json` is the one committed generated artifact; `bun run build:check` fails when it or the generated docs drift.
- `lib/index.js` (the action bundle) and `lib/pkg/` (the npm library) are built where they are needed and never committed on `main`. Every runtime dependency is compiled into them.
- [COVERAGE.md](COVERAGE.md) is the inventory of the supported API surface. A change that adds or extends a section keeps it in step.

## End-to-end tests

The end-to-end tests build the bundle to a temp path and run it as a subprocess against a mock GitHub API, so they exercise the same single-file bundle a release ships.

- `bun run test:e2e` runs the curated scenario corpus.
- `bun run fuzz` runs seeded property fuzzing: random scenarios, each checked against an oracle that predicts the outcome class from the token mask, policy, and mode.
- The mock serves the section endpoints plus the core routes the action calls outside the sections. A request that matches no registered route fails loudly; the mock never invents a response.
- PR CI runs the sections a pull request changed. Two nightly workflows run the full corpus and the full fuzz, filing issues labeled `e2e-fuzz` and `fuzz-nightly` that carry a replay command.

The fuzzer is deterministic. It prints a master seed and a per-iteration seed:

```sh
FUZZ_SEED=<masterSeed> bun run fuzz                          # replay a whole run
bun test/e2e/fuzz.ts --seed <iterationSeed> --iterations 1  # replay one failing iteration
```

## Releases

- Releases run downstream of the `all-green` gate: ci.yml calls the fleet's release workflow, so a release or a release-PR refresh only happens from a green `main`.
- release-please does the version math, the changelog, the version pins, and the release PR; merging that PR cuts the release.
- Every ref a `uses:` pin can name (`vX.Y.Z`, the moving major, `latest`) points at a packaged commit on the `build` branch: the source tree without its workflows, plus the built bundle, its source named in a Source trailer. The tags up to v2.0.0 point at `main` commits from when `main` committed the bundle.
- The repo-owned hooks `update-release.yml` and `update-release-pr.yml` mint the tags and keep release-please's boundary (`last-release-sha`) fresh. The git topology lives in `.github/scripts/release-pipeline.ts` and its test.
