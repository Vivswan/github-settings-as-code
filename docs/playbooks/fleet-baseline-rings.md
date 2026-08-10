# A fleet security baseline, rolled out in rings

One reviewed defaults file defines "secure by default" for every managed
repository, and a topic per rollout ring controls who gets it when. The
baseline lives in the admin repository:

```yaml settings
# .github/settings-defaults.yml
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

Two details in that file earn a sentence each. Rule parameters pass through
verbatim, so `required_signatures` works as a ruleset rule today even though
classic `branches` protection does not support it (see
[COVERAGE.md](../../COVERAGE.md)). And the `bypass_actors` entry is a
deliberate break-glass path: `bypass_mode: pull_request` lets repository
admins bypass through a pull request while still blocking direct pushes,
which is usually the right emergency valve for a baseline. Capability
boundaries shape what belongs in shared defaults for a mixed fleet.
Settings that exist only on public repositories (private vulnerability
reporting, for one) go in a job scoped with `visibility: public`. Settings
gated by plan rather than visibility (secret scanning on private
repositories needs Advanced Security, which no discovery filter can see)
go in a topic-marked capability cohort, the same mechanism as the rings.
And `selected_actions.patterns_allowed` sits in between: it is accepted
everywhere but only applies to public repositories, so private
repositories in this cohort rely on the `github_owned_allowed` and
`verified_allowed` flags alone.

The workflow applies the baseline ring by ring, using `repos: "*"`
discovery filtered by topic:

```yaml
name: Fleet baseline
on:
  push:
    branches: [main]
    paths: [.github/settings-defaults.yml]
  schedule:
    - cron: "23 5 * * *"
  workflow_dispatch:

permissions:
  contents: read

jobs:
  rings:
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix:
        include:
          - ring: settings-ring-0
            mode: apply
          - ring: settings-ring-1
            mode: check
    steps:
      - uses: actions/checkout@v7
      - uses: Vivswan/github-settings-as-code@v1 # x-release-please-major
        with:
          token: ${{ secrets.FLEET_TOKEN }}
          repos: "*"
          topics: ${{ matrix.ring }}
          archived: skip
          mode: ${{ matrix.mode }}
          defaults-file: .github/settings-defaults.yml
```

Ring 0 converges on the baseline while ring 1 only reports what would
change; `fail-fast: false` keeps ring 1's expected drift exit from
cancelling ring 0's apply mid-run. Enrollment needs two things on each
target: the ring topic, and a `.github/settings.yml` of the target's own
on its default branch, because a `repos: "*"` target without one is
skipped with a notice and the defaults are never merged for it (a minimal
file declaring the repository's `topics` serves both needs at once).
Promotion is retopicking the repository, and the mechanics matter:
discovery reads each repository's live topics, and ring 1 runs in check
mode, so a ring topic merely declared in a target's settings file is
invisible to discovery until something applies it. Promote by changing the
live topic (`gh repo edit acme/payments --add-topic settings-ring-0
--remove-topic settings-ring-1`), or through the target's own settings
workflow when it runs one. After promoting, the ring topic must also
appear in the target's declared `topics` list, because the repository
section replaces the full topic set on apply: a file that omits the ring
topic un-promotes the repository on the next apply run, and the ring
workflow stops seeing it. When ring 1's checks read clean or acceptable,
flip its matrix entry to `apply`. Note that `topics` and the other
discovery filters are rejected unless `repos: "*"` is set, so this pattern
does not transfer directly to `repos-dir` cohorts; with central files,
staging is folders (one `repos-dir` per cohort) instead of topics.
