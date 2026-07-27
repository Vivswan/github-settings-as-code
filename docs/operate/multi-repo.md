# Multi-repo mode

One workflow in an admin repository can manage settings for a whole fleet.
This page walks through choosing targets, layering a defaults file, opting a
single repository out, and one worked fleet pattern. The normative rules (the
input semantics, the discovery filters, precedence) live in the README's
[Multi-repo mode](../../README.md#multi-repo-mode) section; this page shows how
the pieces fit together in practice.

## How targets are chosen

Two sourcing modes exist, and one run can use both:

- `repos-dir` names a directory in the checked-out admin repository holding
  one settings file per target. A file named `payments.yml` targets the
  `payments` repository under the admin repo's own owner; a file at
  `other-org/payments.yml` targets a repository under another owner. This
  mode needs `actions/checkout`, because the files are read from disk.
- `repos` lists `owner/name` targets directly, comma- or newline-separated.
  Each of these is applied from its own `.github/settings.yml` on its default
  branch. `repos: "*"` alone discovers every repository the token's user
  owns by default (the `affiliation` input widens or moves discovery to
  collaborator or organization repositories), filtered by the
  `visibility`, `archived`, `forks`, `exclude`, and `topics` inputs
  described in the [README](../../README.md#multi-repo-mode).

When the same repository appears in both, the repos-dir file wins and the run
says so with a notice. The checked-in file is the curated, code-reviewed
source of truth; a target's own settings.yml is self-service. A `repos`
target whose repository has no `.github/settings.yml` on its default branch
is skipped with a notice, not failed.

A fleet workflow combining both modes:

```yaml
name: Fleet settings
on:
  push:
    branches: [main]
    paths:
      - ".github/repos/**"
      - ".github/settings-defaults.yml"
  workflow_dispatch:

permissions:
  contents: read

jobs:
  apply:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: Vivswan/repo-settings-as-code@v1 # x-release-please-major
        with:
          token: ${{ secrets.FLEET_TOKEN }}
          repos-dir: .github/repos
          defaults-file: .github/settings-defaults.yml
          repos: |
            other-org/service-a
            other-org/service-b
```

Targets run independently and sequentially. One repository's failure never
stops the rest; the run exits 1 at the end if any target failed (or drifted,
in check mode). The step summary shows a fleet rollup table plus one section
table per target, and the `repos-result` output carries the per-repo results
as JSON.

## Layering a defaults file

`defaults-file` names a YAML settings document merged under every processed
target's settings, with the target's keys winning (a repository with no
settings file is skipped before the merge, defaults included). Objects
merge recursively, key by
key. Arrays and scalars replace wholesale; the merge never concatenates
lists.

Say the defaults file declares the house rules:

```yaml settings
repository:
  has_wiki: false
  delete_branch_on_merge: true
labels:
  - name: bug
    color: "d73a4a"
```

and one target's file says:

```yaml settings
repository:
  description: Payments service
  has_wiki: true
labels:
  - name: incident
    color: "b60205"
```

The document applied to that target is:

```yaml settings
repository:
  description: Payments service
  has_wiki: true
  delete_branch_on_merge: true
labels:
  - name: incident
    color: "b60205"
```

The two `repository` objects merged: the target's `description` and
`has_wiki` sit alongside the defaults' `delete_branch_on_merge`, and where
both declared `has_wiki` the target won. The two `labels` arrays did not
merge: the target's list replaced the defaults' list, so `bug` is not
declared for this repository at all. Since the labels section deletes
undeclared labels by default, a target that wants the fleet labels plus its
own must repeat the fleet labels in its list. The alternative is the
[undeclared policy](../concepts/undeclared-policy.md): a defaults file declaring
`labels: {undeclared: keep, entries: [...]}` hands every target the keep
policy, so a target that declares only its own labels leaves the fleet
labels (and any others) in place instead of deleting them - unmanaged, but
kept.

## null as an opt-out

A target sets a top-level section to `null` to opt out of a section the
defaults file declares. The section is stripped from the merged document, so
the engine never touches that section on this repository, and the run emits a
notice naming the opt-out.

Suppose the defaults file configures GitHub Pages fleet-wide. A target that
manages its own Pages site by hand opts out with:

```yaml settings
pages: null
```

The two meanings of `null` are easy to confuse, so the rule is worth stating
twice. When the defaults file declares the section with a non-null value, a
target's `null` means "leave this section of this repository alone", and the
null is stripped before validation, so this works for every section. When
the defaults do not declare it, the `null` passes through to the engine,
where only some sections give it a meaning of its own: `pages: null` then
disables the Pages site, and `interaction_limits: null` clears a live
limit, while a section without null semantics (such as `actions`) rejects
it as a validation error. The
[README](../../README.md#multi-repo-mode) states the normative rule.

## Fleet pattern: disabling Actions on satellite repositories

An admin repository that runs all automation centrally may want GitHub
Actions off everywhere else. Putting this in the defaults file (or in each
satellite's file) does that:

```yaml settings
actions:
  enabled: false
```

Applying it turns Actions off in the target repository entirely; no workflow
there runs until Actions is enabled again. Two cautions come with it. First,
declaring any other base Actions permission key implies `enabled: true`
unless you say otherwise, so a defaults file that sets `allowed_actions`
without `enabled` re-enables Actions on targets. Second, if the admin
repository itself is a target (a repos-dir file named after it, or its slug
in `repos`), the apply disables Actions in the admin repository too, which
kills the very workflow that runs this action. No later run can undo it,
because no later run happens. Recovery is manual: re-enable Actions in the
repository's settings UI, or call `PUT /repos/{owner}/{repo}/actions/permissions`
yourself. Keep the admin repository out of the target list, or give it a
per-repo file with `actions: null` to opt out of the defaults' actions
section.

## Private repositories in the fleet

When a public admin repository manages private targets, the default
`private-repos: redact` hides their slugs and details from the run's public
logs, summary, and outputs, and the `private-report` input can deliver each
target's full report over a private channel; the README's
[Private repositories](../../README.md#private-repositories) section covers
what is hidden, what stays visible, and how to read the full detail.
