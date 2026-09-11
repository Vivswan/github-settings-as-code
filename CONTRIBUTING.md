# Contributing to GitHub Settings as Code

The fleet-wide conventions - Conventional Commit titles, squash merges, the `all-green` gate, and the code of conduct - are in [Vivswan/.github's CONTRIBUTING.md](https://github.com/Vivswan/.github/blob/main/CONTRIBUTING.md). This page holds what is specific to this repository.

## Toolchain

`src/` is TypeScript built with [bun](https://bun.com); `lib/` holds one committed generated artifact, `settings.schema.json`, the published settings.yml schema. `bun run build:schema` regenerates it; CI's schema-check job fails on drift. The bundle the action executes, `lib/index.js`, is not committed: `bun run build:bundle` builds it where it is needed (the CI workflows that run the action build it first, and a release ships it on a packaged commit on the `build` branch, which is what every `vX.Y.Z` tag cut since that branch exists, the moving major, and the `latest` tag point at).

Runtime dependencies (such as @octokit/rest with the retry and throttling plugins, @actions/core, zod, and yaml) are compiled into that single bundle.

Run `bun run check` for lint + YAML lint + import-layering lint + typecheck + dead-code check (knip) + tests + freshness of the generated artifacts (the schema and the generated docs). The pre-commit hook runs staged lint and typecheck only.

[COVERAGE.md](COVERAGE.md) is the honest inventory of the supported API surface: what works today, the repo-scoped gaps, and what is out of scope by design. A change that adds or extends a section should keep it in step.

## End-to-end tests

The end-to-end tests build the bundle to a temp path and run it as a real subprocess against a mock GitHub API, so they exercise the same single-file bundle a release ships, not the TypeScript source directly. `bun run test:e2e` runs the curated scenario corpus, and `bun run fuzz` runs seeded property fuzzing: it generates random scenarios and checks each run's outcome against an oracle that predicts the outcome class from the token mask, policy, and mode.

The fuzzer is deterministic. It prints a master seed and a per-iteration seed for each run; a whole run reproduces with `FUZZ_SEED=<masterSeed> bun run fuzz`, and a single failing iteration replays with `bun test/e2e/fuzz.ts --seed
<iterationSeed> --iterations 1`.

The mock serves the section endpoints plus the core routes the action calls outside the sections (the repo fetch, the settings-file contents read, `repos: "*"` discovery, and the private-report issue channel), so a request that matches no registered section or core route fails loudly rather than returning a made-up response.

PR CI runs a diff-aware subset, scoped to the sections a pull request changed. Two nightly workflows cover the rest: one runs the curated scenario corpus and files an issue labeled `e2e-fuzz` on failure, the other runs the full fuzz and files under `fuzz-nightly`; both issues carry a replay command.

## Releases

The release leg is ci.yml calling Vivswan/repo-platform's fleet-release.yml via workflow_call, downstream of the `all-green` gate and of post-green.yml, so releases and release-PR refreshes only happen from a green main. release-please does version math, the changelog, the manifest and version pins, and the release PR; merging that PR has it cut the release as a draft with no tag.

Every release ref a `uses:` pin can name from now on - the `vX.Y.Z` tags, the moving major, and the `latest` tag - points at a packaged commit on the `build` branch: the source tree without its workflows, plus the built bundle, its source named in a Source trailer (the tags cut before that branch existed, v2.0.0 and earlier, stay on main commits from when main committed the bundle). post-green.yml appends one for each green main commit when its token can push, and the repo-owned update-release.yml hook appends the release's when post-green could not.

That hook rebuilds the bundle from the merge commit, verifies the committed schema byte-for-byte, creates the `vX.Y.Z` tag once on the release's packaged commit, moves the moving major tag to it, points the `latest` tag at the packaged commit of the newest main source, and uploads the assets. The fleet's publish stage (fleet-release-publish.yml) then attests every asset (on a public repository) and flips the draft live, binding the release to the packaged tag.

The other repo-owned hook, update-release-pr.yml, runs on every release-PR refresh and records the main head the refresh was built on as `last-release-sha`: version tags live off main, so release-please's boundary is recorded config rather than a tag lookup. The tag topology is unit-tested in test/scripts/release-pipeline.test.ts.
