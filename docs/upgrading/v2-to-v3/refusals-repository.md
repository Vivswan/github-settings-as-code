---
order: 5
title: "Parse-time refusals: repository-level sections"
---

# Upgrading from v2 to v3: parse-time refusals: repository-level sections

Sections 37, 38, 39, 40, 44, and 45 of the [v2 to v3 guide](../v2-to-v3.md), whose index page carries the summary table and the order of operations.

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

For `@vivswan/github-settings-as-code` consumers, the commit-message keys under `SectionInput<"repository">` (and so `SettingsFile`) are enums and `security_and_analysis` is a closed shape, once `unknown`; a `string` or an unknown sub-key stops compiling.

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

For `@vivswan/github-settings-as-code` consumers, `source.path` under `SectionInput<"pages">` (and so `SettingsFile`) is `"/" | "/docs"`, where the pre-release v3 builds typed `string`; another path there stops compiling.

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

For `@vivswan/github-settings-as-code` consumers, in `SectionInput<"actions">` (and so `SettingsFile`) `approval_policy` is an enum, once `string`, and `selected_actions` is closed, once an open mapping; a `string` or an unknown key there stops compiling.

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

For `@vivswan/github-settings-as-code` consumers, `languages` under `SectionInput<"code_scanning_default_setup" | "code_quality_setup">` (and so `SettingsFile`) is an array whose items are the PATCH's enum, once `string`; `javascript` stops compiling.

Fix: drop `schedule` and `updated_at`, spell languages as the PATCH takes them (`javascript-typescript`; code quality's GET-only `rust` has no declarable name), and pair a string `runner_label` with `runner_type: labeled`. A declared key outside the slice that the GET never echoes now earns the never-converges note in check and apply.

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

For `@vivswan/github-settings-as-code` consumers, `limit` and `expiry` under `SectionInput<"interaction_limits">` (and so `SettingsFile`) are the enums above, where the pre-release v3 builds typed `string`; another value there stops compiling.

Fix: spell the enum values as listed, keep the cap in range, and delete `origin` and `expires_at`, which GitHub reports but never accepts.
