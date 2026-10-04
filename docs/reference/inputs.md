---
order: 120
---

# Inputs and outputs

Every `with:` input the action accepts, and the outputs it sets for the steps after it. Every input is optional (the required column is always `false`); a default of `""` is an unset input, and the description says what an omitted input means. The `token` grant is on the [permissions](permissions.md) page, the `undeclared` policies on the [undeclared policy](undeclared-policy.md) page.

A list input (`sections`, `required-sections`, `repos`, `exclude`, `topics`, `affiliation`, and `settings-file` in `mode: render`) takes newline- or comma-separated values. `settings-file` is split the same way in every mode, so no settings file path can contain a comma.

<!-- The table between the action-docs markers is action-docs's rendering of action.yml (bun run build:inputs-table); the descriptions live in src/flows/inputs.ts, and the markers stay around the table: the script refuses to regenerate over anything else. The v-pre div keeps the site's Vue renderer from evaluating the token default's expression. -->
<div v-pre>

<!-- action-docs-inputs source="action.yml" -->
## Inputs

| name | description | required | default |
| --- | --- | --- | --- |
| `token` | <p>The token for the API calls: a fine-grained PAT, since the default GITHUB_TOKEN can never hold the Administration grant most sections need.</p> | `false` | `${{ github.token }}` |
| `repository` | <p>The owner/name repository to run against, the current repository by default.</p> | `false` | `""` |
| `settings-file` | <p>The settings document to run, or in mode: render the ordered list of layers to fold, lowest first.</p> | `false` | `.github/settings.yml` |
| `mode` | <p>apply (write the file's settings), check (report drift, exit 1 on any), render (fold settings-file layers into rendered-file), or snapshot (write the live settings back as a settings file).</p> | `false` | `apply` |
| `rendered-file` | <p>mode: render only, and required there: the path the rendered settings document is written to.</p> | `false` | `""` |
| `snapshot-file` | <p>mode: snapshot only, for one repository: the path its live settings are written to as a settings document.</p> | `false` | `""` |
| `snapshot-dir` | <p>mode: snapshot only, for a fleet: the directory receiving one owner/name.yml per repos or repos-dir target.</p> | `false` | `""` |
| `on-missing-permission` | <p>fail (default) or warn: whether a section the token cannot access fails the run or is skipped with a warning.</p> | `false` | `fail` |
| `required-sections` | <p>Comma-separated sections that must fully apply even under on-missing-permission: warn.</p> | `false` | `""` |
| `sections` | <p>Comma-separated allowlist of the sections to process, every declared section when unset.</p> | `false` | `""` |
| `api-version` | <p>The X-GitHub-Api-Version header value, to opt into a newer REST API version before this action defaults to it.</p> | `false` | `2022-11-28` |
| `repos` | <p>Comma- or newline-separated owner/name targets, each applied from its own .github/settings.yml, or "*" alone to discover every repository the token's user owns.</p> | `false` | `""` |
| `repos-dir` | <p>A directory in the checked-out admin repository holding one settings file per target, as name.yml or owner/name.yml.</p> | `false` | `""` |
| `defaults-file` | <p>A settings document applied whole to every multi-repo target that has no settings file of its own.</p> | `false` | `""` |
| `layering` | <p>mode: render only: replace, shallow, or deep (default), how every list section's entries combine with the layers below them.</p> | `false` | `""` |
| `undeclared` | <p>keep or delete: the fallback for what apply does to a live resource a list does not declare, unset by default so each list's own default applies.</p> | `false` | `""` |
| `private-repos` | <p>redact (default) or show: whether private and internal targets are hidden from the run's public logs, summary, and outputs.</p> | `false` | `redact` |
| `private-report` | <p>none (default), issue, issue-on-failure, or artifact: the private channel that delivers the full report of each target the visibility probe proves private or internal.</p> | `false` | `none` |
| `report-public-key` | <p>The age recipient (a public key starting with age1) the artifact channel encrypts every report to, required by private-report: artifact and rejected otherwise.</p> | `false` | `""` |
| `visibility` | <p>Keeps only repositories of this visibility in repos: "*" discovery: all (default), public, private, or internal.</p> | `false` | `""` |
| `archived` | <p>Archived-repository policy for repos: "*" discovery: skip (default), include, or only.</p> | `false` | `""` |
| `forks` | <p>Fork policy for repos: "*" discovery: include (default), exclude, or only.</p> | `false` | `""` |
| `exclude` | <p>Comma- or newline-separated wildcard patterns removing repositories from repos: "*" discovery.</p> | `false` | `""` |
| `topics` | <p>Comma- or newline-separated topics, of which repos: "*" discovery keeps the repositories carrying at least one.</p> | `false` | `""` |
| `affiliation` | <p>Comma-separated affiliations for repos: "*" discovery: owner (default), collaborator, or organization_member.</p> | `false` | `""` |
<!-- action-docs-inputs source="action.yml" -->

</div>

An input set outside its scope fails the run before any API call, naming the input and the fix. Each description above names its scope. What `mode: render` and `mode: snapshot` refuse in turn is in the [render table](../operate/layering.md#inputs-in-mode-render) and the [snapshot table](../operate/snapshot.md#inputs-in-mode-snapshot).

`repository` is refused beside `repos` or `repos-dir`, as is a `settings-file` other than its default, and `defaults-file` is refused without them. The [multi-repo guide](../operate/multi-repo.md) covers the two sourcing modes and the [discovery filters](../operate/multi-repo.md#discovery-filters) that belong to `repos: "*"` alone.

## Outputs

- `result`: <!-- BEGIN GENERATED: outputs-list (bun run build:docs; derived from RUN_RESULTS in src/engine/outcome.ts) -->`failed` / `drift` / `partial` / `skipped` / `applied` / `clean` / `snapshot` / `rendered`, worst first across the run's targets; the exit code is 1 exactly when it is `failed`, or `drift` in mode: check<!-- END GENERATED: outputs-list -->. The [snapshot guide](../operate/snapshot.md) says what each snapshot word means, and `skipped` is a fleet target with no settings file and no `defaults-file` ([the fallback](../operate/multi-repo.md#fallback-for-repositories-without-a-settings-file)).
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
