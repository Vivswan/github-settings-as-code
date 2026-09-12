---
order: 320
---

# A fleet security baseline, rolled out in rings

One reviewed baseline file defines "secure by default" for every managed repository, and a topic per rollout ring controls who gets it when. The baseline lives in the admin repository:

```yaml settings
# .github/settings/baseline.yml
repository:
  delete_branch_on_merge: true
  allow_merge_commit: false
  enable_vulnerability_alerts: true
  enable_automated_security_fixes: true

actions:
  allowed_actions: selected
  selected_actions:
    github_owned_allowed: true
    verified_allowed: false
    patterns_allowed: ["acme-platform/*"]
  default_workflow_permissions: read
  can_approve_pull_request_reviews: false

rulesets:
  - name: baseline default branch
    target: branch
    enforcement: active
    conditions:
      ref_name:
        include: ["~DEFAULT_BRANCH"]
        exclude: []
    bypass_actors:
      - actor_id: 5
        actor_type: RepositoryRole
        bypass_mode: pull_request
    rules:
      - type: deletion
      - type: non_fast_forward
      - type: required_signatures
      - type: pull_request
        parameters:
          required_approving_review_count: 2
          dismiss_stale_reviews_on_push: true
          require_code_owner_review: true
          require_last_push_approval: true
          required_review_thread_resolution: true
```

Two details in that file earn a sentence each:

- Rule parameters pass through verbatim, so every rule type GitHub accepts works here, `required_signatures` included (see [COVERAGE.md](https://github.com/Vivswan/github-settings-as-code/blob/main/COVERAGE.md)).
- The `bypass_actors` entry is the break-glass path: `bypass_mode: pull_request` lets repository admins bypass through a pull request while direct pushes stay blocked.

Capability boundaries decide what belongs in a shared baseline for a mixed fleet:

| The setting | Example | Where it goes |
|---|---|---|
| Exists only on public repositories | Private vulnerability reporting | A job scoped with `visibility: public` |
| Gated by plan, not visibility | Secret scanning on private repositories needs Advanced Security, which no discovery filter can see | A topic-marked capability cohort, the same mechanism as the rings |
| Accepted everywhere, applied on public only | `selected_actions.patterns_allowed` | The baseline; private repositories rely on `github_owned_allowed` and `verified_allowed` alone |

## The layers

The baseline is the lowest layer. A ring layer sits above it, and a repository's own file above that. Ring 1 installs the ruleset with `enforcement: evaluate`: GitHub records what each rule would have blocked without blocking anything, so a repository shows the effect in its rule insights before promotion to ring 0 makes the ruleset active:

```yaml layer
# .github/settings/rings/settings-ring-1.yml
rulesets:
  - name: baseline default branch
    enforcement: evaluate
```

Ring 0's layer, `settings-ring-0.yml`, is empty (an empty file is a valid layer). A repository that keeps its own settings adds a file under `.github/repos/<ring>/<name>.yml` in the admin repository; it need only say what differs:

```yaml layer
# .github/repos/settings-ring-0/payments.yml
repository:
  description: Payments service
labels:
  - name: incident
    color: "b60205"
```

Under `mode: merge` the same-name ruleset merges key by key, so ring 1's `enforcement: evaluate` lands on the baseline ruleset without repeating its rules; `labels` union by name, so the baseline's labels stay. The [layering guide](../operate/layering.md) has the full rules.

## The workflow

Three jobs per run, both rings applying (ring 1 applies the evaluate ruleset):

- `plan` lists the curated files.
- `curated` folds three layers per file and applies the merged document to that repository.
- `fileless` folds the baseline and the ring layer once and hands the result to discovery as the `defaults-file`, which reaches every ring-topic repository that has no `.github/settings.yml` of its own. The curated names are excluded from discovery, so no repository is applied twice.

```yaml
name: Fleet baseline
on:
  push:
    branches: [main]
    paths: [".github/settings/**", ".github/repos/**"]
  schedule:
    - cron: "23 5 * * *"
  workflow_dispatch:

permissions:
  contents: read

jobs:
  plan:
    runs-on: ubuntu-latest
    outputs:
      curated: ${{ steps.list.outputs.curated }}
      exclude: ${{ steps.list.outputs.exclude }}
    steps:
      - uses: actions/checkout@v7
      - id: list
        run: |
          curated="$(find .github/repos -name '*.yml' \
            | sed -E 's#^\.github/repos/([^/]+)/(.+)\.yml$#{"ring":"\1","repo":"\2"}#' | jq -sc .)"
          echo "curated=$curated" >> "$GITHUB_OUTPUT"
          echo "exclude=$(jq -r 'map(.repo) | join(",")' <<< "$curated")" >> "$GITHUB_OUTPUT"

  curated:
    needs: plan
    if: needs.plan.outputs.curated != '[]'
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix:
        include: ${{ fromJSON(needs.plan.outputs.curated) }}
    steps:
      - uses: actions/checkout@v7
      - uses: Vivswan/github-settings-as-code@v3 # x-release-please-major
        with:
          mode: merge
          settings-file: |
            .github/settings/baseline.yml
            .github/settings/rings/${{ matrix.ring }}.yml
            .github/repos/${{ matrix.ring }}/${{ matrix.repo }}.yml
          merged-file: merged/${{ matrix.repo }}.yml
      - uses: Vivswan/github-settings-as-code@v3 # x-release-please-major
        with:
          token: ${{ secrets.FLEET_TOKEN }}
          repository: acme/${{ matrix.repo }}
          settings-file: merged/${{ matrix.repo }}.yml

  fileless:
    needs: plan
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix:
        ring: [settings-ring-0, settings-ring-1]
    steps:
      - uses: actions/checkout@v7
      - uses: Vivswan/github-settings-as-code@v3 # x-release-please-major
        with:
          mode: merge
          settings-file: |
            .github/settings/baseline.yml
            .github/settings/rings/${{ matrix.ring }}.yml
          merged-file: merged/${{ matrix.ring }}.yml
      - uses: Vivswan/github-settings-as-code@v3 # x-release-please-major
        with:
          token: ${{ secrets.FLEET_TOKEN }}
          repos: "*"
          topics: ${{ matrix.ring }}
          exclude: ${{ needs.plan.outputs.exclude }}
          archived: skip
          defaults-file: merged/${{ matrix.ring }}.yml
```

`fail-fast: false` keeps one repository's failure from cancelling the rest of the matrix, and the `if` skips the `curated` job while the tree is empty (a matrix cannot include nothing). The merge steps need no token: they fold local files and write the merged documents the apply steps read. The `exclude` input takes the curated names as wildcard patterns, so a curated repository that still carries a ring topic is never applied by both jobs.

The `curated` matrix runs one job per file, and a matrix runs at most 256 jobs. Past that, split only the `curated` job by cohort folder into copies; the `fileless` job stays single, and its `exclude` keeps listing every curated name across all cohorts, or a cohort's fallback run would apply the bare baseline to another cohort's curated repository that has no remote settings file. To preview a baseline change before it lands, run the same merged documents through `mode: check` on pull requests, as in [Preview the blast radius](preview-blast-radius.md).

## Enrollment and promotion

- A curated repository is enrolled by its file under `.github/repos/<ring>/`; the `plan` job reads the tree, so promotion is moving the file to the next ring's folder in a reviewed pull request.
- A fileless repository is enrolled by its live ring topic. Promotion is retopicking it: `gh repo edit acme/payments --add-topic settings-ring-0 --remove-topic settings-ring-1`. Discovery reads live topics, so a topic declared in a file is invisible until something applies it.
- Keep `topics` out of the baseline. The repository section replaces the full topic set on apply, so a baseline that declared topics would strip the ring topic from every fileless repository it reaches.
- A fileless repository that gains a `.github/settings.yml` leaves the fallback: the fleet job applies that file alone. Move it to the curated matrix so the baseline keeps reaching it.

Promotion to ring 0 is what turns `evaluate` into `active`: the ring-0 layer is empty, so the baseline's `enforcement: active` applies unchanged. Read a ring-1 repository's rule insights first (Settings, then Rules, then Insights) to see what the evaluate run would have blocked.
