<!-- BEGIN REPO-PLATFORM MANAGED -->
# AGENTS.md

Guidance for AI coding agents working in this repository. `CLAUDE.md`, `.github/copilot-instructions.md`, and `.github/agents.md` are symlinks to this file, so edit only here.

Everything between the BEGIN and END markers is managed by Vivswan/repo-platform and replaced on every sync. This repository's own guidance goes below the END marker.

## Project

GitHub Settings as Code: GitHub Action applying declarative repository settings: rulesets, labels, branch protection, and more. A loud, stateless Probot Settings replacement.

## Conventions

- PR titles and commit subjects are Conventional Commits; with the release-please module they drive its versioning. PRs are squash-merged, so the PR title becomes the commit subject; with the pr-title module, its check validates the title.
- CI gates on the `all-green` check, required by the managed ruleset. Under `.github/workflows/`, this repository's test and lint jobs go in `checks.yml`, its green-gated work on main in `post-green.yml` (both repo-owned); `ci.yml` is managed.
- With the release-please module, a green push to main releases through the fleet's release pipeline; this repository's release steps go in the repo-owned `update-release.yml` and `update-release-pr.yml` hooks.
- Plain ASCII punctuation only: no curly quotes, em-dashes, or invisible unicode. The check-typography gate enforces it.

## Managed by repo-platform

- Files whose header says "managed by Vivswan/repo-platform" arrive via sync PRs from that repository. Do not edit them here; change them there.
- Repository settings are rendered into `.github/settings.yml` by Vivswan/repo-platform's sync from its fleet layers plus this repository's own `.github/settings.local.yml`. Edit that file, never the rendered one or the GitHub UI; the merge rules are in repo-platform's docs/settings.md.
- Repo-owned, never overwritten by sync: `checks.yml`, `post-green.yml`, `.gitleaks.toml`, `.gitignore` outside its managed region, `.typography-allow.local`, the release hooks, and the module starters (the release-please JSON files, the `.claude-plugin/` manifests, the nightly workflows).
- Module selection is the `modules` list in `.repo-platform.yml`; the next sync PR applies a change. The per-module contracts are in repo-platform's docs/new-repo.md.
- Fleet-wide conventions: repo-platform's docs/fleet-guidelines.md.

## Toolchain

- bun: `bun install`, `bun test`, `bun run <script>` (scripts in `package.json`)
- `.bun-version` is managed by sync; pin another version in a repo-owned workflow's version input, not in the dotfile.

## Repository-specific guidance

<!-- Add project-specific instructions below the END marker; they are this repository's own and survive every sync. -->
<!-- END REPO-PLATFORM MANAGED -->

Code is the source of truth: this section holds only the rules and the decisions a reader could not recover from the code.

### Hard rules

- Generated artifacts (`lib/settings.schema.json`, the generated docs, the generated `action.yml` regions) are regenerated, never hand-edited; `bun run build:check` fails on drift.
- `lib/index.js` (the action bundle) and `lib/pkg/` (the npm library) are built, never committed on main; the packaged `build` branch carries them.
- Every GitHub list call goes through `listAll()` or `listAllEnveloped()`, and every API error through `call()`/`throwFor()`, so the permission policy holds (`src/sections/contract/requests.ts`).
- The import layering of `src/` is declared in `architecture.yml`; a new cross-layer import is a deliberate edit to that file.
- A type a section module exposes is exported from its home module, or the bundled declarations cannot reach it and the package-smoke job fails.
- New sections and endpoints ship with e2e scenarios, and `bun run test:e2e` runs green before they land.

### Decisions a reader would otherwise reverse

- A flat `src/sections/<key>/` directory means repository scope, permanently; org/user scopes arrive as sibling scope directories with their own document, keys, and registry (the ":" reservation in `src/sections/registry.ts`).
- The section directory is the unit of work: its `<key>.docs.yml` feeds the generated docs, and the compiler flags every forgotten registration step.
- `src/upstream-gaps/` holds one file per GitHub feature an upstream artifact lags; `gap.ts` states how each kind graduates.

### Releases

- The `release` job in ci.yml stays out of all-green's `needs`: it runs downstream of the gate so releases only happen on a green main.
- Version tags live off main on the packaged `build` chain; main stays source-only and no tag ever lands on it. Topology: `.github/scripts/release-pipeline.ts`.
- The npm package publishes from the release hooks through trusted publishing; docs/reference/library.md states the versioning rules.
