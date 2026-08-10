# Examples

A cookbook of settings.yml files. Every settings example on this page runs
through the real document validation in CI, so the shapes stay current. What
each section manages, which token permission it needs, and whether its
undeclared entries are deleted or kept is specified in the
[README Sections table](../../README.md#sections); the cross-section rules live
under [Semantics](../reference/semantics.md). This page shows shapes, not
behavior.

One rule frames everything below: only declared keys are applied or
compared. A section, or a field inside one, that the file does not mention
is never touched. The rule has edges worth knowing. Some list entries are
one full payload: a declared ruleset is applied with a full-payload PUT,
so a partial ruleset entry silently narrows the live one; declare each
ruleset completely. Labels and milestones work the other way: only the
fields you declare are sent, so an omitted description or state is left
alone. And two sections bend the rule where the API forces their hand, as
the [Sections table](../../README.md#sections) notes: inside a declared
`protection` object the classic API requires all four core keys, so apply
fills the ones you omit with `null` (see
[Classic branch protection](#classic-branch-protection) below), and in the
`actions` section, declaring any base permissions key (or
`selected_actions`, which infers `allowed_actions: selected`) makes the
base PUT carry `enabled: true` unless the file says otherwise, while
retention-, cache-, workflow-token-, or access-only declarations leave the
base policy alone.

## A minimal file

Enough to be useful on day one: a few repository fields and the labels you
actually triage with.

```yaml settings
repository:
  description: Payments service
  topics: payments, service
  has_wiki: false
  delete_branch_on_merge: true

labels:
  - name: bug
    color: "d73a4a"
    description: Something isn't working
  - name: needs-triage
    color: "ededed"
```

## A full-featured file

A single-repo file exercising most sections. `topics` accepts a
comma-separated string or a YAML list, and `enable_*` keys are feature
toggles the section routes to their own endpoints; everything else under
`repository` goes to the API verbatim.

```yaml settings
repository:
  description: Payments service
  homepage: https://payments.example.com
  topics: payments, service, production
  has_wiki: false
  has_projects: false
  allow_merge_commit: false
  allow_squash_merge: true
  squash_merge_commit_title: PR_TITLE
  delete_branch_on_merge: true
  enable_vulnerability_alerts: true
  enable_automated_security_fixes: true

labels:
  - name: bug
    color: "d73a4a"
    description: Something isn't working
  - name: prio
    new_name: priority-high
    color: "b60205"

rulesets:
  - name: protect main
    target: branch
    enforcement: active
    conditions:
      ref_name:
        include: ["~DEFAULT_BRANCH"]
        exclude: []
    rules:
      - type: deletion
      - type: non_fast_forward
      - type: pull_request
        parameters:
          required_approving_review_count: 1
          dismiss_stale_reviews_on_push: true
          require_code_owner_review: false
          require_last_push_approval: false
          required_review_thread_resolution: true
  - name: release tags
    target: tag
    enforcement: active
    conditions:
      ref_name:
        include: ["refs/tags/v*"]
        exclude: []
    rules:
      - type: deletion
      - type: update

environments:
  - name: production
    pinned: true
    wait_timer: 30
    prevent_self_review: true
    reviewers:
      - type: Team
        id: 4501
    deployment_branch_policy:
      protected_branches: false
      custom_branch_policies: true
    deployment_branch_policies:
      - name: release/*
      - name: v*
        type: tag
    deployment_protection_rules:
      - app: my-gate-app
    variables:
      - name: DEPLOY_REGION
        value: eu-west-1
    secrets:
      - name: PROD_DEPLOY_KEY
        value: $PROD_DEPLOY_KEY

autolinks:
  - key_prefix: "TICKET-"
    url_template: "https://example.atlassian.net/browse/TICKET-<num>"

actions:
  enabled: true
  allowed_actions: selected
  selected_actions:
    github_owned_allowed: true
    verified_allowed: false
    patterns_allowed:
      - Vivswan/*
  default_workflow_permissions: read
  can_approve_pull_request_reviews: false
  artifact_and_log_retention:
    days: 30
  cache:
    max_cache_retention_days: 7

actions_variables:
  - name: DEPLOY_REGION
    value: us-east-1

actions_secrets:
  - name: DEPLOY_TOKEN
    value: $DEPLOY_TOKEN

dependabot_secrets:
  - name: REGISTRY_TOKEN
    value: $REGISTRY_TOKEN

codespaces_secrets:
  - name: DEVCONTAINER_PAT
    value: $DEVCONTAINER_PAT

agents_secrets:
  - name: AGENT_TOKEN
    value: $AGENT_TOKEN

agents_variables:
  - name: AGENT_MODEL
    value: default

webhooks:
  - config:
      url: https://ci.example.com/hook
      content_type: json
      secret: $HOOK_SECRET
    events: [push, pull_request]
    active: true

workflows:
  - path: nightly-sync.yml
    state: disabled

check_suite_preferences:
  auto_trigger_checks:
    - app_id: 12345
      setting: false

pages:
  build_type: workflow

code_scanning_default_setup:
  state: configured
  query_suite: default

code_quality_setup:
  state: configured
  languages: [go, python]

collaborators:
  - username: octocat
    permission: push

deploy_keys:
  - title: deploy-bot
    key: ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIB5n2eXAMPLEeXAMPLEeXAMPLEeXAMPLEeXAMPLEeXAM deploy@example
    read_only: true

teams:
  - name: platform
    permission: maintain

milestones:
  - title: v2.0
    description: The big rewrite
    state: open

interaction_limits:
  limit: collaborators_only
  expiry: one_week
  pull_request_creation_cap:
    enabled: true
    max_open_pull_requests: 5
  pull_request_creation_bypass: [octocat, hubot]

custom_properties:
  - property_name: team
    value: payments
  - property_name: compliance
    value: [soc2, pci]
  - property_name: pilot
    value: true

secret_scanning_custom_patterns:
  - name: Internal API token
    pattern: "int_[a-z0-9]{32}"
    start_delimiter: '\b'
```

In `rulesets`, short ref names are auto-prefixed (`staging` becomes
`refs/heads/staging`) and `~DEFAULT_BRANCH` passes through; rule parameters
go to the API verbatim, so rule types GitHub ships tomorrow work unchanged
(see [Forward compatibility](../reference/forward-compatibility.md)).
`custom_properties` sets values for properties the organization has already
defined (a `value: null` unsets one), so it applies to org-owned
repositories only - on a personal account the section skips with a note.

## Classic branch protection

`branches` is the classic per-branch protection API, kept for Probot
compatibility; rulesets are the modern replacement. The declared
`protection` object is the PUT payload, with one adjustment: the classic
API rejects a payload missing any of its four core keys
(`required_status_checks`, `enforce_admins`,
`required_pull_request_reviews`, `restrictions`), so apply fills omitted
core keys with `null`. A `null` there means "off", so an omitted
`enforce_admins` is turned off, not left alone; declare every core key you
want to keep, and check mode reports an omitted-but-live core key as drift
before an apply would null it away.

```yaml settings
branches:
  - name: main
    protection:
      required_pull_request_reviews:
        required_approving_review_count: 1
      enforce_admins: true
      required_status_checks:
        strict: true
        contexts: [all-green]
      restrictions: null
```

Two protection surfaces the REST API cannot express ride GraphQL under the
hood, declared as ordinary keys: `force_push_bypassers` lists who may force
push (a bare login is a user, `org/team-slug` a team, `app/slug` a GitHub
App), and `required_deployments` requires deployments to the named
environments before merging (`null` turns the requirement off; declare the
environments in the same file - the `environments` section applies first).
An entry whose name is a wildcard pattern (`release/*`) is a classic RULE
rather than a branch: it reconciles entirely through GraphQL and its
protection accepts only the keys with exact GraphQL equivalents, so prefer
rulesets for new pattern-based configuration.

```yaml settings
environments:
  - name: production
branches:
  - name: main
    protection:
      enforce_admins: true
      force_push_bypassers: [octocat, my-org/release-team, app/deploy-bot]
      required_deployments:
        environments: [production]
  - name: release/*
    protection:
      required_linear_history: true
      required_status_checks:
        strict: true
        contexts: [all-green]
```

## What null means

For most sections, leaving a key out means "do not touch it". Three
resource-level declarations give an explicit `null` a meaning of its own.

`pages: null` declares the Pages site off. Apply deletes an existing site;
an absent `pages` key leaves the site alone.

```yaml settings
pages: null
```

`interaction_limits: null` clears an active repository-level interaction
limit - the base limit only; the pull request creation cap and its bypass
list are separate resources a `null` never touches. An absent key leaves
whatever limit is live untouched.

```yaml settings
interaction_limits: null
```

`protection: null` on a branch declares it unprotected, and apply removes
existing classic protection.

```yaml settings
branches:
  - name: legacy
    protection: null
```

Under a multi-repo defaults file, a target's `null` section can instead mean
"opt out of the defaults for this repository"; the rules for that merge are
in the [multi-repo guide](../operate/multi-repo.md). A few individual fields
accept `null` as a value of their own too, such as `pages.cname` to remove
a custom domain; the [published schema](../../lib/settings.schema.json) marks
those.

## Private notes

Unknown top-level sections are hard errors, so a typo cannot silently do
nothing (the one exception: under a `sections` allowlist, unknown keys
outside the allowlist warn instead of failing, which eases version skew;
the [troubleshooting guide](../operate/troubleshooting.md) covers it). Keys starting
with an underscore are the escape hatch: they are ignored, which makes
them usable as private notes.

```yaml settings
_owner: platform-team, see runbook RB-112

labels:
  - name: bug
    color: "d73a4a"
```

## Where to go next

[Check mode](../operate/check-mode.md) is the safe way to try any of these files
against a real repository before applying. [Multi-repo mode](../operate/multi-repo.md)
reuses the same documents across a fleet, and
[the undeclared policy](../reference/undeclared-policy.md) explains what happens
to live resources these files do not declare, and the `undeclared` knob
that changes it.
