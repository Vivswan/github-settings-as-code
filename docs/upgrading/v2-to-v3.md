---
order: 20
---

# Upgrading from v2 to v3

Twenty-six breaks (the ninth, the twenty-third, and the twenty-fourth are for library consumers, the twenty-first for anyone pinning a sha). The silent ones include the fallback, the renamed `GSAC_RETRY_BASE_MS`, the merged file (it reorders once, and a top-level `null` over nothing drops), and the snapshot file (it reorders once and no longer dates itself), so run `mode: check` before the first v3 apply and diff the first v3 merged file. The changelog entry for 3.0.0 will carry the release-please footers in the [CHANGELOG](https://github.com/Vivswan/github-settings-as-code/blob/main/CHANGELOG.md).

| Break | v2 | v3 | What the old form does now |
|---|---|---|---|
| `defaults-file` is a fallback | Merged under every multi-repo target; a target without a settings file was skipped | Applied whole to a target that has no settings file; a target with its own file is applied as written, never merged | No error. A target file written as a partial overlay now runs alone, and `pages: null` in it disables Pages instead of opting out of the defaults; the check-first steps are under [section 1](#1-the-defaults-file-fallback) |
| The wrapper key is `_undeclared` | `labels: {undeclared: keep, entries: [...]}` | `labels: {_undeclared: keep, entries: [...]}` | Validation fails before any section runs, naming the rename; the full error is under [section 2](#2-undeclared-becomes-_undeclared) |
| Layering happens in `mode: merge` | The only merge was the defaults-file one | An ordered list of files folds in a merge step; apply and check take one final document | No error. Reach for the [two-step workflow](../operate/layering.md#the-two-step-workflow) to get merging back |
| A `settings-file` path cannot contain a comma or newline | `settings-file: settings,prod.yml` named one file | A comma or newline is a list separator in every mode | Apply and check refuse the run before reading anything (the error is under [section 4](#4-commas-and-newlines-in-a-settings-file-path)); `mode: merge` reads two layer paths |
| `repos-result` rows spell `skipped-sections` | `{"o/r": {"result": "applied", "source": "central", "skippedSections": []}}` | `{"o/r": {"result": "applied", "source": "central", "skipped-sections": []}}` | No error. A step reading `.skippedSections` gets `null`; [section 5](#5-repos-result-rows-spell-skipped-sections) |
| The three outputs are always set | `repos-result` existed only in multi-repo runs and the `snapshot-dir` form; unset elsewhere | `result`, `skipped-sections`, and `repos-result` are set on every run; `repos-result` is `{}` outside a fleet | No error. A step testing `repos-result != ''` to detect a fleet run now always passes; [section 6](#6-the-three-outputs-are-always-set) |
| One `--json` envelope on the command line | `validate` printed `{file, valid, sections}`, `permissions` a bare grant map, `init` `skippedSections` | Every subcommand prints `{result, ...}`; `permissions` puts its grants under `grant`, lists are lists | A `jq` filter on the old keys reads `null`; [section 7](#7-one---json-envelope) |
| A snapshot section that fails on its own fails the target | `result: partial`, exit 0, the file written without that section | `result: failed`, exit 1, no file for that target; `init` refuses to write | The workflow step fails where it passed; [section 8](#8-a-failed-snapshot-section-fails-the-target) |
| Library: a documented public entry, an internal one, and the v3 names | One entry, 192 names; `GithubApi`, `RepoRunReport`, `validateSettings` returning `warnings` | `.` holds the 118 documented names, `./internal` the rest; `GitHubApi`, `CheckReport`, every report carries `log` | The old import fails to compile, naming the missing export; every rename is in [section 9](#9-library-the-public-entry-and-the-v3-names) |
| One redacted label in every mode | A single-repository run labelled its hidden target `private repository`; a fleet numbered them `private repository #N` | `private repository #N` everywhere; a run over one repository is `#1` | No error. A log filter or artifact-report reader matching `private repository:` exactly no longer matches; [section 10](#10-one-redacted-label-in-every-mode) |
| Two live items under one identity fail the section | The last one listed won silently in most sections | Every live list refuses, naming the pair | The section fails until one is deleted on GitHub; [section 11](#11-two-live-items-under-one-identity-fail-the-section) |
| The webhook snapshot placeholder | `$WEBHOOK_SECRET_<id>` | `$SECRET_WEBHOOK_<id>` | No error: an old reference keeps resolving from its old export; a new snapshot writes the new name, so move both together; [section 12](#12-the-webhook-snapshot-placeholder-leads-with-secret_) |
| One wording per concept in drift lines and notes | Per-section spellings of "cannot verify", "left out", and field drift; quoted webhook labels | One template each | Only a grep over the output notices; [section 13](#13-one-wording-per-concept-in-drift-lines-and-notes) |
| Webhooks manage web hooks only | A service hook was matched and deleted like any other | A service hook or url-less hook is outside the section | It is left alone and noted by snapshot; [section 14](#14-webhooks-manage-web-hooks-only) |
| A ruleset without `source_type` is repository-owned | Kept with a note under `_undeclared: delete` | Deleted like any other undeclared repository ruleset | [section 15](#15-a-ruleset-without-source_type-is-repository-owned) |
| Underscore keys are directives, never notes | An unknown `_note: ...` at the top level was dropped silently | Only `_layering` and `_undeclared` exist; any other underscore key fails validation, on a wrapper and at the top level alike | Validation fails before any section runs, naming the two directives; [section 16](#16-underscore-keys-are-directives-never-notes) |
| `teams` takes the `_undeclared` knob | A plain array; an undeclared team was never listed or touched | `teams: {_undeclared: keep, entries: [...]}` accepted, default `keep`; `delete` revokes undeclared direct grants | No error. Every run now lists the repository's teams and notes each undeclared direct grant (access granted at the organization level is noted only under `delete`); snapshots write the wrapper form; [section 17](#17-teams-takes-the-_undeclared-knob) |
| `GSAC_RETRY_BASE_MS` | `RETRY_BASE_MS`, undocumented | `GSAC_RETRY_BASE_MS`, in the inputs reference | No error: an unknown environment variable is ignored, so a harness setting the old name waits real seconds; [section 18](#18-gsac_retry_base_ms) |
| The sealing key is read at apply time | Check mode read `GET .../secrets/public-key` and failed on a malformed key | The first sealed PUT reads it at apply | Check mode issues one request fewer per secret family; a malformed key fails at apply; [section 19](#19-the-sealing-key-is-read-at-apply-time) |
| Environment secrets and variables plan through the shared engines | Their own wording | The engines' wording | Only a grep over the output notices; [section 20](#20-environment-secrets-and-variables-plan-through-the-shared-engines) |
| The `build` branch retires | Every green push appended a packaged commit to the `build` branch; `latest` and the release tags pointed into it | One packaged commit per `main` commit under the tag `build/<position>.<sha7>`, the ten newest kept; `latest`, `@v3`, and `vX.Y.Z` point at them; the branch was deleted on 2026-09-13 | A sha pin into the branch names a commit no ref keeps alive, so GitHub may collect it at any time; a pin taken from a build tag goes when ten newer commits have been packaged; [section 21](#21-the-build-branch-retires) says what to pin instead |
| One wording for every face | The command line reworded two remedies and refused `private-report: artifact` on its own; other remedies said "re-run the workflow" | One problem renderer; remedies name the input and its flag; `parseConfig` refuses the artifact channel for a face without an upload (`input-artifact-unsupported`) | No error. A step or script matching an error line by its old text stops matching; [section 22](#22-one-wording-for-every-face) |
| Library: one owner per refusal, one selection type | `parseConfig(read, env)`; `executeRun` returned a number and took `describe`; `artifact-uploader-missing`; `validateSettings` took a `Set` | `parseConfig(read, env, capabilities)`; `executeRun` returns `{exitCode, fatal?}`; `input-artifact-unsupported`; `SectionSelection` everywhere; `writeReplacing`, `snapshotFileDestination`, the `central-file` role | The call fails to compile, naming the missing argument or member; [section 23](#23-library-one-owner-per-refusal-one-selection-type) |
| The merged file is the fold in the canonical order, and a null over nothing drops | `mode: merge` wrote the validated parse, keys in the schema's order; `labels: null` with nothing below failed the merge | The fold rendered in the one canonical order (sections in execution order, keys as the schema declares them, the entries of every keyed list by identity; `branches`, `bypass_actors`, `reviewers`, and scalar lists as written), byte for byte what `mergeSettings` returns as `yaml`; the null drops without a notice | No error: a committed merged file reorders once, and a one-layer read of a fleet layer carrying `labels: null` succeeds; [section 24](#24-the-merged-file-is-the-fold-in-the-canonical-order-and-a-null-over-nothing-drops) |
| Every live read is parsed at the port | A body off the documented shape flowed into the comparison (a null Actions body read as drift on every key) | Every read fails loudly naming the endpoint and the field | The section fails with `returned a body outside the documented shape`; [section 25](#25-every-live-read-is-parsed-at-the-port) |
| The snapshot file is canonical and undated | The second header line read `# Snapshot of owner/name taken <instant>`; list entries sat in the order GitHub listed them | No dated line: the run's notice and the step summary say `snapshot taken <instant>`; the document renders in the canonical order the merged file shares | No error: a committed snapshot reorders once and loses its dated second line; a script reading the instant from the file reads the run's notice instead; [section 26](#26-the-snapshot-file-is-canonical-and-undated) |

## 1. The defaults-file fallback

Blast radius first: with `repos: "*"`, every discovered repository that has no `.github/settings.yml` now receives the whole defaults document, where v2 skipped it. A defaults file with `labels: {_undeclared: delete, entries: [...]}` deletes labels on all of them.

1. Run the fleet workflow with `mode: check` on v3 and read which targets say `applying the defaults file: the repository has no .github/settings.yml on its default branch`.
2. For each, decide: give the repository its own file, or accept the defaults as its complete settings.
3. Targets that used a partial file as an overlay on the defaults now need the full document. Build it with [layering](../operate/layering.md): the old defaults file is the lowest layer, the old target file the highest, and `merged-file` is the document the target applies.

The token also matters: a target the token cannot read Contents on fails with an error naming `Contents: read`, where v2 could mistake the denial for a missing file. Grant the permission or drop the target from `repos`.

The [multi-repo guide's fallback section](../operate/multi-repo.md#fallback-for-repositories-without-a-settings-file) owns the rule.

## 2. undeclared becomes _undeclared

Every list section wrapper, and every nested one (`environments[].variables`, `environments[].secrets`, `environments[].deployment_branch_policies`, `environments[].deployment_protection_rules`), spells the knob `_undeclared`.

```yaml settings
labels:
  _undeclared: keep
  entries:
    - name: bug
      color: "d73a4a"
```

The old spelling fails validation before any section runs, so a check run finds every stale file at once. A v2 `labels` wrapper in `.github/settings.yml` produces this error:

```text
.github/settings.yml has malformed section entries: labels: Unrecognized key: "undeclared"; the wrapper's policy key "undeclared" was renamed to "_undeclared" in v3 (a directive, like _layering) - write _undeclared: keep or _undeclared: delete. Fix these values in the settings file (only the named keys are validated; extra fields pass through, except in closed sections and strict nested objects like actions.cache, which reject unrecognized keys)
```

The underscore marks the action's directives: `_undeclared` (live axis) and `_layering` (merge time), and nothing else ([section 16](#16-underscore-keys-are-directives-never-notes)). The [undeclared policy](../reference/undeclared-policy.md) page owns the knob.

## 3. Layering only in mode: merge

If a v2 setup relied on the defaults merge for anything beyond "no file, use the defaults", it becomes a two-step workflow: a `mode: merge` step folds the layers into `merged-file`, and the apply or check step runs that file. The [layering guide](../operate/layering.md) has the rules, the worked example, and the workflow.

The fold is not the v2 merge. Three differences to audit when you rebuild an old overlay:

| In v2's defaults merge | In a `mode: merge` fold |
|---|---|
| Lists always replaced: a target's `labels` replaced the defaults' | `labels` and `rulesets` union by key under the default `layering: merge`; set `layering: replace` (or `_layering: replace` on the section) to keep the old replacement |
| A nested `null` in the target survived as a value (`pages.cname: null` removed the domain) | A `null` over a key a lower layer declared deletes the key from the merged document, with a notice; it only stays a value when nothing below declares it |
| A `null` section in the target opted out of the defaults' section | The same, now with a notice naming the layer and path; over nothing it keeps its engine meaning. Except `pages` and `interaction_limits`: there `null` is the section's value and is written over the defaults' declaration with no notice, so the merged file turns the site or the limit off rather than opting out |

## 4. Commas and newlines in a settings-file path

`mode: merge` takes its layers as a newline- or comma-separated list in `settings-file`, and the separators are the same in every mode. So no settings file can be named with a comma or a newline in its path any more. v2 read `settings-file: settings,prod.yml` as one file; v3 apply refuses it:

```text
the "settings-file" input is "settings,prod.yml", which contains a list separator: apply mode reads exactly one settings file, and only mode: merge takes a newline- or comma-separated list. Name one file, or set mode: merge to fold the list into one document
```

Check mode says the same with `check mode`. The fix is a rename: move the file to a path without the separator (`settings-prod.yml`) and point `settings-file` at it.

## 5. repos-result rows spell skipped-sections

Every key inside the `repos-result` map is spelled like the outputs themselves: kebab-case. The one camelCase key, `skippedSections`, is gone.

```text
{"o/r": {"result": "partial", "source": "central", "skipped-sections": ["actions_variables"]}}
```

A step that read `fromJSON(steps.settings.outputs.repos-result)['o/r'].skippedSections` now reads `null`; rename the key in the expression.

## 6. The three outputs are always set

| Output | v2 | v3 |
|---|---|---|
| `result` | Every mode | Every mode |
| `skipped-sections` | Apply, check, snapshot; `merge` set it to `""` | Every mode, `""` when none |
| `repos-result` | Multi-repo runs and `snapshot-dir` only; unset elsewhere | Every mode; `{}` for a run over one repository or a merge |

A step that used an unset `repos-result` to tell a single-repo run from a fleet run must test `repos-result == '{}'` instead. The exit rule did not move: 1 exactly when `result` is `failed`, or `drift` in `mode: check`.

## 7. One --json envelope

Every `gsac` subcommand prints one object under `--json`, `result` first:

| Command | v2 | v3 |
|---|---|---|
| `check`, `apply`, `merge`, `snapshot` | `{"skipped-sections": "", "result": "clean"}` | `{"result": "clean", "skipped-sections": [], "repos-result": {}}`: the list is a list, the map a map |
| `validate` | `{"file": ..., "valid": true, "sections": [...]}` | `{"result": "valid", "file": ..., "sections": [...]}` |
| `permissions` | `{"labels": "<grant>", ...}` | `{"result": "valid", "file": ..., "grant": {"labels": "<grant>", ...}}` |
| `init` | `{"file", "repository", "result", "skippedSections", "failedSections", "grant"}` | `{"result", "file", "repository", "skipped-sections", "grant"}`; `failedSections` is gone, since a failed section now fails init |
| any failure | `{"file", "valid": false, "problem"}` or `{"result": "failed", "problem"}`; a mode command's fatal problem and a parser error printed no `problem` | `{"result": "failed", "file"?: ..., "problem": ...}`; a mode command that fails before any target runs prints `problem` beside its three outputs, a parser error or a crash prints it alone. A target that fails while running has no `problem`: its errors are on stderr and its row in `repos-result` |

## 8. A failed snapshot section fails the target

Every mode now applies one crash rule: a section whose read throws (an API error) fails its target, `result` is `failed`, the run exits 1, and no snapshot file is written for that target. v2 wrote the file without the section and reported `partial` with exit 0. A value the section's own schema rejects already failed the target in v2; that case did not move. A denial under `on-missing-permission: warn` still skips the section and still reports `partial`.

`gsac init` follows: a failed section refuses to write the settings file, with the errors above naming the section and the fix.

## 9. Library: the public entry and the v3 names

For `@vivswan/github-settings-as-code` consumers. Before and after, one program:

```text
v2   import { GithubApi, checkRepository, validateSettings, runForRepo } from "@vivswan/github-settings-as-code";
     const { settings, warnings } = validateSettings(doc)._unsafeUnwrap();
     await checkRepository(client, { repo, settings, onMissingPermission: "fail", sections: SectionSelection.ALL });

v3   import { GitHubApi, checkRepository, validateSettings } from "@vivswan/github-settings-as-code";
     import { runForRepo } from "@vivswan/github-settings-as-code/internal";
     const { settings, log } = validateSettings(doc)._unsafeUnwrap();
     await checkRepository(client, repo, settings);
```

The package now has two entries, and one naming family per layer:

| | v2 | v3 |
|---|---|---|
| The entry | One, 192 names, all pinned | `.`: the 118 names the [library page](../reference/library.md#the-api-by-group) tables document, under semver. `./internal`: everything else the action, the CLI, and the tests import, with no promise |
| The verbs | `checkRepository`, `applyRepository`, `snapshotRepository`, `snapshotRepositories`, `validateSettings`, plus `foldLayers` and `mergeLayers` for a merge | The same five, plus `mergeSettings`; every verb takes its inputs positionally and one options object of the same knobs (`sections`, `onMissingPermission`, `io`, ...), each defaulted as the action's input |
| The reports | `RepoRunReport` (`log`), `SnapshotReport` (`log`), `validateSettings` (`warnings: string[]`) | `CheckReport`, `ApplyReport`, `SnapshotReport`, `MergeReport`, `ValidateReport`: one `log: CollectedLine[]` on every report, the annotation level kept beside each line |

Every rename, old to new. An old name fails to compile, naming the missing export; the new name is in the same package unless the row says `./internal`:

| v2 | v3 |
|---|---|
| `GithubApi` | `GitHubApi` |
| `GithubClient` | `GitHubClient` |
| `MissingPermissionPolicy` | `OnMissingPermission` (the input's name) |
| `checkRepository(client, { repo, settings, onMissingPermission, sections }, io?)` | `checkRepository(client, repo, settings, { onMissingPermission?, sections?, io?, secretSource?, secretEnv? })` |
| `applyRepository(client, { repo, settings, onMissingPermission, sections }, io?)` | `applyRepository(client, repo, settings, { onMissingPermission?, sections?, io?, secretSource?, secretEnv? })` |
| `RepoRunReport` | `CheckReport`, `ApplyReport` |
| `RepoRunOptions` | `CheckOptions`, `ApplyOptions` (the knobs alone); the engine's `RepoRunOptions` is in `./internal` |
| `snapshotRepository(client, repo, { sections?, onMissingPermission?, io? })` | Unchanged call; its options type is `SnapshotOptions` |
| `SnapshotLibraryOptions` | `SnapshotOptions` |
| `validateSettings(doc, { source?, sections?: ReadonlySet<SectionKey> })` returning `{ settings, warnings: string[] }` | `validateSettings(doc, { source?, sections?: SectionSelection, io? })` returning `{ settings, log: CollectedLine[] }` (`ValidateOptions`, `ValidateReport`) |
| `foldLayers(layers, sourceLabel, layering, io)` | `mergeSettings(layers, { source?, layering?, io? })` returning `{ settings, notices, yaml, log }` (`MergeOptions`, `MergeReport`); `foldLayers` itself is in `./internal` |
| `mergeLayers`, `canonicalDocument`, `renderCanonicalYaml`, `renderSnapshotYaml` | `./internal`; `MergeReport.yaml` and `SnapshotReport.yaml` carry the rendered file |
| `validateSettingsDoc` | `./internal`: the engine's boundary, which prints its warnings to an `Io`; `validateSettings` collects them into `log` |
| `runForRepo`, `preflightProbe`, `skippedSectionKeys`, `RepoRunResult`, `RepoResult` | `./internal` |
| `SnapshotResult`, `RenderableSnapshot`, `SNAPSHOT_SCHEMA_URL` | `./internal`; `SnapshotReport.yaml` already carries the schema pin in its header |
| `REPO_RESULTS`, `SNAPSHOT_RESULTS`, `MERGE_RESULT` | `RUN_RESULTS` (worst first: `failed`, `drift`, `partial`, `skipped`, `applied`, `clean`, `snapshot`, `merged`) |
| `SnapshotRunResult` | `RunOutcome` |
| `worstOf(results, check)`, with `check` picking the floor of an empty list | `worstOf(results)`; an empty list throws, since every run concludes over at least one target |
| `INPUT_DECLS`, `InputDecl`, `InputName`, `MODES`, `Mode`, `FILTER_INPUTS`, `MERGE_INPUTS`, `MERGE_ONLY_INPUTS`, `MERGE_REJECTED_INPUTS`, `SNAPSHOT_INPUTS`, `SNAPSHOT_ONLY_INPUTS`, `SNAPSHOT_REJECTED_INPUTS`, `parseSnapshotFileConfig`, `SnapshotFileConfig`, `DEFAULT_PRIVATE_REPOS`, `DEFAULT_SETTINGS_FILE` | `./internal` |
| `resolveTargets`, `ResolvedTargets`, `TargetsConfig`, `RunFlowConfig` | `./internal` |
| `capturingIo`, `planRedaction`, `publicDetail`, `toPublicView`, `PublicTargetView`, `PRIVATE_REPOS_POLICIES`, `PrivateReposPolicy` | `./internal` |
| `getRepoFile`, `createVisibilityResolver`, `RepoVisibility`, `SECRET_RESPONSE_WITHHELD`, `SECRET_TRANSPORT_WITHHELD`, `TraceIo` | `./internal` |
| `applyMarkerInjection`, `PRIVATE_REPORT_CHANNELS`, `ISSUE_TITLE`, `MARKER_LABEL`, `MARKER_LABEL_CONFIG` | `./internal` |
| `AFFILIATIONS`, `ARCHIVED_FILTERS`, `FORKS_FILTERS`, `VISIBILITY_FILTERS`, `DiscoveryProblem` | `./internal` |
| `stripNulls`, `describeOptOut` | `stripNulls` in `./internal`; `describeOptOut` stays public |
| `quoteList`, `RERUN_ADVICE`, `ProblemOf`, `SettingsProblem`, `LayerProblem`, `CentralFileProblem`, `TopLevelShape` | `./internal` |
| `DOCUMENT_DIRECTIVE_KEYS`, `PROBOT_PARITY_KEYS`, `UndeclaredPolicy`, `UndeclaredPolicyList`, `MustBeNever` | `./internal`; `UNDECLARED_POLICY_SECTIONS` and `UndeclaredPolicySection` stay public |
| `denialPosture`, `readGating`, `writeGatedReads`, `sectionOperations`, `SectionMeta`, `KeyedListLayering`, `grantFor`, `PatResource`, `SectionPermission` | `./internal` |
| `Justification`, `PlannedOpBase`, `Tolerance`, `Unverifiable` | `./internal` |
| `concludeSnapshot` set `repos-result` only in the dir form; `concludeMerge` set no `repos-result` | Every conclude sets the three outputs |
| `FinishedSnapshot` carried `view` / `views`: each target already projected into a `SnapshotTargetView` | `FinishedSnapshot` carries `target` / `targets`: each a `TargetOutcome` whose `detail` is sealed for a hidden target; `concludeSnapshot` opens it through `publicDetail` / `toPublicView` |
| `SnapshotTargetView` (snapshot's own redacted projection) | Removed; the shared redaction-safe projection is `PublicTargetView` in `./internal`, which now carries the snapshot `file` |

## 10. One redacted label in every mode

Every hidden target is labelled `private repository #N`, numbered in target order, whatever the mode. A run over one repository (`repository:` with `private-repos: redact`, or `snapshot-file`) is a fleet of one, so its label is `private repository #1`:

```text
v2: warning: private repository: drift - repository. details hidden: ...
v3: warning: private repository #1: drift - repository. details hidden: ...
```

The `artifact` report channel heads that run's report `<!-- private repository #1 -->` for the same reason. A filter matching the bare label needs the `#1`.

Snapshot targets ride the same seal now: a private target's notes, file path, and section detail close sealed exactly as a multi-repo apply target's do, and a private target that fails gets the same one-line annotation (`private repository #N: failed - <sections>`) a fleet target gets. The [private repositories guide](../operate/private-repositories.md#one-seal-every-mode) owns the rule.

## 11. Two live items under one identity fail the section

v2 picked one silently (the factory sections refused only a claimed pair; milestones, rulesets, webhooks, custom properties, secret scanning patterns, environment secrets and variables kept the last one listed; workflows matched the first; teams acted on both). v3 refuses every live list the same way, whether or not the settings file declares the pair: the list sections, the nested environment lists, and the seven reads that had no guard before (the teams listing, the workflows listing, the environment listing, the pinned environments, the protected-branch listing, the GraphQL protection rules, and the protection-rule Apps an environment can enable). Each pair is named the same way, the key first and the server id beside it when one exists:

```text
webhooks: GitHub holds webhooks that resolve to one identity: "https://ci.example.com/hook (hook id 11)" and "https://ci.example.com/hook (hook id 12)". This section manages one webhook per identity, so it cannot tell them apart; delete all but one of each on GitHub, then run again
```

Snapshot says the same. Delete the duplicates on GitHub, then re-run. The protection-rule Apps list is the one read whose refusal can follow a write: for an environment the run creates, GitHub serves the list only once the environment's PUT has landed, so that refusal lands after it; for an existing environment it lands at plan, before any write.

## 12. The webhook snapshot placeholder leads with SECRET_

```yaml settings
webhooks:
  entries:
    - config:
        url: https://ci.example.com/hook
        secret: $SECRET_WEBHOOK_601   # v2 wrote $WEBHOOK_SECRET_601
```

Every snapshot secret now leads with `SECRET_`, the store name second. A file holding the old reference keeps working with its old export; to move, change the reference in the file and the exported variable together (`WEBHOOK_SECRET_601` becomes `SECRET_WEBHOOK_601` in both), or re-snapshot and export the new name.

## 13. One wording per concept in drift lines and notes

Anything that greps the check output for these lines needs the new spelling. Two templates reach every site:

- the cannot-verify line: the webhook secret, the write-only `check_suite_preferences` note, `interaction_limits.expiry`, and the repository toggles GitHub cannot read back (`enable_git_lfs`);
- the left-out line: rulesets, webhooks, the teams and collaborators snapshot notes, an inherited interaction limit, and the secondary snapshot reads (actions, environments, repository) a denied grant skips under `on-missing-permission: warn`; a denied primary read still says `skipped`.

| Line | v2 | v3 |
|---|---|---|
| A webhook's label | `webhooks["https://ci.example.com/hook"].active` | `webhooks[https://ci.example.com/hook].active` |
| A field mismatch (milestones, rulesets, collaborators, teams, every list section) | `milestones[v1].state: "closed" != "open"` and `teams[platform]: live role "read" != declared "write"` | `milestones[v1].state: declared "closed" != live "open"; apply will set the declared value` |
| A webhook's events | `... declared [...] != live [...] (compared order-insensitively)` | one line per element: `webhooks[<url>].events: missing "release"` |
| A value check mode cannot compare | `... so the declared value cannot be verified; apply re-sends it on every run so rotations propagate` | `<label>: <why>, so check mode cannot verify <what>; apply <re-sends it> on every run` |
| A resource a snapshot reads but does not declare | `rulesets[x]: inherited from the organization ..., so it is not part of the repository's snapshot` and `teams[x]: ...; not declared` | `<label>: left out of the snapshot - <reason>` |
| An email invitation in a collaborators snapshot | `invitation 502 was sent by email, so no username can declare it; not declared, and apply leaves it untouched` | `collaborators[invitation 502]: left out of the snapshot - sent by email, so no username can declare it; apply leaves it untouched` |
| A personal account under `teams` or `custom_properties` | `teams: owner "o" is a personal account, not an organization, so team access does not apply` and `custom_properties: owner "o" is a personal account, and custom properties require an organization-owned repository` | `<section>: owner "o" is a personal account, not an organization, so this section does not apply` |
| A ruleset update's change line | `updated ruleset "main" (id 42)` | `updated ruleset "main"` |
| A milestone delete's change line | `DELETED undeclared milestone "v0.9" (detached from every issue that carried it)` | `DELETED undeclared milestone "v0.9"` (the drift line beside it still names the detaching) |

## 14. Webhooks manage web hooks only

- A legacy service hook (`name` other than `web`) or a hook without a `config.url` is outside the section: plan neither matches, notes, nor deletes it (v2 deleted one under `_undeclared: delete`); snapshot leaves it out with a note.
- No write carries `name`: GitHub defaults a new hook to `web`, the one value the slice admits, and the update endpoint takes no name.
- A declared `insecure_ssl: 0` is written as GitHub stores it, the string `"0"`.
- A snapshot writes a hook's `config` keys in the order GitHub lists them, the `$SECRET_WEBHOOK_<id>` reference last.

## 15. A ruleset without `source_type` is repository-owned

v2 refused to delete an undeclared ruleset whose list entry lacked `source_type`, with a note. v3 reads a missing `source_type` as `Repository`, the only kind the repository endpoints can write, so `_undeclared: delete` deletes it.

## 16. Underscore keys are directives, never notes

v2 dropped any unknown top-level key starting with `_` as a private note, while rejecting the same key inside a section's `{entries}` wrapper. v3 has one rule everywhere: the underscore belongs to the two directives, `_layering` and `_undeclared`, and any other underscore key fails validation before any section runs. The one corner it does not reach: a `null`-valued underscore key inside a wrapper (`labels: {_notes: null, entries: []}`) is a merge marker the fold strips before it judges the layer, so a `mode: merge` run passes it silently.

```yaml settings
# owner: platform-team, see runbook RB-112
labels:
  - name: bug
    color: "d73a4a"
```

A v2 file with `_owner: platform-team` at its top level now fails with:

```text
unknown underscore key in .github/settings.yml: _owner. The underscore marks this action's directives, "_layering" (a file's top level or a list section's {entries} wrapper) and "_undeclared" (a wrapper), and nothing else; there are no private-note keys. Remove the key, or keep the note as a YAML comment
```

A `sections` allowlist does not soften it (an unknown plain section outside the allowlist still only warns). The reason is the loud-failure promise: a misspelled `_layerin: replace` dropped as a note would merge a layer its author meant to replace. Move each note into a YAML comment; the [layering guide](../operate/layering.md#three-knobs) states the rule beside the two directives.

## 17. teams takes the _undeclared knob

`teams` joins the sections that take the `{_undeclared, entries}` wrapper, with the default `keep`: a team with direct access that the file does not name is left alone, as before. What changes:

- Every apply and check now lists the repository's teams (`GET /repos/{owner}/{repo}/teams`; the same Administration grant) and prints one note per undeclared direct team, naming the knob.
- `_undeclared: delete` revokes the direct grants the file does not name (`DELETE /orgs/{org}/teams/{slug}/repos/{owner}/{repo}`). Access granted at the organization or enterprise level is never touched; under `delete` it is noted as beyond the repository's reach.
- `mode: snapshot` and `gsac init` write the wrapper form with `_undeclared: keep` spelled out, as the other knobbed sections do.

The plain array form keeps working, and the [undeclared policy](../reference/undeclared-policy.md) page lists the default beside the others.

## 18. GSAC_RETRY_BASE_MS

The one environment variable of the tool's own, the retry-timing test knob, is `GSAC_RETRY_BASE_MS`; v2 read it as `RETRY_BASE_MS`, undocumented. An environment variable has no channel for a loud error, so the old name is simply ignored: a harness that set `RETRY_BASE_MS=1` to speed a mock run up now waits real seconds until it is renamed. The [inputs reference](../reference/inputs.md#environment-variables) lists it with the other variables a run reads.

## 19. The sealing key is read at apply time

Every secret family (`actions_secrets`, `dependabot_secrets`, `codespaces_secrets`, `agents_secrets`) now reads `GET .../secrets/public-key` from the first sealed PUT, as environment secrets always did.

- Check mode issues one request fewer per family and never touches the key endpoint.
- A malformed key fails the first PUT at apply, before its request leaves, where v2 failed the plan in check mode too.
- The cannot-verify note carries the section label and the shared template: `actions_secrets: Actions secret values cannot be read back from GitHub, so check mode cannot verify them, only that each declared secret exists; apply re-seals and rewrites every declared value on every run`.

## 20. Environment secrets and variables plan through the shared engines

Their lines are the engines' lines now:

| Line | v2 | v3 |
|---|---|---|
| A missing declared variable | `environments[prod].variables[X]: missing - declared in the settings file but not on the environment; ...` | `... but not on environment "prod"; ...` |
| A variable delete | `DELETED undeclared variable "X" from environment "prod"` | `DELETED undeclared variable "X" in environment "prod"` |
| Two entries naming one variable or secret | `environments: the "prod" entry declares variables that GitHub treats as the same variable ...` | `environments: the settings file declares entries that name the same variable of the "prod" environment: "a" and "A". Keep exactly one entry per resource` (branch policies and protection rules spell theirs the same way) |
| The secrets cannot-verify note | once per environment that exists | once per environment with declared secrets, the missing environment included, under the `environments[prod].secrets` label |

Repository variable operations (`actions_variables`, `agents_variables`) gain a describe line in failure prose (`creating Actions variable "X"`); nothing else moves.
## 21. The build branch retires

The `build` branch was deleted on 2026-09-13. A `Vivswan/github-settings-as-code@<sha>` pin into it names a commit no ref keeps alive, so GitHub may collect it at any time: repin to a release tag, `@v3`, `@latest`, a `build/<position>.<sha7>` tag (the ten newest kept), or an npm version.

Every green push to `main` now mints one packaged commit, the main commit's child carrying the built action and library, under the tag `build/<position>.<sha7>` (the position is the commit's first-parent count on `main`). Each green push then prunes those tags to the ten newest: a tag goes once ten newer commits have been packaged, and GitHub may then collect its commit.

| You pin | Lifetime | Do |
|---|---|---|
| `@v3` or `@latest` | Moves forward only, never deleted | Nothing |
| A release tag or its commit sha (`git rev-parse v3.0.0`) | Permanent | Nothing |
| A sha from the `build` branch | Unreachable since the branch was deleted on 2026-09-13; GitHub may collect the commit at any time | Repin to `@v3` or a release tag's commit now |
| A sha from a `build/*` tag | Until ten newer commits are packaged (the next merge, for an old tag) | Pin the release tag's commit or an npm version instead |

## 22. One wording for every face

The action and the command line print the same line for the same problem; the remedy names the input and, where one exists, its flag.

| Problem | v2 (action) | v2 (command line) | v3 (both) |
|---|---|---|---|
| No token | `Set the "token" input on the action step (or export GITHUB_TOKEN)` | `Pass --token, or export GITHUB_TOKEN` | `Set the "token" input (--token on the command line), or export GITHUB_TOKEN` |
| No repository | `Set the "repository" input (or GITHUB_REPOSITORY) to a value like "octocat/hello-world"` | `Pass --repository owner/name (inside GitHub Actions, GITHUB_REPOSITORY supplies it)` | `Set the "repository" input (--repository on the command line) to a value like "octocat/hello-world"; inside GitHub Actions, GITHUB_REPOSITORY supplies it` |
| Unknown section in `sections` | `Fix the name in the workflow's input list` | same | `Fix the section name` |
| A transient API failure | `... re-run the workflow, and retry later if it persists` | same | `... re-run, and retry later if it persists` (the report channels say `Re-run, or set private-report: none if it persists`) |
| `private-report: artifact` off the runner | accepted at the parse (the action has the upload; a library caller without an uploader failed later with `artifact-uploader-missing`) | `the "private-report" input is "artifact", which is not a supported private-report channel from the command line ...` | `private-report: artifact uploads the reports as a workflow artifact, which only the GitHub Actions runner can do, and this run has no artifact upload ... Set private-report to "issue", "issue-on-failure", or "none"` |
| `gsac init --settings-file a,b` | `the --settings-file value "a,b" contains a comma or a newline, which check and apply read as a list separator ...` | | `the "settings-file" input is "a,b", which contains a list separator: init writes exactly one settings file ... Name one file` |
| An unreadable `repos-dir` file | `cannot read settings from <path>: ... Fix the file, or delete it to stop managing this repository` | | `cannot read the central settings file <path>: ... Fix the file, or delete it to stop managing this repository` (a YAML syntax error in it reads the same way, where v2 said `cannot parse`) |

## 23. Library: one owner per refusal, one selection type

For `@vivswan/github-settings-as-code` consumers.

| v2 | v3 |
|---|---|
| `parseConfig(read, env)`; the command line refused `private-report: artifact` before calling it, and the flows checked for the uploader again (`artifact-uploader-missing`) | `parseConfig(read, env, { artifactUpload })`: the one refusal, `input-artifact-unsupported`; `runSingle` and `runMulti` no longer check |
| `executeRun(cfg, deps): Promise<number>`, with `deps.describe` rewording a fatal problem | `executeRun(cfg, deps): Promise<RunEnd>`, `{ exitCode, fatal? }`; `failRun(io, problem)` takes no wording hook |
| `validateSettingsDoc(doc, source, onlySections: ReadonlySet<SectionKey>, io)`; `validateSettings(doc, { sections?: ReadonlySet<SectionKey> })` | Both take a `SectionSelection` (`SectionSelection.ALL` for no allowlist) |
| `parseSnapshotFileConfig(read, env, snapshotFile)` | `parseSnapshotFileConfig(read, env, "settings-file")` reads the destination itself; `snapshotFileDestination(read, "settings-file")` names it before parsing |
| The snapshot staged through `<path>.tmp` and renamed; the merged file and init wrote in place, each with its own try/catch | `writeReplacing(path, text): Result<void, string>` stages and renames for all three |
| `SettingsFileRole`: `settings-file`, `defaults-file`, `layer` | plus `central-file`, the repos-dir file a multi-repo target is read from |


## 24. The merged file is the fold in the canonical order, and a null over nothing drops

Two changes to the document `mode: merge` writes and `mergeSettings` returns as `yaml`; the number of this section may shift as v3 grows.

```text
v2   repository:                         # zod's order: the schema declares enable_vulnerability_alerts first
       enable_vulnerability_alerts: true
       has_issues: true
     labels: null                        # nothing below declares labels: "labels: ... parsed as null", the merge fails

v3   repository:                         # the canonical order: declared keys as the schema lists them, then the rest by code point
       enable_vulnerability_alerts: true
       has_issues: true
                                         # no labels key: the null opted out of nothing and dropped, without a notice
```

- The written file is the fold in the canonical order every rendered document shares ([section 26](#26-the-snapshot-file-is-canonical-and-undated) names the rules); validation judges the fold and never re-serializes it. A merged file committed under v2 reorders once, and reordering keys, or the entries of a sorted list, in a layer changes nothing in the file; `branches`, the pinned environments, and scalar lists keep their written order, since it is content.
- A top-level `null` on a section nothing below declares drops, on every section but `pages` and `interaction_limits`, where null is the section's value and stays. v2 refused the merge naming the section, so a one-layer read of a fleet layer carrying `labels: null` failed.

## 25. Every live read is parsed at the port

Every GET and GraphQL query a section issues now passes through one parser before the section sees the body, so a response off the documented shape fails the section instead of flowing into a comparison. v2 parsed some reads (the lists, the toggles) and compared others raw: a `null` Actions permissions body read as drift on every declared key and re-applied the PUT on every run; a pinned environment without a position was reported by its own message.

```text
actions: GET /repos/{owner}/{repo}/actions/permissions returned a body outside the documented shape - (body): Invalid input: expected object, received null. Check the "api-version" input against the GitHub REST docs for this endpoint
```

A GraphQL read says `GRAPHQL <operation>` in place of the method and path and points at the GraphQL reference. Where a read names its resource, the denial and the shape failure both carry it (`GET .../deployment_protection_rules (environment "production"): 403 ...`). The `api-version` advice is the fix in every case: the shapes are GitHub's documented ones.

Two smaller moves ride along:

- A section that reads anything must declare `snapshot()`; only the write-only `check_suite_preferences` reports `unsupported`, and the `snapshot is not implemented for this section yet` note is gone.
- The organization-only sections (`teams`, `custom_properties`) are probed for the owner kind by the registry, ahead of their own plan and snapshot. The personal-account note is unchanged; a settings-file mistake in those sections (two entries naming one team) is now reported after that one public probe instead of before any request.

## 26. The snapshot file is canonical and undated

The file `mode: snapshot`, `gsac init`, and `snapshotRepository` write carries no timestamp, and its document renders in the one canonical order the merged file shares, so a snapshot of an unchanged repository is byte for byte the last one and a diff between two snapshots shows only what changed on GitHub.

```text
v2   # <the schema pin>
     # Snapshot of octocat/hello-world taken 2026-09-11T06:17:00.000Z
     labels:
       _undeclared: delete
       entries:
         - name: docs                  # the order GitHub listed them
         - name: bug

v3   # <the schema pin>
     labels:
       _undeclared: delete
       entries:
         - name: bug                   # by name
         - name: docs
```

The moment moves to the run: one `notice: snapshot taken 2026-09-11T06:17:00.000Z` annotation and a `Snapshot taken ...` line in the step summary. A script that read the instant from the file's second line reads the notice instead.

The canonical order, the same for the snapshot and the merged file:

| Node | Order |
|---|---|
| The top level | The sections in the order the action applies them (`SECTION_KEYS`), then `_layering`, then any other key by code point |
| A mapping the schema declares | Its properties as the schema (and the published JSON schema) lists them; keys the schema does not declare follow by code point (an integer-like key such as `"10"` leads, in numeric order, as JavaScript enumerates it) |
| A mapping the schema leaves open (a rule's `parameters`, a bypass actor) | Keys by code point |
| A list of entries with an identity (labels by `name`, webhooks by `config.url`, milestones by `title`, collaborators by `username`, `rules` by `type`, and so on) | Sorted by the identity, ties by the entry's canonical JSON |
| `environments` | The `pinned: true` entries first in their written order, since that order is the pin rank; the rest by `name` |
| `branches` | As written: GitHub applies overlapping wildcard rules in creation order, and apply creates them in file order |
| Any other list (`topics`, `include` patterns, `bypass_actors`, `reviewers`) | As written |
| Each section's header notes | By code point within the section |

The snapshot's notes are sorted the same way, in the file header and in the annotations. A snapshot committed under v2 reorders once.

## Order of operations

1. Rename any settings file whose path contains a comma, rename `undeclared` to `_undeclared` in every settings file, and move every other underscore key into a YAML comment; the v2 line accepts the old spellings only, so do all three together with the pin move.
2. Rename `skippedSections` to `skipped-sections` in every step expression that reads `repos-result`, and repoint `jq` filters at the `--json` envelope.
3. Where a snapshot wrote a `$WEBHOOK_SECRET_<id>` reference, change the reference and its exported variable to `SECRET_WEBHOOK_<id>` together, or re-snapshot.
4. Move the pin to `@v3` with `mode: check`.
5. Read the fallback notices and the drift; add merge steps where a target needs the old overlay behavior; delete duplicated live items the sections now refuse.
6. Switch back to apply.
