
## Toolchain

`src/` is TypeScript built with [bun](https://bun.com); `lib/` holds one committed generated artifact, `settings.schema.json`, the published settings.yml schema. `bun run build:schema` regenerates it; CI's schema-check job fails on drift. The bundle the action executes, `lib/index.js`, is not committed: `bun run build:bundle` builds it where it is needed (the CI workflows that run the action build it first, and a release builds and ships it on a packaged commit that every `vX.Y.Z` tag, and the moving major with them, points at).

Runtime dependencies (such as @octokit/rest with the retry and throttling plugins, @actions/core, zod, and yaml) are compiled into that single bundle.

Run `bun run check` for lint + YAML lint + typecheck + dead-code check (knip) + tests + schema freshness. The pre-commit hook runs lint and typecheck only.

[COVERAGE.md](COVERAGE.md) is the honest inventory of the supported API surface: what works today, the repo-scoped gaps, and what is out of scope by design. A change that adds or extends a section should keep it in step.

## End-to-end tests

The end-to-end tests build the bundle to a temp path and run it as a real subprocess against a mock GitHub API, so they exercise the same single-file bundle a release ships, not the TypeScript source directly. `bun run test:e2e` runs the curated scenario corpus, and `bun run fuzz` runs seeded property fuzzing: it generates random scenarios and checks each run's outcome against an oracle that predicts the outcome class from the token mask, policy, and mode.

The fuzzer is deterministic. It prints a master seed and a per-iteration seed for each run; a whole run reproduces with `FUZZ_SEED=<masterSeed> bun run fuzz`, and a single failing iteration replays with `bun test/e2e/fuzz.ts --seed
<iterationSeed> --iterations 1`.

The mock serves the section endpoints plus the core routes the action calls outside the sections (the repo fetch, the settings-file contents read, `repos: "*"` discovery, and the private-report issue channel), so a request that matches no registered section or core route fails loudly rather than returning a made-up response.

PR CI runs a diff-aware subset, scoped to the sections a pull request changed. Two nightly workflows cover the rest: one runs the curated scenario corpus and files an issue labeled `e2e-fuzz` on failure, the other runs the full fuzz and files under `fuzz-nightly`; both issues carry a replay command.

## Releases

The release job runs downstream of the `all-green` gate, so releases and release-PR refreshes only happen from a green main. release-please does version math, the changelog, the manifest and version pins, and the release PR; merging that PR has it cut the release as a draft with no tag. The repo-owned update-release.yml hook then builds the bundle, commits it as a child of the merge commit, creates the `vX.Y.Z` tag once on that packaged commit, moves the moving major tag to it, and uploads the assets; the managed publish stage attests every asset (on a public repository) and flips the draft live, binding the release to the packaged tag. The tag topology is unit-tested in test/scripts/release-pipeline.test.ts.
