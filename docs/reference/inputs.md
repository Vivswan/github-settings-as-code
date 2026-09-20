---
order: 120
---

# Inputs and outputs

Every `with:` input the action accepts, and the outputs it sets for the steps after it. Every input is optional; the Default column is what an omitted input means.

## Inputs

<!-- BEGIN GENERATED: inputs-table (bun run build:action-docs; edit src/flows/inputs.ts) -->
| Input | Default | Meaning |
|---|---|---|
| `token` | `github.token` | Token for the API calls (see [Token permissions](permissions.md)) |
| `repository` | current repo | Target `owner/name` (single-repo mode only) |
| `settings-file` | `.github/settings.yml` | Settings file path (single-repo mode); in `mode: render`, the ordered list of layers to fold, low to high |
| `mode` | `apply` | `apply` mutates; `check` reports drift and exits 1 on any, making no settings changes (a private report may still be delivered); `render` folds the settings-file layers into rendered-file without touching GitHub; `snapshot` writes the live settings to snapshot-file or snapshot-dir |
| `rendered-file` | (empty) | `mode: render` only (required there): where the rendered document is written, exactly what `apply` would run |
| `snapshot-file` | (empty) | `mode: snapshot` only (one of the two required there): where one repository's live settings are written as a settings document |
| `snapshot-dir` | (empty) | `mode: snapshot` only (one of the two required there): directory receiving one `<owner>/<name>.yml` per multi-repo target |
| `on-missing-permission` | `fail` | `warn` skips sections the token cannot access (partial success) |
| `required-sections` | (empty) | Sections that must fully apply even under `warn` |
| `sections` | (all declared) | Comma-separated allowlist of sections to process (apply, check, and snapshot; rejected in `mode: render`) |
| `api-version` | `2022-11-28` | `X-GitHub-Api-Version` header; override to opt into a newer REST API version |
| `repos` | (empty) | Multi-repo remote mode: `owner/name` list (comma/newline), or `*` to discover owned repos |
| `repos-dir` | (empty) | Multi-repo central mode: directory of per-repo settings files in this repo |
| `defaults-file` | (empty) | YAML applied to every multi-repo target without a settings file (multi-repo mode only) |
| `layering` | `deep` | `mode: render` only: how every list section's entries combine across layers, by the section's key; `replace` lets the higher list win, `shallow` unions and swaps a same-key entry, `deep` unions and merges a same-key pair field by field; a layer's `_layering` overrides it |
| `undeclared` | (each list's default) | `keep` or `delete`: the fallback policy for every list that takes `_undeclared`, below a wrapper's and the file's own; unset, each list's default applies ([the undeclared policy](undeclared-policy.md)) |
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

- `result`: <!-- BEGIN GENERATED: outputs-list (bun run build:docs; derived from RUN_RESULTS in src/engine/outcome.ts) -->`failed` / `drift` / `partial` / `skipped` / `applied` / `clean` / `snapshot` / `rendered`, worst first across the run's targets; the exit code is 1 exactly when it is `failed`, or `drift` in mode: check<!-- END GENERATED: outputs-list -->. The [snapshot guide](../operate/snapshot.md) says what each snapshot word means.
- `skipped-sections`: the sections skipped for missing permissions under `on-missing-permission: warn`, comma-separated (a deduped union across targets in multi-repo mode); empty when none.
- `repos-result`: a JSON map of `owner/name` to `{result, source, skipped-sections}`, one entry per target of a multi-repo run (`repos`, `repos-dir`, or the `snapshot-dir` form of `mode: snapshot`); the empty map `{}` for a run over one repository or a render. A redacted private target is keyed by its `private repository #N` placeholder instead of its slug; see [Private repositories](../operate/private-repositories.md).

All three outputs are set on every run, whatever the mode and however it ended.

A `check` run exits 1 on any drift, so a downstream step usually reads `result` only when the step runs with `continue-on-error: true` or through `if: always()`. [Check mode](../operate/check-mode.md) has the exit-code table.

## Environment variables

Beside the inputs, a run reads these from its environment. The Actions runner sets every `GITHUB_*` and `ACTIONS_*` name below except `GITHUB_TOKEN`, which a workflow exports itself; the [command line](../start/cli.md) reads `GITHUB_TOKEN`, `GITHUB_REPOSITORY`, `GITHUB_API_URL`, and `GSAC_RETRY_BASE_MS` under the same names.

| Variable | Read for |
|---|---|
| `GITHUB_TOKEN` | The token when the `token` input (or `--token`) is empty |
| `GITHUB_REPOSITORY` | The default `repository`, the owner of a bare `<name>.yml` under `repos-dir`, and the one target never redacted |
| `GITHUB_SERVER_URL`, `GITHUB_RUN_ID` | The run link a private report carries |
| `GITHUB_API_URL` | The REST base URL (GitHub Enterprise Server) |
| `GITHUB_OUTPUT`, `GITHUB_STEP_SUMMARY` | Where the action writes its outputs and the step summary (the command line prints them instead) |
| `ACTIONS_RUNTIME_TOKEN` | The artifact service's credential; `private-report: artifact` warns and uploads nothing without it (GitHub Enterprise Server) |
| `GSAC_RETRY_BASE_MS` | A test knob: the real milliseconds in one retry-backoff second. Set, it also selects the immediate scheduler, so the rate-limit `Retry-After` waits and the write limiter's spacing are skipped rather than scaled. Unset, a second is a second and the waits are real. Set it only to make a retry scenario finish in milliseconds against a mock; against GitHub the skipped waits earn the next secondary rate limit |
