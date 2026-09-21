---
order: 20
---

# Upgrading from v2 to v3

Fifty-eight breaks. Nine are for library consumers (sections 9, 23, 24, 27, 34, 35, 54, 56, and 58), one is for anyone pinning a sha (section 21), and eighteen are parse-time refusals (sections 36 to 52 and 55): a declaration GitHub would reject, or that could never converge, now fails before any request. Section 53 is silent: YAML merge keys resolve. Section 57 respells one validation message.

The silent ones include the fallback, the renamed `GSAC_RETRY_BASE_MS`, the rendered file (it reorders once), and the snapshot file (it reorders once and no longer dates itself). Run `mode: check` before the first v3 apply and diff the first v3 rendered file.

The changelog entry for 3.0.0 will carry the release-please footers in the [CHANGELOG](https://github.com/Vivswan/github-settings-as-code/blob/main/CHANGELOG.md).

| Break | v2 | v3 | What the old form does now |
|---|---|---|---|
| `defaults-file` is a fallback | Merged under every multi-repo target; a target without a settings file was skipped | Applied whole to a target that has no settings file; a target with its own file is applied as written, never merged | No error. A target file written as a partial overlay now runs alone, and `pages: null` in it disables Pages instead of opting out of the defaults; the check-first steps are under [section 1](#1-the-defaults-file-fallback) |
| The wrapper key is `_undeclared` | `labels: {undeclared: keep, entries: [...]}` | `labels: {_undeclared: keep, entries: [...]}` | Validation fails before any section runs, naming the rename; the full error is under [section 2](#2-undeclared-becomes-_undeclared) |
| Layering happens in `mode: render` | The only merge was the defaults-file one | An ordered list of files folds in a render step; apply and check take one final document | No error. Reach for the [two-step workflow](../operate/layering.md#the-two-step-workflow) to get merging back |
| A `settings-file` path cannot contain a comma or newline | `settings-file: settings,prod.yml` named one file | A comma or newline is a list separator in every mode | Apply and check refuse the run before reading anything (the error is under [section 4](#4-commas-and-newlines-in-a-settings-file-path)); `mode: render` reads two layer paths |
| `repos-result` rows spell `skipped-sections` | `{"o/r": {"result": "applied", "source": "central", "skippedSections": []}}` | `{"o/r": {"result": "applied", "source": "central", "skipped-sections": []}}` | No error. A step reading `.skippedSections` gets `null`; [section 5](#5-repos-result-rows-spell-skipped-sections) |
| The three outputs are always set | `repos-result` existed only in multi-repo runs and the `snapshot-dir` form; unset elsewhere | `result`, `skipped-sections`, and `repos-result` are set on every run; `repos-result` is `{}` outside a fleet | No error. A step testing `repos-result != ''` to detect a fleet run now always passes; [section 6](#6-the-three-outputs-are-always-set) |
| One `--json` envelope on the command line | `validate` printed `{file, valid, sections}`, `permissions` a bare grant map, `init` `skippedSections` | Every subcommand prints `{result, ...}`; `permissions` puts its grants under `grant`, lists are lists | A `jq` filter on the old keys reads `null`; [section 7](#7-one---json-envelope) |
| A snapshot section that fails on its own fails the target | `result: partial`, exit 0, the file written without that section | `result: failed`, exit 1, no file for that target; `init` refuses to write | The workflow step fails where it passed; [section 8](#8-a-failed-snapshot-section-fails-the-target) |
| Library: a documented public entry, an internal one, and the v3 names | The pre-release v3 builds had one entry, 192 names; `GithubApi`, `RepoRunReport`, `validateSettings` returning `warnings` | the public entry holds the names the library page documents, the internal entry the rest; `GitHubApi`, `CheckReport`, every report carries `log` | The old import fails to compile, naming the missing export; every rename is in [section 9](#9-library-the-public-entry-and-the-v3-names) |
| One redacted label in every mode | A single-repository run labelled its hidden target `private repository`; a fleet numbered them `private repository #N` | `private repository #N` everywhere; a run over one repository is `#1` | No error. A log filter or artifact-report reader matching `private repository:` exactly no longer matches; [section 10](#10-one-redacted-label-in-every-mode) |
| Two live items under one identity fail the section | The last one listed won silently in most sections | Every live list refuses, naming the pair | The section fails until one is deleted on GitHub; [section 11](#11-two-live-items-under-one-identity-fail-the-section) |
| The webhook snapshot placeholder | `$WEBHOOK_SECRET_<id>` | `$SECRET_WEBHOOK_<id>` | No error: an old reference keeps resolving from its old export; a new snapshot writes the new name, so move both together; [section 12](#12-the-webhook-snapshot-placeholder-leads-with-secret_) |
| One wording per concept in drift lines and notes | Per-section spellings of "cannot verify", "left out", and field drift; quoted webhook labels | One template each | Only a grep over the output notices; [section 13](#13-one-wording-per-concept-in-drift-lines-and-notes) |
| Webhooks manage web hooks only | A service hook was matched and deleted like any other | A service hook or url-less hook is outside the section | It is left alone and noted by snapshot; [section 14](#14-webhooks-manage-web-hooks-only) |
| A ruleset without `source_type` is repository-owned | Kept with a note under `_undeclared: delete` | Deleted like any other undeclared repository ruleset | No error: under `_undeclared: delete` the ruleset is deleted, where v2 kept it with a note; [section 15](#15-a-ruleset-without-source_type-is-repository-owned) |
| Underscore keys are directives, never notes | An unknown `_note: ...` at the top level was dropped silently | Three directives exist, each at its own place: `_layering` at the top level or on a list section's wrapper, `_undeclared` at the top level or on a knobbed wrapper, `_remove: true` on a keyed list entry only, in a higher layer of a fold (a single document refuses it); any other underscore key at the top level or on a wrapper, or a directive out of its place, fails validation | Validation fails before any section runs, naming the directives; [section 16](#16-underscore-keys-are-directives-never-notes) |
| `teams` takes the `_undeclared` knob | A plain array; an undeclared team was never listed or touched | `teams: {_undeclared: keep, entries: [...]}` accepted, default `keep`; `delete` revokes undeclared direct grants | No error. Every run now lists the repository's teams and notes each undeclared direct grant (access granted at the organization level is noted only under `delete`); snapshots write the wrapper form; [section 17](#17-teams-takes-the-_undeclared-knob) |
| `GSAC_RETRY_BASE_MS` | `RETRY_BASE_MS`, undocumented | `GSAC_RETRY_BASE_MS`, in the inputs reference | No error: an unknown environment variable is ignored, so a harness setting the old name waits real seconds; [section 18](#18-gsac_retry_base_ms) |
| The sealing key is read at apply time | Check mode read `GET .../secrets/public-key` and failed on a malformed key | The first sealed PUT reads it at apply | Check mode issues one request fewer per secret family; a malformed key fails at apply; [section 19](#19-the-sealing-key-is-read-at-apply-time) |
| Environment secrets and variables plan through the shared engines | Their own wording | The engines' wording | Only a grep over the output notices; [section 20](#20-environment-secrets-and-variables-plan-through-the-shared-engines) |
| The `build` branch retires | Every green push appended a packaged commit to the `build` branch; `latest` and the release tags pointed into it | One packaged commit per `main` commit under the tag `build/<position>.<sha7>`, the ten newest kept; `latest`, `@v3`, and `vX.Y.Z` point at them; the branch was deleted on 2026-09-13 | A sha pin into the branch names a commit no ref keeps alive, so GitHub may collect it at any time; a pin taken from a build tag goes when ten newer commits have been packaged; [section 21](#21-the-build-branch-retires) says what to pin instead |
| One wording for every face | The command line reworded two remedies and refused `private-report: artifact` on its own; other remedies said "re-run the workflow" | One problem renderer; remedies name the input and its flag; `parseConfig` refuses the artifact channel for a face without an upload (`input-artifact-unsupported`) | No error. A step or script matching an error line by its old text stops matching; [section 22](#22-one-wording-for-every-face) |
| Library: one owner per refusal, one selection type | `parseConfig(read, env)`; `executeRun` returned a number and took `describe`; `artifact-uploader-missing`; `validateSettings` took a `Set` | `parseConfig(read, env, capabilities)`; `executeRun` returns `{exitCode, fatal?}`; `input-artifact-unsupported`; `SectionSelection` everywhere; `writeReplacing`, `snapshotFileDestination`, the `central-file` role | The call fails to compile, naming the missing argument or member; [section 23](#23-library-one-owner-per-refusal-one-selection-type) |
| The rendered file is the fold in the canonical order | The pre-release v3 builds wrote the validated parse, keys in the schema's order | The fold rendered in the one canonical order (sections in execution order, keys as the schema declares them, the entries of every keyed list by identity; `branches`, `bypass_actors`, `reviewers`, and scalar lists as written), byte for byte what `mergeSettings` returns as `yaml` | No error: a committed rendered file reorders once; [section 24](#24-the-rendered-file-is-the-fold-in-the-canonical-order) |
| Every live read is parsed at the port | A body off the documented shape flowed into the comparison (a null Actions body read as drift on every key) | Every read fails loudly naming the endpoint and the field | The section fails with `returned a body outside the documented shape`; [section 25](#25-every-live-read-is-parsed-at-the-port) |
| The snapshot file is canonical and undated | The second header line read `# Snapshot of owner/name taken <instant>`; list entries sat in the order GitHub listed them | No dated line: the run's notice and the step summary say `snapshot taken <instant>`; the document renders in the canonical order the rendered file shares | No error: a committed snapshot reorders once and loses its dated second line; a script reading the instant from the file reads the run's notice instead; [section 26](#26-the-snapshot-file-is-canonical-and-undated) |
| Library: one problem code for a malformed document | The pre-release v3 builds had `settings-unknown-directives` and `settings-unknown-sections`, one standalone stop each | Both are lines of `settings-malformed-sections`, beside the section issues | A `switch` on `Problem.code` naming a deleted code fails to compile; [section 27](#27-library-one-problem-code-for-a-malformed-document) |
| `_layering` takes `replace`, `shallow`, or `deep`, and every list section layers by key | No layering; the pre-release v3 builds took `merge` or `replace`, and only `labels` and `rulesets` unioned | `deep` (default) unions by the section's key and merges a same-key pair field by field; `shallow` unions and swaps the pair; `replace` lets the higher list win; all sixteen knobbed sections union | `_layering: merge` and `layering: merge` fail as unknown values, naming the three; a fourteen-section overlay that relied on silent replacement now unions; [section 28](#28-_layering-takes-replace-shallow-or-deep) |
| `mode: merge` is `mode: render` | No render mode; the pre-release v3 builds spelled it `mode: merge`, `merged-file`, CLI `merge`, result `merged` | `mode: render`, `rendered-file`, CLI `render`, result `rendered`; five problem codes and four library flow exports carry the render spelling | `mode: merge` fails as an unsupported mode value; a `merged-file` input draws the runner's unknown-input warning; [section 29](#29-mode-merge-is-mode-render) |
| `environments`, `branches`, and `workflows` layer by key | A higher list replaced the lower one whole | Union by key under `deep`: environment names case-insensitively, branch names verbatim, workflow paths as GitHub lists them; each accepts a `{_layering, entries}` wrapper; an environment's nested lists union by their own keys | No error: a higher layer that meant to replace now unions; write `_layering: replace` on the wrapper; [section 30](#30-environments-branches-and-workflows-layer-by-key) |
| A higher layer's `null` wins and means empty on GitHub; `_remove: true` drops a keyed entry | In v2's defaults merge a whole-section `null` opted out of the defaults' section while a nested `null` survived as a value; the pre-release fold read a `null` as "delete the lower key" | `null` is written as the value, the empty or off state; a key with no empty state refuses it; a whole-section `null` only on `pages` and `interaction_limits`; `_remove: true` drops one lower entry and is consumed | Validation fails naming the legal values; a `null` written to mean "stop managing this" empties the setting on GitHub instead; [section 31](#31-null-wins-and-means-empty-and-_remove-drops-an-entry) |
| File-wide `_undeclared` and the run input `undeclared` | The policy lived on each section's wrapper only | A top-level `_undeclared: keep` or `delete` sets every knobbed section of the file; the `undeclared` input sets the run; a wrapper beats the file, the file beats the input, the input beats the section default | No error: a top-level `_undeclared: delete` that v2 dropped as a note now deletes undeclared entries on the first apply; a file that set every wrapper by hand keeps working; a file-wide `delete` also deletes undeclared deployment protection rules; [section 32](#32-file-wide-_undeclared-and-the-undeclared-input) |
| Apply refuses to write over a live value the file omits | Check compared declared keys only; the ruleset and environment PUTs wrote the whole object, so an omitted live value was deleted while check said clean | Check reports the omitted value as drift; apply refuses that entry's PUT and fails the section | The section fails with `not applied - the update would remove a live value the settings file omits`; declare the key, or declare it empty; [section 33](#33-apply-refuses-over-omitted-live-values) |
| Every file-only check runs before the first write | A duplicate in a section the `sections` input excluded never ran; one in a selected section threw mid-run after earlier sections wrote | Every section's file-only checks run at validation, selected or not, before any request | A file that applied with `sections: repository` beside a broken `labels` fails with exit 1 and zero requests; a custom list module built with the library implements `validate`; [section 34](#34-file-only-checks-run-before-the-first-write) |
| Library: `plan()` takes only validator-minted input | In the pre-release v3 builds `labels.plan(ctx, [{name: "bug"}, {name: "Bug"}])` compiled, so a caller could skip the file-only checks | The parameter is `ValidatedInput<K>`, minted by `validateSettings`, `mergeSettings`, or `snapshotRepository` | A raw list fails to compile, naming `ValidatedBrand`; [section 35](#35-library-plan-takes-only-validator-minted-input) |
| Labels: color and description are checked at parse | `color: red` reached GitHub as a 422 and never converged; a 150-character description 422ed | `color` is six hex digits, the `#` optional; `description` is at most 100 characters | Validation fails naming the entry and the rule; [section 36](#36-labels-colors-and-descriptions) |
| Repository: GET-only keys, commit-message pairs, topics, and security sub-keys | `has_downloads: false` drifted on every run; an illegal squash pair or a bad topic 422ed at apply | Refused at parse: a GET-only key (`has_downloads`, `has_pages`, `custom_properties`, ids, urls, counts), an unknown `security_and_analysis` sub-key, a commit message without its title or in an illegal squash pair, a malformed or empty topic, more than 20 topics | Validation fails naming the key and the fix; [section 37](#37-repository-get-only-keys-commit-pairs-topics-and-security-sub-keys) |
| Pages: GET-only site fields and the source path | `custom_404: true` rode the PUT, was dropped, and drifted forever; `source.path: /src` 422ed | `url`, `html_url`, `status`, `custom_404`, `protected_domain_state`, `pending_domain_unverified_at`, and `https_certificate` are refused; `source.path` is `/` or `/docs` | Validation fails naming the key; [section 38](#38-pages-get-only-fields-and-the-source-path) |
| Actions: reported-only fields, a closed `selected_actions`, enums and bounds | `maximum_allowed_days: 400` was re-PUT on every run; a misspelled `selected_actions` key was re-PUT silently forever | `selected_actions_url`, `artifact_and_log_retention.maximum_allowed_days`, and `oidc_customization_sub.sub_claim_prefix` are refused; `selected_actions` is closed to its three keys and typed; `approval_policy` is an enum; claim keys match `^[A-Za-z0-9_]+$` and are unique; retention days and cache limits are positive integers; `include_claim_keys` beside `use_default: true` is refused; `sha_pinning_required` is a known boolean | Validation fails naming the key and the fix; [section 39](#39-actions-fields-that-could-never-converge) |
| Code scanning and code quality setup: GET-only keys, languages, the runner pair | `schedule: weekly` and a `runner_label` under `runner_type: standard` each drifted forever; `languages: [javascript]` never matched the pair GitHub reports | `schedule` and `updated_at` are refused; languages are spelled as the PATCH takes them (`javascript-typescript`, no `rust`); a string `runner_label` goes only with `runner_type: labeled`, which requires one | Validation fails naming the key and the spelling to write; a key the GET never echoes earns the never-converges note; [section 40](#40-setup-sections-get-only-keys-languages-and-the-runner-pair) |
| Branches: protection shapes the file alone shows wrong | A protection copied from GitHub's GET 422ed on its `{url, enabled}` wrappers, and its other GET-only keys (`url`, `enforcement_level`) drifted forever; `required_status_checks` without `strict` 422ed; `required_approving_review_count: 7` 422ed | Refused at parse: a GET-only key at any depth (`name`, `enabled`, `enforcement_level`, `url`, `*_url`); `required_status_checks` needs `strict` and `contexts` or `checks`; the count is 0 to 6; a `checks` item takes only `context` and `app_id`; a scalar where the two mappings go | Validation fails naming the key and the fix; a live all-empty `restrictions` holder the file omits is now drift and a loud PUT, not silence; [section 41](#41-branches-protection-shapes) |
| Collaborators and teams: permissions and team slugs | `permission: write` converged on an existing Write grant and 422ed on a new one; `teams[].name: Core Team` probed `/teams/Core%20Team`, 404ed, and check said "no access" | `permission` refuses `read`, `write`, a mis-cased standard permission, an empty value, and whitespace at either end; `teams[].name` is the slug alphabet `[A-Za-z0-9._-]` with at least one letter or digit | Validation fails suggesting a form that parses (`push`, `admin`, `core-team`); [section 42](#42-collaborators-and-teams-permissions-and-slugs) |
| Secret and variable names, and the variable value cap | `name: deploy-token` parsed; the sealed PUT 422ed mid-apply; a variable value over 48 KB 422ed | Names are ASCII letters, digits, and underscores, no leading digit, no `GITHUB_` prefix in any case; a variable value is at most 49152 bytes of UTF-8 | Validation fails naming the entry's path; [section 43](#43-secret-and-variable-names-and-the-value-cap) |
| Check-suite preferences: `app_id` | `app_id: 0` and a negative id were PATCHed on every run; a repeated id was collapsed by GitHub with nothing reading it back | `app_id` is a positive integer and appears once | Validation fails naming the entries; [section 44](#44-check-suite-preferences-app_id) |
| Interaction limits: enums, the cap range, and a closed section | `expiry: two_weeks` or `expires_at` 422ed on every apply and never converged | `limit` and `expiry` are GitHub's enums; `max_open_pull_requests` is 1 to 1000; the section takes only `limit`, `expiry`, `pull_request_creation_cap`, and `pull_request_creation_bypass` | Validation fails naming the key and the rule; [section 45](#45-interaction-limits-enums-the-cap-and-the-closed-section) |
| Deploy keys: a public SSH key only | Any two-field string, a pasted private key included, planned a create and reached the request layer before the 422 | `key` is `<algorithm> <base64> [comment]` with the algorithm one of GitHub's seven; `ssh-dss` is refused naming the date GitHub dropped DSA; a private key is refused without being echoed | Validation fails naming the entry by title; [section 46](#46-deploy-keys-a-public-ssh-key-only) |
| Webhooks: events, content type, `insecure_ssl`, and the url | `events: [pushes]`, `content_type: JSON`, `insecure_ssl: 2`, or `url: hooks.example.com/ci` 422ed at apply after other sections wrote | Events from GitHub's repository list (or `*`); `json` or `form`; `"0"`, `"1"`, `0`, or `1`; an absolute URL | Validation fails naming the entry and the accepted values; [section 47](#47-webhooks-events-content-type-insecure_ssl-and-the-url) |
| Secret scanning patterns must compile | `pattern: "([a-z"` parsed; check saw a missing pattern; apply hit the bulk-create 422 | `pattern`, `start_delimiter`, `end_delimiter`, `must_match`, and `must_not_match` pass a syntax check that first translates the PCRE-only forms Hyperscan accepts | Validation fails naming the field and the reason; a snapshot leaves out a live pattern the check cannot verify, with a note; [section 48](#48-secret-scanning-patterns-must-compile) |
| Rulesets: enforcement, bypass actors, ref-name tokens, rule parameters | `enforcement: enabled`, `include: ["~all"]`, a Team actor without `actor_id`, or `grouping_strategy: allgreen` 422ed after earlier sections wrote | `enforcement` is `active`, `evaluate`, or `disabled`; bypass actors are typed from the spec; a `~` value is `~ALL` or `~DEFAULT_BRANCH`; the 23 known rule types carry typed parameters, and an unknown type passes through | Validation fails naming the entry, key, and accepted values; [section 49](#49-rulesets-enforcement-actors-tokens-and-parameters) |
| Milestones: `due_on` is a day | `due_on: 2026-01-15` compared unequal to the `08:00:00Z` GitHub echoes and drifted forever; `T00:00:00Z` stored the previous day; `null` and offset timestamps passed through | A calendar day `YYYY-MM-DD`, or a UTC timestamp read for its day; written as noon UTC; `null` and offsets are refused | Validation fails naming the day form; a snapshot writes the day; [section 50](#50-milestones-due_on-is-a-day) |
| Environments: declared-off protection converges, and GitHub's refusals move to parse | `wait_timer: 0`, `prevent_self_review: false`, `reviewers: []` on an unprotected environment drifted forever; a two-false `deployment_branch_policy` 422ed | The disabled values are the baseline, so they converge; refused at parse: `wait_timer` outside 0 to 43200 or fractional, more than 6 reviewers, both policy flags true or both false, `prevent_self_review: true` without reviewers, a policy `type` outside `branch` and `tag` | Validation fails naming the fix (`deployment_branch_policy: null` spells "any branch"); [section 51](#51-environments-disabled-defaults-and-the-refusals) |
| Autolinks: charset, the `<num>` placeholder, overlapping prefixes, the live flag | An empty or bad-charset `key_prefix` or a template without `<num>` 422ed; a recreate sent `is_alphanumeric: true` over a live `false` | Refused at parse: an empty `key_prefix`, a character outside GitHub's set, a template without `<num>`, two prefixes where one begins the other; a recreate keeps the live flag | Validation fails naming the key and an example value; [section 52](#52-autolinks-charset-placeholder-and-overlapping-prefixes) |
| YAML merge keys resolve | `<<: *base` survived as a literal `<<` field and rode into the create payload | `<<` merges the aliased mapping, as the Probot Settings app's parser did | No error: an entry that carried a literal `<<` key now gets the merged fields instead; [section 53](#53-yaml-merge-keys-resolve) |
| Library: a parsed ruleset entry carries `target` and `enforcement` | `SettingsFile` left both keys optional on a ruleset entry, so `{ rulesets: [{ name: "main" }] }` typed as one | Both keys are required on the parsed entry, the one `SettingsFile` and `sectionModule("rulesets").plan` take; the settings file still omits either and the parse fills `branch` and `active` | The literal fails to compile (`TS2739`, naming the missing keys); parse the document through `validateSettings`, or declare both keys; [section 54](#54-library-a-parsed-ruleset-entry-carries-target-and-enforcement) |
| Branches: a `restrictions` block carries `users` and `teams` | `restrictions: {}`, or a block naming only `apps` or only `users`, parsed clean and the protection PUT 422ed at apply | Both lists are required on the block (`[]` when none) and `apps` stays optional; `restrictions: null` lifts the push restriction; `dismissal_restrictions: {}` and `bypass_pull_request_allowances: {}` stay legal | Validation fails naming the two lists and the `null` form, with zero requests; [section 55](#55-branches-a-restrictions-block-carries-users-and-teams) |
| Library: `plan()` and `snapshot()` resolve to a `Result` | `await labels.plan(ctx, declared)` resolved to the plan and rejected on a denied read, a duplicated live pair, or a live body the section could not reconcile | Both resolve to a neverthrow `Result`: the plan or snapshot on `Ok`, a `SectionFailure` on `Err`; a rejection is left for the wrong-context refusal, a client that throws instead of answering, and `BUG:` invariants | Reading `.ops` or `.value` off the awaited value fails to compile (`TS2339`); `rejects.toThrow` assertions on a section call pass a resolved promise through; [section 56](#56-library-plan-and-snapshot-resolve-to-a-result) |
| A closed section's unrecognized key names the entry by index | `collaborators[octocat]: declares "permision", which this section does not recognize ...` | `collaborators[0] (username "octocat"): declares "permision", which this section does not recognize ...`; under a wrapper, `collaborators.entries[0] (username "octocat")` | Anything that greps the bracket for the entry's identity needs the new spelling; [section 57](#57-a-closed-sections-unrecognized-key-names-the-entry-by-index) |
| Library: `GitHubClient` and `ArtifactUploader` answer, never reject | `tryRequest()` and `tryGraphql()` rejected for a request with no HTTP answer (not sent, the transport failed, a GraphQL body off the wire contract); `upload()` rejected to report a failed upload | Both port methods resolve to a `ClientAnswer` whose third arm is `{ failed }`, the whole line; `upload()` resolves to `{ uploaded: true }` or `{ failed }`. A test double that still throws is read as a broken contract: the failure is reported, never classified | A double returning `void` from `upload()`, or a caller reading `.data` off a `ClientAnswer` without narrowing `failed`, fails to compile; [section 58](#58-library-githubclient-and-artifactuploader-answer-never-reject) |

## 1. The defaults-file fallback

Blast radius first: with `repos: "*"`, every discovered repository that has no `.github/settings.yml` now receives the whole defaults document, where v2 skipped it. A defaults file with `labels: {_undeclared: delete, entries: [...]}` deletes labels on all of them.

1. Run the fleet workflow with `mode: check` on v3 and read which targets say `applying the defaults file: the repository has no .github/settings.yml on its default branch`.
2. For each, decide: give the repository its own file, or accept the defaults as its complete settings.
3. Targets that used a partial file as an overlay on the defaults now need the full document. Build it with [layering](../operate/layering.md): the old defaults file is the lowest layer, the old target file the highest, and `rendered-file` is the document the target applies.

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

The underscore marks the action's directives: `_undeclared` (live axis), `_layering` (merge time), and `_remove` (merge time, on one keyed entry), and nothing else ([section 16](#16-underscore-keys-are-directives-never-notes)). The [undeclared policy](../reference/undeclared-policy.md) page owns the knob.

## 3. Layering only in mode: render

If a v2 setup relied on the defaults merge for anything beyond "no file, use the defaults", it becomes a two-step workflow: a `mode: render` step folds the layers into `rendered-file`, and the apply or check step runs that file. The [layering guide](../operate/layering.md) has the rules, the worked example, and the workflow.

The fold is not the v2 merge. Three differences to audit when you rebuild an old overlay:

| In v2's defaults merge | In a `mode: render` fold |
|---|---|
| Lists always replaced: a target's `labels` replaced the defaults' | Every list section unions by its key under the default `layering: deep` ([section 28](#28-_layering-takes-replace-shallow-or-deep)); set `layering: replace` (or `_layering: replace` on the section) to keep the old replacement |
| A nested `null` in the target survived as a value (`pages.cname: null` removed the domain) | The same: `null` wins and is written as the value, the empty or off state on GitHub. A key with no empty state refuses it at validation ([section 31](#31-null-wins-and-means-empty-and-_remove-drops-an-entry)) |
| A `null` section in the target opted out of the defaults' section | Only `pages: null` and `interaction_limits: null` are legal, and they turn the site or the limit off rather than opting out; any other whole-section `null` fails validation. To drop a lower entry, write `_remove: true` on it |

## 4. Commas and newlines in a settings-file path

`mode: render` takes its layers as a newline- or comma-separated list in `settings-file`, and the separators are the same in every mode. So no settings file can be named with a comma or a newline in its path any more. v2 read `settings-file: settings,prod.yml` as one file; v3 apply refuses it:

```text
the "settings-file" input is "settings,prod.yml", which contains a list separator: apply mode reads exactly one settings file, and only mode: render takes a newline- or comma-separated list. Name one file, or set mode: render to fold the list into one document
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
| `skipped-sections` | Apply, check, snapshot; the pre-release `merge` mode set it to `""` | Every mode, `""` when none |
| `repos-result` | Multi-repo runs and `snapshot-dir` only; unset elsewhere | Every mode; `{}` for a run over one repository or a render |

A step that used an unset `repos-result` to tell a single-repo run from a fleet run must test `repos-result == '{}'` instead. The exit rule did not move: 1 exactly when `result` is `failed`, or `drift` in `mode: check`.

## 7. One --json envelope

Every `gsac` subcommand prints one object under `--json`, `result` first:

| Command | v2 | v3 |
|---|---|---|
| `check`, `apply`, `render`, `snapshot` | `{"skipped-sections": "", "result": "clean"}` | `{"result": "clean", "skipped-sections": [], "repos-result": {}}`: the list is a list, the map a map |
| `validate` | `{"file": ..., "valid": true, "sections": [...]}` | `{"result": "valid", "file": ..., "sections": [...]}` |
| `permissions` | `{"labels": "<grant>", ...}` | `{"result": "valid", "file": ..., "grant": {"labels": "<grant>", ...}}` |
| `init` | `{"file", "repository", "result", "skippedSections", "failedSections", "grant"}` | `{"result", "file", "repository", "skipped-sections", "grant"}`; `failedSections` is gone, since a failed section now fails init |
| any failure | `{"file", "valid": false, "problem"}` or `{"result": "failed", "problem"}`; a mode command's fatal problem and a parser error printed no `problem` | `{"result": "failed", "file"?: ..., "problem": ...}`; a mode command that fails before any target runs prints `problem` beside its three outputs, a parser error or a crash prints it alone. A target that fails while running has no `problem`: its errors are on stderr and its row in `repos-result` |

## 8. A failed snapshot section fails the target

Every mode now applies one crash rule: a section whose read throws (an API error) fails its target, `result` is `failed`, the run exits 1, and no snapshot file is written for that target. v2 wrote the file without the section and reported `partial` with exit 0.

A value the section's own schema rejects already failed the target in v2; that case did not move. A denial under `on-missing-permission: warn` still skips the section and still reports `partial`.

`gsac init` follows: a failed section refuses to write the settings file, with the errors above naming the section and the fix.

## 9. Library: the public entry and the v3 names

For `@vivswan/github-settings-as-code` consumers. The old form is the pre-release v3 builds' (v2.0.0's package was private and exported nothing), as in sections 24 and 29. Before and after, one program:

```text
pre-release   import { GithubApi, checkRepository, validateSettings, runForRepo } from "@vivswan/github-settings-as-code";
              const { settings, warnings } = validateSettings(doc)._unsafeUnwrap();
              await checkRepository(client, { repo, settings, onMissingPermission: "fail", sections: SectionSelection.ALL });

v3            import { GitHubApi, checkRepository, validateSettings } from "@vivswan/github-settings-as-code";
              import { runForRepo } from "@vivswan/github-settings-as-code/internal";
              const { settings, log } = validateSettings(doc)._unsafeUnwrap();
              await checkRepository(client, repo, settings);
```

The package now has two entries, and one naming family per layer:

| | pre-release | v3 |
|---|---|---|
| The entry | One, 192 names, all pinned | The public entry: the names the [library page](../reference/library.md#the-api-by-group) tables document, under semver. The internal entry, `@vivswan/github-settings-as-code/internal`: everything else the action, the CLI, and the tests import, with no promise |
| The verbs | `checkRepository`, `applyRepository`, `snapshotRepository`, `snapshotRepositories`, `validateSettings`, plus `foldLayers` and `mergeLayers` for a merge | The same five, plus `mergeSettings`; every verb takes its inputs positionally and one options object of the same knobs (`sections`, `onMissingPermission`, `io`, ...), each defaulted as the action's input |
| The reports | `RepoRunReport` (`log`), `SnapshotReport` (`log`), `validateSettings` (`warnings: string[]`) | `CheckReport`, `ApplyReport`, `SnapshotReport`, `MergeReport`, `ValidateReport`: one `log: CollectedLine[]` on every report, the annotation level kept beside each line |

Every rename, old to new. An old name fails to compile, naming the missing export; the new name is in the public entry unless the row says the internal entry:

| pre-release | v3 |
|---|---|
| `GithubApi` | `GitHubApi` |
| `GithubClient` | `GitHubClient` |
| `MissingPermissionPolicy` | `OnMissingPermission` (the input's name) |
| `checkRepository(client, { repo, settings, onMissingPermission, sections }, io?)` | `checkRepository(client, repo, settings, { onMissingPermission?, sections?, io?, secretEnv? })`; the document's `secretSource` is `validateSettings`'s knob |
| `applyRepository(client, { repo, settings, onMissingPermission, sections }, io?)` | `applyRepository(client, repo, settings, { onMissingPermission?, sections?, io?, secretEnv? })` |
| `RepoRunReport` | `CheckReport`, `ApplyReport` |
| `RepoRunOptions` | `CheckOptions`, `ApplyOptions` (the knobs alone); the engine's `RepoRunOptions` is in the internal entry |
| `snapshotRepository(client, repo, { sections?, onMissingPermission?, io? })` | Unchanged call; its options type is `SnapshotOptions` |
| `SnapshotLibraryOptions` | `SnapshotOptions` |
| `validateSettings(doc, { source?, sections?: ReadonlySet<SectionKey> })` returning `{ settings, warnings: string[] }` | `validateSettings(doc, { source?, sections?: SectionSelection, io? })` returning `{ settings, log: CollectedLine[] }` (`ValidateOptions`, `ValidateReport`) |
| `foldLayers(layers, sourceLabel, layering, io)` | `mergeSettings(layers, { source?, layering?, io? })` returning `{ settings, notices, yaml, log }` (`MergeOptions`, `MergeReport`); `foldLayers` itself is in the internal entry |
| `mergeLayers`, `canonicalDocument`, `renderCanonicalYaml`, `renderSnapshotYaml` | The internal entry; `MergeReport.yaml` and `SnapshotReport.yaml` carry the rendered file |
| `validateSettingsDoc` | The internal entry: the engine's boundary, which prints its warnings to an `Io`; `validateSettings` collects them into `log` |
| `runForRepo`, `preflightProbe`, `skippedSectionKeys`, `RepoRunResult`, `RepoResult` | The internal entry |
| `SnapshotResult`, `RenderableSnapshot`, `SNAPSHOT_SCHEMA_URL` | The internal entry; `SnapshotReport.yaml` already carries the schema pin in its header |
| `REPO_RESULTS`, `SNAPSHOT_RESULTS`, `MERGE_RESULT` | `RUN_RESULTS` (worst first: `failed`, `drift`, `partial`, `skipped`, `applied`, `clean`, `snapshot`, `rendered`) |
| `SnapshotRunResult` | `RunOutcome` |
| `worstOf(results, check)`, with `check` picking the floor of an empty list | `worstOf(results)`; an empty list throws, since every run concludes over at least one target |
| `INPUT_DECLS`, `InputDecl`, `InputName`, `MODES`, `Mode`, `FILTER_INPUTS`, `SNAPSHOT_INPUTS`, `SNAPSHOT_ONLY_INPUTS`, `SNAPSHOT_REJECTED_INPUTS`, `parseSnapshotFileConfig`, `SnapshotFileConfig`, `DEFAULT_PRIVATE_REPOS`, `DEFAULT_SETTINGS_FILE` | The internal entry |
| `MERGE_INPUTS`, `MERGE_ONLY_INPUTS`, `MERGE_REJECTED_INPUTS` | `RENDER_INPUTS`, `RENDER_ONLY_INPUTS`, `RENDER_REJECTED_INPUTS` in the internal entry ([section 29](#29-mode-merge-is-mode-render)) |
| `resolveTargets`, `ResolvedTargets`, `TargetsConfig`, `RunFlowConfig` | The internal entry |
| `capturingIo`, `planRedaction`, `publicDetail`, `toPublicView`, `PublicTargetView`, `PRIVATE_REPOS_POLICIES`, `PrivateReposPolicy` | The internal entry |
| `getRepoFile`, `createVisibilityResolver`, `RepoVisibility`, `SECRET_RESPONSE_WITHHELD`, `SECRET_TRANSPORT_WITHHELD`, `TraceIo` | The internal entry |
| `applyMarkerInjection`, `PRIVATE_REPORT_CHANNELS`, `ISSUE_TITLE`, `MARKER_LABEL`, `MARKER_LABEL_CONFIG` | The internal entry |
| `AFFILIATIONS`, `ARCHIVED_FILTERS`, `FORKS_FILTERS`, `VISIBILITY_FILTERS`, `DiscoveryProblem` | The internal entry |
| `stripNulls`, `describeOptOut`, `OptOutNotice` | Removed: the fold reads no `null` as a marker ([section 31](#31-null-wins-and-means-empty-and-_remove-drops-an-entry)); `describeRemoval` and `RemovalNotice` describe a `_remove` |
| `quoteList`, `RERUN_ADVICE`, `ProblemOf`, `SettingsProblem`, `LayerProblem`, `CentralFileProblem`, `TopLevelShape` | The internal entry |
| `DOCUMENT_DIRECTIVE_KEYS`, `PROBOT_PARITY_KEYS`, `UndeclaredPolicy`, `UndeclaredPolicyList`, `MustBeNever` | The internal entry; `UNDECLARED_POLICY_SECTIONS` and `UndeclaredPolicySection` stay public |
| `denialPosture`, `readGating`, `writeGatedReads`, `sectionOperations`, `SectionMeta`, `KeyedListLayering`, `grantFor`, `PatResource`, `SectionPermission` | The internal entry |
| `Justification`, `PlannedOpBase`, `Tolerance`, `Unverifiable` | The internal entry |
| `concludeSnapshot` set `repos-result` only in the dir form; `concludeMerge` set no `repos-result` | Every conclude sets the three outputs |
| `FinishedSnapshot` carried `view` / `views`: each target already projected into a `SnapshotTargetView` | `FinishedSnapshot` carries `target` / `targets`: each a `TargetOutcome` whose `detail` is sealed for a hidden target; `concludeSnapshot` opens it through `publicDetail` / `toPublicView` |
| `SnapshotTargetView` (snapshot's own redacted projection) | Removed; the shared redaction-safe projection is `PublicTargetView` in the internal entry, which now carries the snapshot `file` |

## 10. One redacted label in every mode

Every hidden target is labelled `private repository #N`, numbered in target order, whatever the mode. A run over one repository (`repository:` with `private-repos: redact`, or `snapshot-file`) is a fleet of one, so its label is `private repository #1`:

```text
v2: warning: private repository: drift - repository. details hidden: ...
v3: warning: private repository #1: drift - repository. details hidden: ...
```

The `artifact` report channel heads that run's report `<!-- private repository #1 -->` for the same reason. A filter matching the bare label needs the `#1`.

Snapshot targets ride the same seal now: a private target's notes, file path, and section detail close sealed exactly as a multi-repo apply target's do, and a private target that fails gets the same one-line annotation (`private repository #N: failed - <sections>`) a fleet target gets. The [private repositories guide](../operate/private-repositories.md#one-seal-every-mode) owns the rule.

## 11. Two live items under one identity fail the section

v2 picked one silently. The factory sections refused only a claimed pair; milestones, rulesets, webhooks, custom properties, secret scanning patterns, environment secrets and variables kept the last one listed; workflows matched the first; teams acted on both.

v3 refuses every live list the same way, whether or not the settings file declares the pair: the list sections, the nested environment lists, and the seven reads that had no guard before. Those seven are the teams listing, the workflows listing, the environment listing, the pinned environments, the protected-branch listing, the GraphQL protection rules, and the protection-rule Apps an environment can enable.

Each pair is named the same way, the key first and the server id beside it when one exists:

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

v2 dropped any unknown top-level key starting with `_` as a private note, while rejecting the same key inside a section's `{entries}` wrapper.

v3 has one rule at the top level and on the wrappers: the underscore belongs to the three directives, and any other underscore key there fails validation before any section runs. Each directive has its place: `_layering` at the top level or on a list section's wrapper, `_undeclared` at the top level or on a knobbed wrapper ([section 32](#32-file-wide-_undeclared-and-the-undeclared-input)), and `_remove: true` on a keyed list entry ([section 31](#31-null-wins-and-means-empty-and-_remove-drops-an-entry)).

A directive out of its place is refused like any unknown key: `{name: bug, _remove: true}` drops an entry, while a top-level `_remove: true` or `labels: {_remove: true, entries: []}` fails validation. A removal also needs a fold to act in: in a single document (a one-file apply or check) it fails validation naming its site, since there is no lower layer to remove from.

```yaml settings
# owner: platform-team, see runbook RB-112
labels:
  - name: bug
    color: "d73a4a"
```

A v2 file with `_owner: platform-team` at its top level now fails with this line in the collected list (abbreviated):

```text
settings.yml has malformed section entries: unknown underscore key: _owner. The underscore marks this action's directives, "_layering" (...) and "_undeclared" (...), and nothing else; there are no private-note keys. Remove the key, or keep the note as a YAML comment (...)
```

A `sections` allowlist does not soften it (an unknown plain section outside the allowlist still only warns). The reason is the loud-failure promise: a misspelled `_layerin: replace` dropped as a note would merge a layer its author meant to replace.

Move each note into a YAML comment; the [layering guide](../operate/layering.md#four-knobs) states the rule beside the directives.

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
| The snapshot staged through `<path>.tmp` and renamed; the rendered file and init wrote in place, each with its own try/catch | `writeReplacing(path, text): Result<void, string>` stages and renames for all three |
| `SettingsFileRole`: `settings-file`, `defaults-file`, `layer` | plus `central-file`, the repos-dir file a multi-repo target is read from |


## 24. The rendered file is the fold in the canonical order

The document `mode: render` writes, and `mergeSettings` returns as `yaml`, is the fold in one canonical order:

```text
pre-release   repository:                  # zod's order: the schema declares enable_vulnerability_alerts first
                enable_vulnerability_alerts: true
                has_issues: true

v3            repository:                  # the canonical order: declared keys as the schema lists them, then the rest by code point
                enable_vulnerability_alerts: true
                has_issues: true
```

The written file is the fold in the canonical order every rendered document shares ([section 26](#26-the-snapshot-file-is-canonical-and-undated) names the rules); validation judges the fold and never re-serializes it. A rendered file committed under a pre-release build reorders once.

Reordering keys, or the entries of a sorted list, in a layer changes nothing in the file. `branches`, the pinned environments, `bypass_actors`, `reviewers`, and scalar lists keep their written order, since it is content.

## 25. Every live read is parsed at the port

Every GET and GraphQL query a section issues now passes through one parser before the section sees the body, so a response off the documented shape fails the section instead of flowing into a comparison.

v2 parsed some reads (the lists, the toggles) and compared others raw: a `null` Actions permissions body read as drift on every declared key and re-applied the PUT on every run. A pinned environment without a position was reported by its own message.

```text
actions: GET /repos/{owner}/{repo}/actions/permissions returned a body outside the documented shape - (body): Invalid input: expected object, received null. Check the "api-version" input against the GitHub REST docs for this endpoint
```

A GraphQL read says `GRAPHQL <operation>` in place of the method and path and points at the GraphQL reference. Where a read names its resource, the denial and the shape failure both carry it (`GET .../deployment_protection_rules (environment "production"): 403 ...`). The `api-version` advice is the fix in every case: the shapes are GitHub's documented ones.

Two smaller moves ride along:

- A section that reads anything must declare `snapshot()`; only the write-only `check_suite_preferences` reports `unsupported`, and the `snapshot is not implemented for this section yet` note is gone.
- The organization-only sections (`teams`, `custom_properties`) are probed for the owner kind by the registry, ahead of their own plan and snapshot. The personal-account note is unchanged. A settings-file mistake in those sections (two entries naming one team) is validation's, before any request ([section 34](#34-file-only-checks-run-before-the-first-write)).

## 26. The snapshot file is canonical and undated

The file `mode: snapshot`, `gsac init`, and `snapshotRepository` write carries no timestamp, and its document renders in the one canonical order the rendered file shares, so a snapshot of an unchanged repository is byte for byte the last one and a diff between two snapshots shows only what changed on GitHub.

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

The canonical order, the same for the snapshot and the rendered file:

| Node | Order |
|---|---|
| The top level | The sections in the order the action applies them (`SECTION_KEYS`), then `_layering`, then any other key by code point |
| A mapping the schema declares | Its properties as the schema (and the published JSON schema) lists them; keys the schema does not declare follow by code point (an integer-like key such as `"10"` leads, in numeric order, as JavaScript enumerates it) |
| A mapping the schema leaves open (a rule's `parameters`, a bypass actor) | Keys by code point |
| A list of entries with an identity (labels by `name`, webhooks by `config.url`, milestones by `title`, collaborators by `username`, `rules` by `type`, and so on) | Sorted by the identity, ties by the entry's canonical JSON |
| `environments` | The `pinned: true` entries first in their written order, since that order is the pin rank; the rest by `name` |
| `branches` | As written: GitHub applies overlapping wildcard rules in creation order, and apply creates them in file order; the fold unions them by name in that order |
| Any other list (`topics`, `include` patterns, `bypass_actors`, `reviewers`) | As written |
| Each section's header notes | By code point within the section |

The snapshot's notes are sorted the same way, in the file header and in the annotations. A snapshot committed under v2 reorders once.

## 27. Library: one problem code for a malformed document

For `@vivswan/github-settings-as-code` consumers. The left column is the pre-release v3 builds' shape, as in sections 24 and 29.

| Pre-release | v3 |
|---|---|
| `settings-unknown-directives`: an unknown underscore key stopped the run alone | A line of `settings-malformed-sections`: `unknown underscore key: _owner. ...` |
| `settings-unknown-sections`: an unknown section stopped the run alone | A line of the same problem: `unknown top-level section: stickers (known: ...)` |

A `switch` on `Problem.code` that names either deleted code fails to compile. Drop the case; the lines are in the `issues` of `settings-malformed-sections`, before the section issues: the underscore line first, then the unknown-section line.

## 28. _layering takes replace, shallow, or deep

Two layers, one `bug` label declared in both. What the rendered file holds under each `_layering` value:

```text
fleet.yml (lower)         labels:
                            - name: Bug
                              color: d73a4a
                            - name: docs
                              color: "0075ca"

repo.yml (higher)         labels:
                            - name: bug
                              description: mine

layering: replace         labels:                      # the higher list wins
                            _undeclared: delete        # the section default, resolved onto the rendered wrapper
                            entries:
                              - name: bug
                                description: mine

layering: shallow         labels:                      # union by name (case-folded); the same-name entry is swapped
                            _undeclared: delete
                            entries:
                              - name: bug
                                description: mine
                              - name: docs
                                color: "0075ca"

layering: deep (default)  labels:                      # union by name; the same-name pair merges field by field
                            _undeclared: delete
                            entries:
                              - name: bug
                                color: d73a4a
                                description: mine
                              - name: docs
                                color: "0075ca"
```

Every list section folds this way, by the key its planner matches on: labels, collaborators, teams, and environments case-folded; the secret and variable families uppercased; workflow paths as GitHub lists them; the rest verbatim (a ruleset's `rules` by `type` inside a deep pair). The pre-release builds unioned labels and rulesets only and replaced the other seventeen silently, the three plain lists of [section 30](#30-environments-branches-and-workflows-layer-by-key) among them.

The value `merge` is gone. `labels: {_layering: merge, entries: [...]}` fails with `labels._layering must be one of "replace", "shallow", "deep"; got a string that is none of them`, and the `layering` input refuses it too, naming the same three values.

Fix: write `deep` where a layer said `merge`, and `_layering: replace` on any list section a higher layer meant to replace whole. Under `shallow` and `deep` an empty higher list adds nothing; clearing a list takes `replace` with an empty list. The [layering guide](../operate/layering.md#four-knobs) owns the rules.

## 29. mode: merge is mode: render

```text
pre-release   with:
                mode: merge
                settings-file: |
                  fleet.yml
                  repo.yml
                merged-file: rendered.yml

v3            with:
                mode: render
                settings-file: |
                  fleet.yml
                  repo.yml
                rendered-file: rendered.yml
```

| Face | Pre-release | v3 |
|---|---|---|
| The mode | `mode: merge` | `mode: render` |
| The output input | `merged-file` | `rendered-file` |
| The CLI subcommand | `gsac merge` | `gsac render` |
| The result word (`result` output, `--json`, `RUN_RESULTS`) | `merged` | `rendered` |
| Problem codes | `input-merge-only`, `input-rejected-in-merge`, `input-merged-file-missing`, `merged-file-is-layer`, `merged-file-unwritable` | `input-render-only`, `input-rejected-in-render`, `input-rendered-file-missing`, `rendered-file-is-layer`, `rendered-file-unwritable` |
| The library flow | `runMerge`, `MergeConfig`, `FinishedMerge`, `concludeMerge` | `runRender`, `RenderConfig`, `FinishedRender`, `concludeRender` |

`mode: merge` fails as an unsupported mode value, naming the four modes. There is no alias: rename the mode, the input, and the subcommand together, and a step that branches on `result == 'merged'` tests `rendered`. The library keeps `mergeSettings`, `MergeOptions`, and `MergeReport`, which name the fold, not the mode.

## 30. environments, branches, and workflows layer by key

Two layers, one `prod` environment, one `main` branch, one workflow each:

```text
fleet.yml (lower)   environments:
                      - name: prod
                        wait_timer: 5
                        variables:
                          - name: REGION
                            value: eu-west-1
                    branches:
                      - name: main
                        protection:
                          enforce_admins: true
                    workflows:
                      - path: nightly.yml
                        state: active

repo.yml (higher)   environments:
                      - name: Prod
                        variables:
                          - name: TIMEOUT
                            value: "30"
                    branches:
                      - name: main
                        protection:
                          required_signatures: true
                    workflows:
                      - path: ci.yml
                        state: disabled
```

The pre-release fold replaced all three lists whole, so the fleet's wait timer, `REGION`, `enforce_admins`, and `nightly.yml` were gone. Under v3's default `deep` they union like every other list section:

```text
rendered   environments:
             - name: Prod
               wait_timer: 5
               variables:
                 - name: REGION
                   value: eu-west-1
                 - name: TIMEOUT
                   value: "30"
           branches:
             - name: main
               protection:
                 required_signatures: true
                 enforce_admins: true
           workflows:
             - path: ci.yml
               state: disabled
             - path: nightly.yml
               state: active
```

Environment names fold case-insensitively, branch names verbatim, workflow paths as GitHub lists them. An environment's nested lists union by their own keys: `variables` and `secrets` by uppercased name, `deployment_branch_policies` by name, `deployment_protection_rules` by app, `reviewers` by type and id.

Each of the three accepts a `{_layering, entries}` wrapper, which the render consumes; the rendered file holds the bare list. `_layering: replace` on the wrapper keeps the old outcome. The wrapper takes no `_undeclared`, since these sections apply no undeclared policy.

The nested `variables` list renders bare above because both layers wrote it bare; the file-wide `_undeclared` of [section 32](#32-file-wide-_undeclared-and-the-undeclared-input) arrives separately and makes the render write every nested knobbed list in wrapper form, its resolved `_undeclared` spelled out.

## 31. null wins and means empty, and _remove drops an entry

The fold is a cascade: the higher layer's value wins at every depth, and `null` is a value like any other. Our `null` is the EMPTY or OFF state on GitHub, never a marker that deletes a lower key.

```text
fleet.yml (lower)   labels:
                      - name: bug
                        color: d73a4a
                      - name: wontfix
                        color: ffffff
                    branches:
                      - name: main
                        protection:
                          enforce_admins: true
                    pages:
                      build_type: workflow
                      source:
                        branch: main
                        path: /

repo.yml (higher)   labels:
                      - name: wontfix
                        _remove: true
                    branches:
                      - name: main
                        protection: null
                    pages: null

rendered            labels:
                      _undeclared: delete
                      entries:
                        - name: bug
                          color: d73a4a
                    branches:
                      - name: main
                        protection: null           # apply strips the protection
                    pages: null                    # apply turns Pages off
```

The removal drops `wontfix` and is consumed, with one notice:

```text
notice: repo.yml: labels[0] carries _remove: true and dropped the entry a lower layer declared under its key
```

Where GitHub has no empty state, a `null` is the layer's own error, naming the values that exist. So is a whole-section `null` outside `pages` and `interaction_limits`:

```text
error: bad.yml has malformed section entries: repository.enable_git_lfs has no empty state; write true or false; labels: null has no meaning; remove the section or declare its entries. ...
```

The pre-release fold read a higher `null` as "delete the lower key" with a notice, and dropped a top-level `null` that met nothing. Both readings are gone: every `null` that won its key is in the rendered file, and validation refused every one a key does not admit. `_undeclared: null` is refused the same way; omit the key to inherit the lower policy.

`_remove: true` is refused where nothing meets it: under `replace`, inside an entry copied whole (a new key, or a shallow swap), when no lower layer declares the key, or beside any field other than the entry's key. The [layering guide](../operate/layering.md#the-rules) lists each refusal.

The destructive-write caveat: a `null` written to mean "stop managing this" gets the empty state instead.

```text
fleet.yml   repository:
              description: Shared project description
            branches:
              - name: main
                protection:
                  required_status_checks:
                    strict: true
                    contexts: [ci]

local.yml   repository:
              description: null                    # apply sends {"description": null}: the description is cleared
            branches:
              - name: main
                protection:
                  required_status_checks: null     # apply removes the required checks
```

Both layers validate, since GitHub accepts `null` on those keys. Never write `null` for "leave it alone".

To stop managing a key, omit it from every layer; a live ruleset or environment key then needs a declared or empty value instead ([section 33](#33-apply-refuses-over-omitted-live-values)). To drop a keyed entry, write `_remove: true`. To clear a list, write `_layering: replace` with an empty list.

## 32. File-wide _undeclared and the undeclared input

The policy no longer has to be repeated on every wrapper:

```text
pre-release   labels:
                _undeclared: delete
                entries: [...]
              milestones:
                _undeclared: delete
                entries: [...]
              webhooks:
                _undeclared: delete
                entries: [...]

v3            _undeclared: delete          # every knobbed section of this file, unless its wrapper says otherwise
              labels: [...]
              milestones: [...]
              webhooks:
                _undeclared: keep          # the wrapper wins for this one section
                entries: [...]
```

The run input `undeclared` (`keep` or `delete`, unset by default) sets the same default for every file an apply, check, or render reads; `mode: snapshot` rejects it. The precedence, highest first: the list's wrapper, then the file's top-level `_undeclared`, then the `undeclared` input, then the list's own default the [undeclared policy](../reference/undeclared-policy.md) page lists.

A wrong value is refused before any section runs, one line in the collected list (abbreviated):

```text
settings.yml has malformed section entries: _undeclared must be one of "keep", "delete"; got a string that is none of them. Write _undeclared: keep or _undeclared: delete at the top of the file, or remove the key so each list's own policy applies (...)
```

A file-wide `delete` reaches the nested `environments[].deployment_protection_rules` list too: an undeclared deployment gate is disabled, where the nested default is `keep`. Set the nested wrapper to `keep` on the environment that must keep its gates.

One v2 file breaks: a top-level `_undeclared` that v2 dropped as a private note ([section 16](#16-underscore-keys-are-directives-never-notes)) is now the file-wide policy, so a `delete` note deletes the undeclared entries of every knobbed section on the first apply. Run `mode: check` first; the deletions appear there as drift. A file that set every wrapper by hand behaves as before, and a wrapper still beats every default.

The render consumes the top-level key and writes the resolved policy onto every knobbed wrapper, an environment's nested lists included, so a rendered document always carries those nested lists in wrapper form.

## 33. Apply refuses over omitted live values

Check compared declared keys only, but the ruleset PUT and the environment PUT write the whole object. A live value the file left out was deleted by the next apply while check said clean.

```text
v2 check    | rulesets     | clean |
            | environments | clean |
            (apply then cleared the live bypass list and the reviewers rule without a word)

v3 check    rulesets[main-protection].bypass_actors: live has [{"actor_id":5,"actor_type":"RepositoryRole","bypass_mode":"always"}] but the settings file omits it, so apply would REMOVE it; declare bypass_actors to keep it, or bypass_actors: [] to remove it on purpose
            environments[production].reviewers: live has [{"type":"User","id":101}] but the settings file omits it, so apply would REMOVE it; declare reviewers to keep it, or reviewers: [] to remove it on purpose

v3 apply    rulesets[main-protection]: not applied - the update would remove a live value the settings file omits. rulesets[main-protection].bypass_actors: live has [...] but the settings file omits it, so apply would REMOVE it; declare bypass_actors to keep it, or bypass_actors: [] to remove it on purpose
            (the entry's PUT is never sent, the section fails, exit 1)
```

A file that was stable can now drift: an environment entry declaring `variables` alone, beside a live wait timer, reports the timer in check and refuses the PUT in apply. Declare `wait_timer` to keep it, or `wait_timer: 0` to remove it; an omitted object whose key accepts null offers `<key>: null` (`deployment_branch_policy: null`).

The sweep stops where the entry shape stops naming keys (`rules[].parameters`, the fields inside a bypass actor): a live non-default rule parameter beside a declared rule still reads clean and the PUT resets it, as before. The [semantics page](../reference/semantics.md) states the boundary.

## 34. File-only checks run before the first write

```text
v2   sections: repository                 # labels excluded from the run
     labels:
       - name: bug
       - name: Bug
     -> repository: patched repository fields: description
        (the excluded duplicate was never seen; a selected duplicate threw mid-run, after the PATCH landed)

v3   -> ::error::settings.yml has malformed section entries: labels[1].name: "Bug" names the same label as "bug" declared earlier; keep exactly one entry per label. Fix these values in the settings file (...)
        result: failed, zero requests
```

Every section's file-only checks run at validation, selected or not: duplicate identities (a rename target and the pre-rename name included), malformed lists, an unreadable deploy key, a secret value that is not a whole-value `$NAME` reference the document's author may use, a non-plain value, a non-finite passthrough number, a passthrough alias cycle. The collected issues name their paths, and the run exits 1 before any request.

Fix the declaration, in the excluded section too. For `@vivswan/github-settings-as-code` consumers: `SectionModule` gains a required `validate(declared)` hook on list modules, so a custom list module without one stops compiling; the [library page](../reference/library.md) documents its shape.

## 35. Library: plan() takes only validator-minted input

For `@vivswan/github-settings-as-code` consumers. The old form is the pre-release v3 builds', as in sections 24 and 29.

```text
pre-release   const labels = sectionModule("labels");
              await labels.plan(planContext(labels, client, repo), [{ name: "bug" }, { name: "Bug" }]);
              // compiled: a caller could hand the planner a pair the validator refuses

v3            const { settings } = validateSettings(doc)._unsafeUnwrap();
              if (settings.labels !== undefined) {
                await labels.plan(planContext(labels, client, repo), settings.labels);
              }
              // settings.labels is the ValidatedInput<"labels"> the planner takes, or undefined when the file has no labels section
```

The old call fails to compile with `Property '[validatedInput]' is missing in type '{ name: string; }[]' but required in type 'ValidatedBrand<"labels">'`. Pass the section off a validated document: `validateSettings(doc)`, `mergeSettings(layers)`, or `snapshotRepository(...)` returns `settings`, and each section of it carries the brand. `SectionInput<K>`, the unbranded shape, stays exported for a custom module's `validate` hook.

## 36. Labels: colors and descriptions

```text
v2   labels:
       - name: bug
         color: red                 # POST -> 422; on an existing label, re-PATCHed on every run
       - name: docs
         color: "#0075ca"
         description: <150 characters>

v3   labels[0].color: a label color is six hex digits, the leading "#" optional ("#d73a4a" or "d73a4a"); color names and three-digit shorthand are not accepted
     labels[1].description: a label description is at most 100 characters (GitHub's cap); this one has 150
     (exit 1, zero requests)
```

Fix: write the six-digit hex value and cut the description to 100 characters; the published JSON schema carries both rules, so an editor flags them first.

## 37. Repository: GET-only keys, commit pairs, topics, and security sub-keys

```text
v2   repository:
       has_downloads: false         # drift: repository.has_downloads: false != true, on every run, forever
       squash_merge_commit_message: COMMIT_MESSAGES
       topics: [CI, ""]

v3   repository.has_downloads: has_downloads is reported by GitHub but cannot be set through the API; remove it
     repository.squash_merge_commit_message: ... names the legal squash title and message pairs
     repository.topics[1]: ... points at topics: [] as the one spelling of the clear
```

| Declared | v2 | v3 |
|---|---|---|
| A GET-only key (`has_downloads`, `has_pages`, `custom_properties`, ids, urls, counts) | Drift on every run | Refused naming the key; `custom_properties` and `has_pages` point at their sections |
| An unknown `security_and_analysis` sub-key, a status outside `enabled` and `disabled`, an untyped bypass reviewer | 422 at apply | Refused; `dependabot_security_updates` points at `enable_automated_security_fixes` |
| A squash or merge commit message without its title, or an illegal squash title and message pair | 422 at apply | Refused naming the legal squash pairs; merge takes any pair once the title is declared beside the message |
| A topic outside `^[a-z0-9][a-z0-9-]{0,49}$` after lowercasing, or more than 20 | 422 from the topics PUT | Refused naming the topic |
| An empty topic (`topics: [""]`, `topics: ""`, `ci,,tooling`) | Dropped silently, so `[""]` cleared every topic | Refused by index |

Fix: delete the GET-only key, declare the title beside the message, and spell topics in GitHub's alphabet. A key in neither the GET nor the PATCH still passes through, so a field GitHub adds later works on day one.

## 38. Pages: GET-only fields and the source path

```text
v2   pages:
       custom_404: true             # rode the PUT, was dropped: drift pages.custom_404: true != false, forever
       source:
         branch: main
         path: /src                 # 422 at apply

v3   pages.custom_404: GitHub reports this field on the Pages site and the update has no such parameter, so the value would be sent, ignored, and reported as drift on every run (it reports whether the published site carries a 404.html; add that file to the source instead); remove it
     pages.source.path: ... / or /docs
```

`url`, `html_url`, `status`, `custom_404`, `protected_domain_state`, `pending_domain_unverified_at`, and `https_certificate` are refused. `public: false` stays declarable: Enterprise Cloud shares the same host, so the check run's note beside the drift says why it cannot converge elsewhere.

Fix: delete the reported field from the file, and publish from `/` or `/docs`.

## 39. Actions: fields that could never converge

```text
v2   actions:
       artifact_and_log_retention:
         days: 30
         maximum_allowed_days: 400  # drift 400 != 90, re-PUT on every run; GitHub never takes the field
       selected_actions:
         pattern_allowed: ["docker/*"]   # a typo, re-PUT silently forever

v3   actions.artifact_and_log_retention.maximum_allowed_days: maximum_allowed_days is a value GitHub reports, not a setting it accepts (the GET returns it, the PUT does not take it), so a declared value could never be applied; remove it from the settings file
     actions.selected_actions: Unrecognized key: "pattern_allowed" ...
```

| Declared | v3 |
|---|---|
| `selected_actions_url`, `artifact_and_log_retention.maximum_allowed_days`, `oidc_customization_sub.sub_claim_prefix` | Refused naming the key |
| A `selected_actions` key outside `github_owned_allowed`, `verified_allowed`, `patterns_allowed`, or a mistyped value (`github_owned_allowed: "true"`) | Refused: the object is closed and typed |
| `sha_pinning_required: "true"` | Refused: a known boolean key of the permissions PUT, no longer an unrecognized passthrough |
| An `approval_policy` outside GitHub's three; a malformed or repeated OIDC claim key; `include_claim_keys` beside `use_default: true` | Refused naming the key |
| A fractional or non-positive retention or cache limit | Refused: positive integers |

Fix: delete the reported-only field, fix the `selected_actions` spelling, and write booleans and integers unquoted. `fork_pr_workflows_private_repos` now requires only `run_workflows_from_fork_pull_requests`, as the request body does.

## 40. Setup sections: GET-only keys, languages, and the runner pair

`code_scanning_default_setup` and `code_quality_setup` share one factory, so both gain the same rules:

```text
v2   code_scanning_default_setup:
       state: configured
       schedule: weekly             # drift schedule: "weekly" != null, PATCH planned forever
       languages: [javascript]      # never matched: GitHub reports javascript and typescript apart, and the PATCH takes only javascript-typescript
     code_quality_setup:
       runner_type: standard
       runner_label: gpu            # drift runner_label: "gpu" != null, forever

v3   code_scanning_default_setup.schedule: "schedule" is reported by GitHub but the PATCH does not accept it, so declaring it could only drift; remove it from the settings file
     code_scanning_default_setup.languages[0]: "javascript" is the spelling GitHub reports, not one the PATCH accepts; write "javascript-typescript"
     code_quality_setup.runner_label: runner_label "gpu" is declared under runner_type: "standard", where GitHub ignores it; set runner_type: "labeled", or remove runner_label
```

Fix: drop `schedule` and `updated_at`, spell languages as the PATCH takes them (`javascript-typescript`; code quality's GET-only `rust` has no declarable name), and pair a string `runner_label` with `runner_type: labeled`. A declared key outside the slice that the GET never echoes now earns the never-converges note in check and apply.

## 41. Branches: protection shapes

```text
v2   branches:
       - name: main
         protection:                # copied from GitHub's GET response
           url: https://api.github.com/repos/octocat/hello-world/branches/main/protection
           enforce_admins: {url: "...", enabled: true}
           required_status_checks: {strict: true, contexts: [ci], enforcement_level: everyone}
           restrictions: {users: [{login: octocat}], teams: []}
     -> PUT .../branches/main/protection -> 422 on the {url, enabled} wrapper; without it the PUT landed and the other GET-only keys drifted on every check

v3   branches[0].protection.required_status_checks.enforcement_level: ... is GitHub's GET-only echo, which the protection PUT has no word for; remove it (strict and the check list carry the requirement)
     branches[0].protection.url: ... is a link GitHub's GET response carries and the protection PUT has no word for; remove it
     branches[0].protection.enforce_admins.enabled: ... is GitHub's GET wrapper around the toggle, which the protection PUT takes as a bare boolean; declare enforce_admins: true instead
     branches[0].protection.restrictions.users[0]: ... carries an actor object copied from GitHub's GET response, which the protection PUT takes as the login string; write "octocat" instead
     (exit 1, zero requests)
```

| Declared | v2 | v3 |
|---|---|---|
| A GET-only key at any depth (`name`, `enabled`, `enforcement_level`, `url`, `*_url`) | A `{url, enabled}` wrapper 422ed at apply; the other keys applied, then drifted forever | Refused with the fix |
| `required_status_checks` without `strict`, or without `contexts` or `checks` | 422 at apply | Refused |
| `required_approving_review_count: 7` | 422 at apply | Refused: a whole number 0 to 6 |
| A `checks` item with a key other than `context` and `app_id` | Sent as written | Refused naming the key |
| A scalar where `required_status_checks` or `required_pull_request_reviews` goes | Refused on a wildcard entry, passed through to the PUT on a literal one | Refused: a mapping or `null` on every entry |
| An actor object copied from the GET (`restrictions.users: [{login: octocat}]`) | Sent to the PUT, which 422ed | Refused: write the `login` or `slug` string, `octocat` |

Fix: declare the PUT's shape (bare booleans, `strict` beside the check list, actors as their login or slug strings) instead of pasting the GET. Also new: a live `restrictions` holder whose `users`, `teams`, and `apps` are all empty is a push restriction that lets nobody through, so a file that omits it now sees the omitted-live drift line and a loud PUT instead of a silent lift.

## 42. Collaborators and teams: permissions and slugs

```text
v2   collaborators:
       - username: alice
         permission: write          # converged on an existing Write grant; PUT {"permission":"write"} on a new one -> 422
       - username: bob
         permission: Admin          # 422
     teams:
       - name: Core Team            # probed /teams/Core%20Team, 404; check said: no access to <repo>; apply will grant "push"
         permission: push

v3   collaborators[0].permission: "write" is the vocabulary GitHub reports a role in (role_name), not one a grant accepts; declare "push" ("pull", "triage", "push", "maintain", "admin", or a custom org role name)
     collaborators[1].permission: "Admin" is not a permission GitHub accepts; the standard permissions are lowercase: declare "admin"
     teams[0].name: a team is declared by its slug (the name in its URL, /orgs/<org>/teams/<slug>): letters, digits, ".", "_", and "-" only, at least one letter or digit; a team named "Core Team" usually has the slug "core-team"
```

Fix: declare `pull`, `triage`, `push`, `maintain`, `admin`, or a custom org role name as spelled, and name a team by its slug. Every suggested value in a message is one the schema accepts, and a block scalar's trailing newline is refused with the rule rather than a guess.

## 43. Secret and variable names, and the value cap

```text
v2   actions_secrets:
       - name: deploy-token         # parsed; earlier sections wrote; PUT .../secrets/DEPLOY-TOKEN -> 422 mid-apply
         value: $SECRET_DEPLOY_TOKEN

v3   actions_secrets[0].name: the secret name "deploy-token" has characters outside ASCII letters, digits, and underscore - GitHub accepts ASCII letters, digits, and underscores, not starting with a digit or with the reserved GITHUB_ prefix (in any case: names are stored uppercased)
     (exit 1, zero requests)
```

The rule covers every secret and variable family, the environment lists included: ASCII letters, digits, and underscores, no leading digit, no `GITHUB_` prefix in any case. A variable value is capped at 49152 bytes of UTF-8, counted as GitHub counts it.

Fix: rename the entry (`DEPLOY_TOKEN`) or shorten the value; the problem line names the entry's path.

## 44. Check-suite preferences: app_id

```text
v2   check_suite_preferences:
       auto_trigger_checks:
         - {app_id: 15368, setting: true}
         - {app_id: 0, setting: true}        # PATCHed on every run
         - {app_id: 15368, setting: false}   # GitHub kept whichever it read last; nothing reads it back

v3   check_suite_preferences.auto_trigger_checks[1].app_id: a GitHub App id is a positive integer (the App's settings page shows it); GitHub has no app 0 and rejects fractions
     check_suite_preferences.auto_trigger_checks[2].app_id: repeats app_id 15368 from auto_trigger_checks[0]; GitHub would keep whichever entry it reads last and nothing reads the result back, so declare one entry per app
```

Fix: one entry per App, its id a positive integer from the App's settings page.

## 45. Interaction limits: enums, the cap, and the closed section

```text
v2   interaction_limits:
       limit: collaborators
       expiry: two_weeks
       expires_at: "2027-01-01T00:00:00Z"
       pull_request_creation_cap: {enabled: true, max_open_pull_requests: 0}
     -> the base PUT re-armed every run and 422ed on expiry and expires_at, failing the section before the cap's own PATCH ran

v3   interaction_limits.limit: limit is one of existing_users, contributors_only, collaborators_only (GitHub's interaction groups)
     interaction_limits.expiry: expiry is one of one_day, three_days, one_week, one_month, six_months (GitHub's interaction durations)
     interaction_limits.pull_request_creation_cap.max_open_pull_requests: max_open_pull_requests is a whole number from 1 to 1000 (GitHub's range)
     interaction_limits: Unrecognized key: "expires_at"; interaction_limits takes limit, expiry, pull_request_creation_cap, and pull_request_creation_bypass (origin and expires_at are what GitHub reports, not what it accepts); remove the key, or fix its spelling
```

Fix: spell the enum values as listed, keep the cap in range, and delete `origin` and `expires_at`, which GitHub reports but never accepts.

## 46. Deploy keys: a public SSH key only

```text
v2   deploy_keys:
       - title: deploy-bot
         key: "-----BEGIN ..."      # a pasted private key: POST .../keys -> 201 against the mock, 422 on GitHub
     -> deploy_keys: created deploy key "deploy-bot", 3 requests

v3   deploy_keys[0].key: entry "deploy-bot": this is a private key; a deploy key takes the public half (the .pub file)
     (exit 1, zero requests; the material is never echoed)
```

`key` is `<algorithm> <base64> [comment]`, the algorithm one of `ssh-ed25519`, `ssh-rsa`, `ecdsa-sha2-nistp256`, `ecdsa-sha2-nistp384`, `ecdsa-sha2-nistp521`, `sk-ssh-ed25519@openssh.com`, `sk-ecdsa-sha2-nistp256@openssh.com`. `ssh-dss` is refused naming 2022-03-15, the day GitHub stopped accepting DSA keys; a PEM block is told to use the one-line form.

Fix: declare the contents of the `.pub` file. A live key under an algorithm the file cannot declare (an `ssh-ed448` key, a DSA key from before 2022) is outside the section: never matched, deleted, or aborted on, and a snapshot leaves it out with a note.

## 47. Webhooks: events, content type, insecure_ssl, and the url

```text
v2   webhooks:
       - config:
           url: hooks.example.com/ci
           content_type: JSON
           insecure_ssl: 2
         events: [push, pushes]
     -> validation accepted the file; POST /repos/{owner}/{repo}/hooks -> 422, after the other sections ran

v3   webhooks[0].config.url: "hooks.example.com/ci" is not an absolute URL (the shape is https://hooks.example.com/ci); GitHub refuses the hook otherwise
     webhooks[0].config.content_type: "JSON" is not a payload encoding GitHub accepts; use "json" or "form"
     webhooks[0].config.insecure_ssl: 2 is not a value GitHub accepts; use "0" (verify the TLS certificate) or "1" (skip verification), as a string or a number
     webhooks[0].events[1]: "pushes" is not an event GitHub delivers to repository webhooks ("*" means every event); the accepted names are GitHub's list at https://docs.github.com/webhooks/webhook-events-and-payloads, read from @octokit/openapi-webhooks, so an event GitHub added since arrives in the release that bumps that package
```

Fix: an absolute URL, `json` or `form`, `"0"` or `"1"`, and event names from GitHub's repository list. The list is generated from `@octokit/openapi-webhooks`, so an event GitHub adds later is refused until the release that bumps that package.

## 48. Secret scanning patterns must compile

```text
v2   secret_scanning_custom_patterns:
       - name: internal-api-token
         pattern: "([a-z"           # parsed clean; check saw only a missing pattern; apply -> bulk create 422
         must_match: ["[0-9]", "*prod"]

v3   secret_scanning_custom_patterns[0].pattern: cannot be compiled as a regular expression (Invalid regular expression: missing terminating ] for character class); fix the expression, or report a documentation issue if Hyperscan accepts it as written - ...
     secret_scanning_custom_patterns[0].must_match[1]: cannot be compiled as a regular expression (quantifier does not follow a repeatable item); ...
```

The five regex fields pass a syntax check at parse. The check first translates the PCRE-only spellings Hyperscan accepts (named groups, comments, modifiers, atomic and possessive forms, quoted literals, code point escapes, POSIX classes), then compiles the result as a flagless JavaScript `RegExp`, so a pattern GitHub already holds is never refused.

Fix the expression. A snapshot leaves out a live pattern the check cannot verify, with a note naming it, and writes the rest; Hyperscan can still refuse at apply what it alone refuses (lookbehind, backreferences).

## 49. Rulesets: enforcement, actors, tokens, and parameters

```text
v2   rulesets:
       - name: main-protection
         enforcement: enabled
         conditions: {ref_name: {include: ["~all"]}}
         bypass_actors: [{actor_type: Team}]
         rules:
           - type: merge_queue
             parameters: {merge_method: squash, grouping_strategy: allgreen}
     -> POST /repos/{owner}/{repo}/rulesets -> 422, after the sections before rulesets wrote

v3   rulesets[0].enforcement: Invalid option: expected one of "active"|"evaluate"|"disabled"
     rulesets[0].conditions.ref_name.include[0]: "~all" is not a ref-name token: the tokens are ~ALL and ~DEFAULT_BRANCH (case-sensitive), and no ref name contains "~"
     rulesets[0].rules[0]: parameters.grouping_strategy: Invalid option: expected one of "ALLGREEN"|"HEADGREEN"; parameters.merge_method: Invalid option: expected one of "MERGE"|"SQUASH"|"REBASE"; parameters.check_response_timeout_minutes: Invalid input: expected number, received undefined; ... (the four other numeric merge_queue parameters the file left out, the same way)
     rulesets[0].bypass_actors[0].actor_id: a Team bypass actor needs its numeric actor_id (the id GitHub assigns the app, role, team, or user); GitHub rejects the ruleset without it
```

Bypass actors are typed from the spec: Integration, RepositoryRole, Team, and User need an `actor_id`; DeployKey takes none and never `pull_request`; `pull_request` applies to branch rulesets only. The 23 known rule types carry their parameters typed from the spec, in GitHub's casing; an unknown rule type still passes through, so a type GitHub ships tomorrow works the day it ships.

Fix: spell the enums as GitHub does, give each actor its id, and write `~ALL` or `~DEFAULT_BRANCH`.

## 50. Milestones: due_on is a day

```text
v2   milestones:
       - title: v1.0
         due_on: 2026-01-15            # compared verbatim to the "2026-01-15T08:00:00Z" GitHub echoes: drift forever
       - title: v2.0
         due_on: 2026-07-01T00:00:00Z  # sent verbatim: GitHub stored the PREVIOUS day

v3   due_on: 2026-01-15                # a calendar day; written as 2026-01-15T12:00:00Z, compared by day, converges
     due_on: null                      # refused, naming the day form
     due_on: 2026-01-15T00:00:00+02:00 # refused, naming the day form
```

GitHub reads the sent instant in US Pacific time, keeps the day, and stores Pacific midnight. v3 writes noon UTC (the same day in PST and PDT), compares the live timestamp by its UTC day, and a snapshot writes the day. A UTC timestamp `YYYY-MM-DDTHH:MM:SSZ` is still accepted, read for its date part.

Fix: write the day. There is no `null` to clear a due date yet.

## 51. Environments: disabled defaults and the refusals

```text
v2   environments:
       - name: production
         wait_timer: 0
         prevent_self_review: false
         reviewers: []
     -> drift: environments[production].wait_timer: declared 0 but the API response has no such field (new or write-only field?)
        (and the same for the other two; PUT on every run, never converged)

v3   -> result: clean
```

GitHub answers `protection_rules: []` for an unprotected environment, and the flattened body now starts from the disabled values, so the declaration is satisfied by the absence of the rule. A snapshot writes the three disabled values out for an unprotected environment.

| Declared | v2 | v3 |
|---|---|---|
| `deployment_branch_policy: {protected_branches: false, custom_branch_policies: false}` | 422 | Refused: GitHub spells "any branch may deploy" as `deployment_branch_policy: null`, so write `null` |
| Both flags `true` | 422 | Refused: the flags are mutually exclusive |
| `prevent_self_review: true` with no reviewers | Drifted forever (the flag rides the required-reviewers rule) | Refused: declare a reviewer, or write `false` |
| `wait_timer: 2.5`, or outside 0 to 43200 | 422 | Refused: a whole number of minutes in GitHub's range |
| More than 6 `reviewers` | 422 | Refused: GitHub's cap |
| `deployment_branch_policies[].type: wildcard` | Deleted the live policy, then the create 422ed; every run retried | Refused: `branch` or `tag` |

For library consumers, `DeploymentBranchPolicyConfig.type` narrows from `string` to `"branch" | "tag"`.

## 52. Autolinks: charset, placeholder, and overlapping prefixes

```text
v2   autolinks:
       - key_prefix: TICKET-
         url_template: https://example.com/TICKET       # 422 on the create
       - key_prefix: ""
         url_template: https://example.com/<num>        # 422
       - key_prefix: "BUG "
         url_template: https://example.com/BUG/<num>    # 422

v3   autolinks[0].url_template: url_template "https://example.com/TICKET" has no "<num>" placeholder, so GitHub rejects the create; put "<num>" where the reference number goes, e.g. "https://example.com/TICKET/<num>"
     autolinks[1].key_prefix: key_prefix is empty; it is the text GitHub matches before the reference number, e.g. "TICKET-"
     autolinks[2].key_prefix: key_prefix "BUG " may only contain letters, digits, and . - _ + = : / #, which is all GitHub accepts; remove the other characters
```

Two prefixes where one begins the other (`TICKET-` and `TICKET-A`) are refused as a pair before the section's read, since GitHub rejects the second create. A recreate (the template changed) now carries the live `is_alphanumeric`; v2's create sent `is_alphanumeric: true` itself when the file left the flag out, flipping a live `false` with no drift line.

Fix: a non-empty prefix in GitHub's charset, `<num>` in every template, and prefixes where neither begins another.

## 53. YAML merge keys resolve

```text
v2   labels:
       - &base
         name: bug
         color: ff0000
         description: Something broken
       - <<: *base
         name: defect
     -> the second label as parsed: {"<<": {"name": "bug", ...}, "name": "defect"}; the "<<" field rode into the create payload

v3   -> the second label as parsed: {"name": "defect", "color": "ff0000", "description": "Something broken"}
```

Every reader (single file, layers, central file, defaults file, the CLI) parses through one function, so `<<` resolves the way the Probot Settings app's parser did. Nothing to fix; a file that leaned on the literal `<<` key reaching GitHub had a 422 waiting.

## 54. Library: a parsed ruleset entry carries `target` and `enforcement`

For `@vivswan/github-settings-as-code` consumers. The old form is the pre-release v3 builds', as in sections 24 and 29. The settings file is unchanged: both keys stay optional there, and the parse fills `target: branch` and `enforcement: active`.

The parsed entry always carries both, so the full-payload PUT sends them and the comparison never reads a live value under either key as omitted. The parsed type says so, and a typed literal that omits them stops compiling.

```text
pre-release   const doc: SettingsFile = { rulesets: [{ name: "main" }] };            // compiles

v3            const doc: SettingsFile = { rulesets: [{ name: "main" }] };            // TS2739: target and enforcement are missing
              const { settings } = validateSettings({ rulesets: [{ name: "main" }] })._unsafeUnwrap();  // parsed: both keys filled
              const doc: SettingsFile = { rulesets: [{ name: "main", target: "branch", enforcement: "active" }] };
```

`sectionModule("rulesets").plan` takes the parsed entry, so a hand-built entry handed to it needs both keys too.

An entry cast past the type gets two omitted-key drift lines, since nothing fills them after the parse.

## 55. Branches: a restrictions block carries users and teams

```text
v2   branches:
       - name: main
         protection:
           restrictions: {}                    # parsed clean
       - name: develop
         protection:
           restrictions:
             users: [octocat]
             apps: [deploy-gate]               # parsed clean
     -> PUT .../branches/main/protection -> 422, with v2's hint: "restrictions" needs "users" and "teams" lists (or declare the whole key as null)

v3   branches[0].protection.restrictions.users: protection.restrictions must carry both users and teams ([] when none; apps is optional), since GitHub's protection PUT requires the two lists; restrictions: null lifts the push restriction
     branches[0].protection.restrictions.teams: protection.restrictions must carry both users and teams ...
     branches[1].protection.restrictions.teams: protection.restrictions must carry both users and teams ...
     (exit 1, zero requests)
```

GitHub's protection PUT requires `users` and `teams` under `restrictions` and takes `apps` as optional, so each missing list is refused before any request. The two review-side holders are unchanged: `dismissal_restrictions: {}` and `bypass_pull_request_allowances: {}` stay legal, since GitHub documents the empty mapping there as "disabled".

Fix: declare both lists (`users: []` and `teams: []` when none), or write `restrictions: null` to lift the push restriction.

## 56. Library: `plan()` and `snapshot()` resolve to a `Result`

For `@vivswan/github-settings-as-code` consumers. The old form is the pre-release v3 builds', as in sections 24, 29, 35, and 54.

A section never throws for what a user can cause. `plan()` and `snapshot()` resolve to a neverthrow `Result`: the plan or snapshot on `Ok`, a `SectionFailure` on `Err`, whose `message` is the whole line the action reports and whose `kind` names the policy the engine applies (`"permission-denied"` carries the section, the detail, and the HTTP status beside it). Every line is the one the thrown error carried.

```text
pre-release   const plan = await labels.plan(ctx, declared);          // resolves to the plan, rejects on a denied read
              plan.ops.length;

v3            const planned = await labels.plan(ctx, declared);       // resolves to Result<SectionPlan, SectionFailure>
              if (planned.isErr()) throw new Error(planned.error.message);
              planned.value.ops.length;
```

The change hook of a planned operation, its capture hook, and its `before`, `payload`, and `variables` thunks return a `Result` too; a hook that used to throw its verification failure returns `err(...)` with the same text.

A rejection out of `plan()` or `snapshot()` now means one of three things: the module was handed another section's context (the guard the [library page](../reference/library.md#sections) describes, unchanged), the `GitHubClient` you supplied threw instead of answering (section 58), or a `BUG:` invariant fired.

Fix: match on the `Result` (`isErr()`, `match`, or `_unsafeUnwrap()` in a test) where the awaited value was read directly, and assert `Err` where a test asserted a rejection.

## 57. A closed section's unrecognized key names the entry by index

A bracket in a validation issue's path always holds an index now. The unrecognized-key message of the closed sections (`collaborators`, `teams`, `workflows`, `custom_properties`, `secret_scanning_custom_patterns`, and the four secrets sections) was the one message that put the entry's identity there; it names the entry by its index and carries the identity in the text.

```text
v2   collaborators[octocat]: declares "permision", which this section does not recognize (known keys: username, permission) - ...

v3   collaborators[0] (username "octocat"): declares "permision", which this section does not recognize (known keys: username, permission) - ...
```

Under an `{_undeclared, entries}` wrapper the path reads `collaborators.entries[0] (username "octocat")`, as every other issue under a wrapper does.

Fix: anything that greps the bracket for the entry's identity reads the parenthesis instead.

## 58. Library: `GitHubClient` and `ArtifactUploader` answer, never reject

For `@vivswan/github-settings-as-code` consumers. The old form is the pre-release v3 builds', as in section 56.

`GitHubApi` never rejects. A request with no HTTP answer resolves to the `failed` arm of `ClientAnswer`, carrying the whole line the action reports (the request, the reason, the remedy). The reason is withheld where the request carried a secret, and for a GraphQL request where the repository is redacted.

The engine reads that arm wherever it read the throw:

- a section fails with kind `transport`
- discovery reports its transport problem
- a multi-repo target fails with the line, where the run used to stop
- the private-report channels warn without it

```text
pre-release   const answer = await client.tryRequest("GET", path);      // rejects on a network failure
              if ("error" in answer) ...

v3            const answer = await client.tryRequest("GET", path);      // resolves to ClientAnswer<unknown>
              if ("failed" in answer) throw new Error(answer.failed);
              if ("error" in answer) ...
```

`ArtifactUploader.upload()` resolves to `{ uploaded: true }` or `{ failed }`; `deliverArtifactReport` renders `failed` into its warning as it rendered the throw. A client or uploader that still throws is not classified: a section reports it under kind `thrown`, the report channels warn with their slug-free line.

Fix: add the `failed` arm to every `GitHubClient` double and read it before `error`; return `{ uploaded: true }` from every `ArtifactUploader` double.

## Order of operations

1. Rename any settings file whose path contains a comma, rename `undeclared` to `_undeclared` in every settings file, and move every other underscore key into a YAML comment; the v2 line accepts the old spellings only, so do all three together with the pin move.
2. Rename `skippedSections` to `skipped-sections` in every step expression that reads `repos-result`, and repoint `jq` filters at the `--json` envelope.
3. Where a snapshot wrote a `$WEBHOOK_SECRET_<id>` reference, change the reference and its exported variable to `SECRET_WEBHOOK_<id>` together, or re-snapshot.
4. Move the pin to `@v3` with `mode: check`. A layered setup also renames `mode: merge` to `mode: render` and `merged-file` to `rendered-file`, and writes `deep` where a layer or the `layering` input said `merge`; v3 refuses both before check runs. The parse-time refusals (sections 36 to 52 and 55) surface here, before any request, at most five schema issues per section; fix each and run check again.
5. Read the fallback notices and the drift; add render steps where a target needs the old overlay behavior; delete duplicated live items the sections now refuse; declare or empty the live values apply now refuses to write over (section 33).
6. In a layered setup, write `_layering: replace` where a higher list must still win, omit from every layer any key whose `null` meant "stop managing this", and drop a lower entry with `_remove: true` (sections 28 to 31).
7. Switch back to apply.
