---
order: 120
---

# Inputs and outputs

Every `with:` input the action accepts, and the outputs it sets for the steps after it. Every input is optional; the Default column is what an omitted input means.

## Inputs

<!-- BEGIN GENERATED: inputs-table (bun run build:action-docs; edit src/action/inputs.ts) -->
| Input | Default | Meaning |
|---|---|---|
| `token` | `github.token` | Token for the API calls (see [Token permissions](permissions.md)) |
| `repository` | current repo | Target `owner/name` (single-repo mode only) |
| `settings-file` | `.github/settings.yml` | Settings file path (single-repo mode); in `mode: merge`, the ordered list of layers to fold, low to high |
| `mode` | `apply` | `apply` mutates; `check` reports drift and exits 1 on any, making no settings changes (a private report may still be delivered); `merge` folds the settings-file layers into merged-file without touching GitHub |
| `merged-file` | (empty) | `mode: merge` only (required there): where the merged document is written, exactly what `apply` would run |
| `on-missing-permission` | `fail` | `warn` skips sections the token cannot access (partial success) |
| `required-sections` | (empty) | Sections that must fully apply even under `warn` |
| `sections` | (all declared) | Comma-separated allowlist of sections to process (apply and check only; rejected in `mode: merge`) |
| `api-version` | `2022-11-28` | `X-GitHub-Api-Version` header; override to opt into a newer REST API version |
| `repos` | (empty) | Multi-repo remote mode: `owner/name` list (comma/newline), or `*` to discover owned repos |
| `repos-dir` | (empty) | Multi-repo central mode: directory of per-repo settings files in this repo |
| `defaults-file` | (empty) | YAML merged under every multi-repo target's settings (multi-repo mode only) |
| `layering` | `merge` | `mode: merge` only: `merge` unions the keyed list sections (labels, rulesets) by key across layers, `replace` lets the higher layer's list win; a layer's `_layering` overrides it |
| `private-repos` | `redact` | `redact` hides private and internal targets from public logs, summary, and outputs; `show` reveals them |
| `private-report` | `none` | `issue` delivers each redacted target's full report to a reused issue on that target repository; `issue-on-failure` writes that issue only when the target fails or drifts, closing it once healthy; `artifact` uploads all reports as one age-encrypted workflow artifact; rejected with `private-repos: show` |
| `report-public-key` | (empty) | The `age1...` recipient the `artifact` channel encrypts reports to; required with `private-report: artifact`, rejected otherwise |
| `visibility` | `all` | Discovery-only: keep `public`, `private`, or `internal` repositories |
| `archived` | `skip` | Discovery-only: `skip`, `include`, or `only` archived repositories |
| `forks` | `include` | Discovery-only: `include`, `exclude`, or `only` forks |
| `exclude` | (empty) | Discovery-only: `*` wildcard patterns (name, or `owner/name` if the pattern has a `/`) to drop |
| `topics` | (empty) | Discovery-only: keep repositories carrying at least one listed topic |
| `affiliation` | `owner` | Discovery-only: `owner`, `collaborator`, `organization_member` (comma list) |
<!-- END GENERATED: inputs-table -->

The discovery-only inputs apply to `repos: "*"`; the [multi-repo guide](../operate/multi-repo.md) covers the filters and the two sourcing modes.

## Outputs

- `result`: <!-- BEGIN GENERATED: outputs-list (bun run build:docs; derived from REPO_RESULTS in src/engine/orchestrate.ts) -->`applied` / `partial` / `clean` / `drift` / `failed`; worst-of across targets in multi-repo mode, where `skipped` can also appear; `merged` in mode: merge<!-- END GENERATED: outputs-list -->.
- `skipped-sections`: the sections skipped for missing permissions under `on-missing-permission: warn`, comma-separated (a deduped union across targets in multi-repo mode).
- `repos-result`: multi-repo mode only, a JSON map of `owner/name` to `{result, source, skippedSections}`. A redacted private target is keyed by its `private repository #N` placeholder instead of its slug; see [Private repositories](../operate/private-repositories.md).

A `check` run exits 1 on any drift, so a downstream step usually reads `result` only when the step runs with `continue-on-error: true` or through `if: always()`. [Check mode](../operate/check-mode.md) has the exit-code table.
