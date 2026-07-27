# Playbooks

Operational playbooks for running this action as a platform team: rolling a
baseline out in rings, previewing fleet changes, splitting trust between
tokens, producing audit evidence, and handling incidents. Each playbook
composes inputs and sections that the [README](../README.md) documents
individually; the [multi-repo guide](multi-repo.md) covers the underlying
mechanics. All of these work with the action as it is today.

## A fleet security baseline, rolled out in rings

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
[COVERAGE.md](../COVERAGE.md)). And the `bypass_actors` entry is a
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
      - uses: Vivswan/repo-settings-as-code@v1 # x-release-please-major
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

## Preview the blast radius of a fleet change

One line in a defaults file can delete labels on three hundred
repositories. Check mode on pull requests is the plan step:

```yaml
name: Preview fleet changes
on:
  pull_request:
    paths:
      - ".github/repos/**"
      - ".github/settings-defaults.yml"

permissions:
  contents: read
  pull-requests: write

jobs:
  preview:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - id: plan
        continue-on-error: true
        uses: Vivswan/repo-settings-as-code@v1 # x-release-please-major
        with:
          token: ${{ secrets.FLEET_READ_TOKEN }}
          mode: check
          repos-dir: .github/repos
          defaults-file: .github/settings-defaults.yml
      - name: Comment the per-repo results
        env:
          REPOS_RESULT: ${{ steps.plan.outputs.repos-result }}
          GH_TOKEN: ${{ github.token }}
        run: |
          body="$(jq -r 'to_entries[] | "- \(.key): \(.value.result)"' <<< "$REPOS_RESULT")"
          gh pr comment "${{ github.event.pull_request.number }}" \
            --body "Settings check for this PR:"$'\n'"$body"
```

`continue-on-error` is load-bearing: a pull request that changes settings
is supposed to exit 1, so the verdict is the rendered `repos-result` map
and the drift lines in the run log, not the step's color. Read the report
as proposed-versus-live, not as a diff of the PR itself: the drift
includes any divergence that existed before the PR, and it is exactly
what an apply on merge would change. The read-only
token keeps the write-capable credential out of `pull_request` jobs
entirely (the [check mode guide](check-mode.md) explains why that
matters).

## A cloud OIDC trust contract

Cloud providers trust GitHub Actions through OIDC: a deploy role's trust
policy matches conditions against the workflow token's subject claim. The
default subject format varies by trigger (an environment-scoped job, a
branch push, and a pull request each produce a different shape), so trust
policies written against it tend to end up looser than intended. Pinning
the claim keys turns the subject shape into a reviewable contract:

```yaml settings
actions:
  oidc_customization_sub:
    use_default: false
    # Per-repo template: this repository's OIDC jobs flow through a
    # reusable deploy workflow. For a fleet-wide defaults file, stop at
    # [repo, context] - see the fleet note below.
    include_claim_keys: [repo, context, job_workflow_ref]
```

With that template every subject carries the same claim-key sequence,
`repo:ORG/REPO:<context>:job_workflow_ref:PATH`. The `context` segment's
value still varies with the trigger, exactly as the default subject's tail
does: an environment-scoped job yields `environment:ENV`, a branch push
`ref:refs/heads/BRANCH`, a pull request `pull_request`. For an
environment-scoped deploy job the subject reads:

```text
repo:acme/payments:environment:production:job_workflow_ref:acme/platform/.github/workflows/deploy.yml@refs/heads/main
```

and a trust policy that requires that exact string admits only
production-environment deploys flowing through that one reusable deploy
workflow. A minimal `[repo, context]` template reproduces the default
subject shape exactly; that is still worth pinning as a drift guard
against upstream format changes, but the hardening comes from the extra
keys.

Three details carry the pattern. Claim-key order defines the subject
format, so the list is compared positionally and a reordered live value is
drift. The OIDC endpoints need the `Actions` PAT permission rather than
the Administration grant the rest of the section uses (the
[Sections table](../README.md#sections) notes it). And the fleet story is
two-tier: `[repo, context]` is what belongs in a fleet-wide defaults
file, turning every repository's subject shape into one reviewed line,
while `job_workflow_ref` belongs only on repositories whose OIDC jobs
flow through reusable workflows - GitHub documents that claim for
reusable-workflow jobs, and a claim key the job cannot supply becomes a
requirement the moment it is included (the docs say exactly that for
`environment`, which turns mandatory once listed). One adjacent setting
to know about: `use_immutable_subject: true` opts the repository into a
stable repository-ID-based subject
(`repo:acme@OWNER-ID/payments@REPO-ID:...`). Repositories created after
July 15, 2026 carry that format by default, organizations can opt in
fleet-wide, and GitHub documents the flag only as an opt-in with no
documented way back - so on a repository with immutable subjects, write
the trust policy against the immutable shape rather than declaring
`false` and expecting the name-based shape to return. Whichever subject
model the repository actually has is the one the policy must match.

## Private-fork PR containment

A workflow triggered by a fork's pull request runs the fork's code, and on
a private repository the settings decide what that code can
reach: whether it runs at all, whether it gets a write-capable token, and
whether secrets and variables flow into it. A contributor who can open a
pull request from a fork should not be able to exfiltrate secrets or
approve their own changes. One settings block declares the containment
posture:

```yaml settings
actions:
  default_workflow_permissions: read
  can_approve_pull_request_reviews: false
  fork_pr_contributor_approval:
    approval_policy: all_external_contributors
  fork_pr_workflows_private_repos:
    run_workflows_from_fork_pull_requests: true
    send_write_tokens_to_workflows: false
    send_secrets_and_variables: false
    require_approval_for_fork_pr_workflows: true
```

The two halves cover different surfaces. `fork_pr_contributor_approval`
decides who needs a maintainer's approval before their fork PR workflows
run (`all_external_contributors` gates everyone outside the repository; the
looser policies gate only first-time contributors, or only contributors
new to GitHub). `fork_pr_workflows_private_repos` decides what a fork PR
workflow receives once it runs: this file lets fork PRs run CI at all
(`run_workflows_from_fork_pull_requests: true`) while keeping write tokens
and secrets out of them and requiring an administrator's approval per run.
GitHub documents each approval control independently and does not document
how the two interact when both apply, so read the block as defense in
depth - every layer declared, whichever gates first - rather than as a
precise approval flow. Alongside `default_workflow_permissions: read` and
`can_approve_pull_request_reviews: false`, even a workflow that does run
holds a read-only token and cannot approve the pull request that
triggered it.

Two scope notes keep expectations honest. The
`fork_pr_workflows_private_repos` endpoint is documented for private
repositories, where private forks exist; GitHub does not document what it
answers on a public repository (the documented failure statuses are bare
denials), so in a mixed fleet this block belongs in a
`visibility: private` cohort, while public repositories rely on the
approval policy and GitHub's public-fork defaults. And all four toggles
are required on purpose: GitHub does not document whether the PUT
preserves or resets a toggle the body omits, so this action only accepts
the complete policy - which also means no toggle is ever a policy nobody
is watching.

## Trust tiers: read-only preview, gated apply

A repository secret is readable from any workflow that anyone with push
access can edit, so on a fleet admin repository the write token deserves a
higher bar than push. Split the trust in two: previews run with a
read-only PAT stored as a repository secret (as above), and the apply job
runs with the write PAT stored as an environment secret on an environment
with required reviewers, so the write token only materializes after a
human approves the run.

```yaml
name: Apply fleet settings
on:
  push:
    branches: [main]
    paths:
      - ".github/repos/**"
      - ".github/settings-defaults.yml"

permissions:
  contents: read

jobs:
  apply:
    runs-on: ubuntu-latest
    environment: settings-apply
    steps:
      - uses: actions/checkout@v7
      - uses: Vivswan/repo-settings-as-code@v1 # x-release-please-major
        with:
          token: ${{ secrets.FLEET_WRITE_TOKEN }}
          repos-dir: .github/repos
          defaults-file: .github/settings-defaults.yml
        env:
          # The step-env half of the $FLEET_WRITE_TOKEN reference in the
          # environment's declared secrets below; `with.token` only feeds the
          # action's own input, never the reference resolver.
          FLEET_WRITE_TOKEN: ${{ secrets.FLEET_WRITE_TOKEN }}
```

The gate itself is a settings section, so the admin repository's own file
declares it:

```yaml settings
environments:
  - name: settings-apply
    prevent_self_review: true
    reviewers:
      - type: Team
        id: 4501
    deployment_branch_policy:
      protected_branches: true
      custom_branch_policies: false
    secrets:
      - name: FLEET_WRITE_TOKEN
        value: $FLEET_WRITE_TOKEN
```

Reviewers take database IDs, not slugs;
`gh api /orgs/acme/teams/platform --jq .id` finds one. The bootstrap
deserves care, in order: the admin repository only manages its own
settings when it appears as a target (give it its own file, e.g.
`.github/repos/fleet-admin.yml`, declaring this environment); the
environment must exist before a job can be gated by it, so the first apply
that creates it runs ungated; `FLEET_WRITE_TOKEN` itself is declared as a
`secrets` entry on the environment above, whose `$FLEET_WRITE_TOKEN`
reference resolves from the step's `env:` block in the workflow snippet -
`with.token` alone does not expose it (see the
[secrets guide](secrets-and-vaults.md)). That reads back the same secret
the apply writes, so the FIRST apply must source it from a repository
secret (or a vault step); once the environment copy exists it overrides
the same-named repository secret automatically, and the repository secret
can be deleted. Finally, `protected_branches: true` only admits runs from
branches that carry protection, so protect `main` before enabling the
gate.

Where one write token is still too broad, the `sections` allowlist splits
it further: one job with an Issues-only PAT and `sections: labels,milestones`,
another with the Administration PAT and
`sections: repository,rulesets,collaborators`. Under the default
`on-missing-permission: fail`, a mis-scoped token already fails the run;
pair `on-missing-permission: warn` with `required-sections: rulesets` when
you want the other sections to degrade gracefully while protection stays a
hard requirement. The jobs are independently convergent, not a
transaction.

## Drift attestation for auditors

An auditor wants evidence that protection was enforced across the quarter,
not at the moment they asked. A daily check whose output is retained is
that evidence:

```yaml
name: Settings attestation
on:
  schedule:
    - cron: "41 5 * * *"
  workflow_dispatch:

permissions:
  contents: read
  issues: write

jobs:
  attest:
    runs-on: ubuntu-latest
    steps:
      - id: check
        continue-on-error: true
        uses: Vivswan/repo-settings-as-code@v1 # x-release-please-major
        with:
          token: ${{ secrets.FLEET_READ_TOKEN }}
          mode: check
          repos: "*"
          topics: production
      - name: Write the evidence record
        env:
          REPOS_RESULT: ${{ steps.check.outputs.repos-result }}
        run: |
          jq -n --argjson targets "${REPOS_RESULT:-null}" \
            '{run: env.GITHUB_RUN_ID, at: now | todate, targets: $targets}' \
            > evidence.json
      - uses: actions/upload-artifact@v4
        with:
          name: settings-attestation
          path: evidence.json
          retention-days: 90
      - if: steps.check.outputs.result != 'clean'
        env:
          GH_TOKEN: ${{ github.token }}
          GH_REPO: ${{ github.repository }}
        run: gh issue create --title "Settings drift $(date -I)" --body "See run $GITHUB_RUN_ID"
```

The reason this must be a check and not an apply is stated in the
[check mode guide](check-mode.md): apply exits 0 whether or not it changed
anything, so a green scheduled apply proves nothing about drift, while a
green scheduled check is exactly the claim the auditor needs. For a fleet
with private repositories, add `private-repos: redact` (the default) and
deliver the full detail through `private-report: artifact` with an age
key, which keeps slugs and settings out of the public run while preserving
the evidence; the README's
[Private repositories](../README.md#private-repositories) section covers
the setup.

## Access through teams, not direct collaborators

Quarterly access reviews stay manual while direct collaborator grants
accumulate. Making team rosters the only path to access turns the review
into reading one file:

```yaml settings
collaborators: []

teams:
  - name: platform
    permission: admin
  - name: payments
    permission: maintain
  - name: security-review
    permission: pull
```

An empty `collaborators` list is authoritative: apply removes every direct
collaborator (the repository owner is never touched), and team-derived
access is unaffected because the section manages direct grants only. In
check mode the same file emits one drift line per unauthorized direct
grant, which is the access review report. Two caveats complete the
picture. Undeclared collaborators are deleted under this file's plain-array
declaration (the section's default policy) while undeclared teams are
left untouched (see the [Sections table](../README.md#sections)), so a
team you stop declaring keeps its access until removed by hand. And
pending invitations are outside the section's reach: it invites new
collaborators but does not list or cancel invitations already pending, so
an old invitation can still turn into direct access later;
`gh api repos/acme/payments/invitations` is the companion audit.

## Incident freeze and unfreeze

During an incident, merges must stop in minutes and be restored just as
fast, with both directions on the record. Two profile files and one
dispatch workflow do it. The freeze:

```yaml settings
# .github/profiles/freeze.yml
_incident: INC-4471

rulesets:
  - name: incident freeze
    target: push
    enforcement: active
    rules:
      - type: file_path_restriction
        parameters:
          restricted_file_paths: ["**/*"]

interaction_limits:
  limit: collaborators_only
  expiry: one_day
```

And the recovery:

```yaml settings
# .github/profiles/recover.yml
rulesets:
  - name: incident freeze
    target: push
    enforcement: disabled
    rules:
      - type: file_path_restriction
        parameters:
          restricted_file_paths: ["**/*"]

interaction_limits: null
```

```yaml
name: Incident response
on:
  workflow_dispatch:
    inputs:
      profile:
        type: choice
        options: [freeze, recover]

permissions:
  contents: read

jobs:
  incident:
    runs-on: ubuntu-latest
    environment: incident-response
    steps:
      - uses: actions/checkout@v7
      - uses: Vivswan/repo-settings-as-code@v1 # x-release-please-major
        with:
          token: ${{ secrets.INCIDENT_TOKEN }}
          settings-file: .github/profiles/${{ inputs.profile }}.yml
```

The recovery file re-declares the same ruleset as `enforcement: disabled`
on purpose: undeclared rulesets are kept by default, so a recovery file that
simply omitted it would leave the freeze in place. The interaction limit
is the failsafe in the other direction, since it self-expires after a day
even if nobody runs the recover profile. One scope constraint: GitHub
limits push rulesets to private and internal repositories (and their fork
networks), so on a public repository this profile's brake is the
interaction limit alone; freeze a public repository with a branch ruleset
instead, targeting `~ALL` with an `update` rule. Both runs are visible
dispatches by a named actor on a gated environment: the audit trail comes
free.

## Sunset and decommission

Repositories at end of life need a defined terminal state, and archiving
has an ordering trap: settings writes fail on archived repositories, and
sections run in a fixed order with `repository` first, so a single file
that sets `archived: true` alongside other sections archives the
repository and then fails the rest. Sunset in two steps. First the
terminal state:

```yaml settings
repository:
  description: "superseded by acme/payments-v2"
  has_issues: false
  has_wiki: false

actions:
  enabled: false

interaction_limits:
  limit: collaborators_only
  expiry: six_months
```

Then, once that run is green, a file containing only the archive flag:

```yaml settings
repository:
  archived: true
```

After that, leave the repository out of managed target lists: `repos: "*"`
discovery skips archived repositories by default (`archived: skip`), and a
scheduled check with `archived: only` and `mode: check` is the audit that
the sunset fleet stays sunset.
