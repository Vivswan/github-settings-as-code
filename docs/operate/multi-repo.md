---
order: 220
---

# Multi-repo mode

One workflow in an admin repository can manage settings for a whole fleet, in the spirit of [safe-settings](https://github.com/github-community-projects/safe-settings) but without a hosted app. This page owns the rules of that mode - the two sourcing modes and their precedence, the discovery filters, and the defaults fallback - and walks through choosing targets, covering repositories that have no settings file, and one worked fleet pattern.

## How targets are chosen

Two sourcing modes exist, and one run can use both:

- `repos-dir` names a directory in the checked-out admin repository holding one settings file per target. A file named `payments.yml` targets the `payments` repository under the admin repo's own owner; a file at `other-org/payments.yml` targets a repository under another owner. This mode needs `actions/checkout`, because the files are read from disk.
- `repos` lists `owner/name` targets directly, comma- or newline-separated. Each of these is applied from its own `.github/settings.yml` on its default branch. `repos: "*"` alone discovers every repository the token's user owns (needs a user PAT; the workflow `GITHUB_TOKEN` cannot enumerate), filtered by the six discovery inputs described below.

When the same repository appears in both, the repos-dir file wins and the run says so with a notice. The checked-in file is the curated, code-reviewed source of truth; a target's own settings.yml is self-service. A `repos` target whose repository has no `.github/settings.yml` on its default branch is skipped with a notice, not failed, unless a `defaults-file` stands in for it (see [the fallback](#fallback-for-repositories-without-a-settings-file) below).

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
      - uses: Vivswan/github-settings-as-code@v2 # x-release-please-major
        with:
          token: ${{ secrets.FLEET_TOKEN }}
          repos-dir: .github/repos
          defaults-file: .github/settings-defaults.yml
          repos: |
            other-org/service-a
            other-org/service-b
```

Targets run independently and sequentially. One repository's failure never stops the rest; the run exits 1 at the end if any target failed (or drifted, in check mode). The step summary shows a fleet rollup table plus one section table per target, and the `repos-result` output carries the per-repo results as JSON.

The `sections` and `required-sections` inputs apply to all targets alike, and the token needs the same per-section permissions (see the [Sections table](../reference/sections.md)) on every target repository.

## Discovery filters

Discovery takes six filter inputs that apply only to `repos: "*"`; setting any of them in another mode fails the run. Repositories a filter drops are reported in one aggregate notice per reason.

- `visibility` keeps public, private, or internal repositories.
- `archived` defaults to `skip`, because settings writes fail on archived repositories; `archived: only` is mostly useful with `mode: check`.
- `forks` includes, excludes, or keeps only forks.
- `topics` keeps repositories carrying at least one listed topic, so a single marker topic can opt repositories in.
- `exclude` takes wildcard patterns where `*` matches anything: a pattern containing `/` is matched against the full `owner/name`, any other against the name alone, case-insensitively.
- `affiliation` selects which relationships to the token's user qualify: `owner` (the default), `collaborator`, or `organization_member`. The list replaces the default, so widening discovery beyond owned repositories takes `owner,collaborator`.

## Fallback for repositories without a settings file

`defaults-file` names a YAML settings document that stands in for a target's missing settings file. It is a fallback, not a layer: nothing is merged, and a target that has a file never sees the defaults.

| Target | What the run applies |
|---|---|
| has `.github/settings.yml` (or a repos-dir file) | that file, as written; the defaults are ignored |
| proven to have no settings file | the defaults document, whole |
| file unreadable (the token lacks Contents: read, or the default branch has no commit yet) | nothing; the target fails, naming both causes |

Absence is proven, not assumed: after the file read returns 404 the run reads the default branch ref, which needs Contents: read and succeeds whether or not the file exists. A target applied from the defaults prints this notice in check mode and apply mode alike:

```text
applying the defaults file: the repository has no .github/settings.yml on its default branch
```

Say the defaults file declares the house rules:

```yaml settings
repository:
  has_wiki: false
  delete_branch_on_merge: true
labels:
  - name: bug
    color: "d73a4a"
```

and two targets are in the run:

- `payments` has no settings file: it receives the document above, exactly.
- `billing` has its own file declaring only `repository: {description: Billing service}`: that is all that is applied to it. Its wiki flag and its labels are not touched, because its file does not declare them.

The blast radius is the discovery set. With `repos: "*"`, every discovered repository proven to have no settings file receives the defaults, so before the first apply run `mode: check` and read the report: the notice above names each repository that would take the defaults.

Layering documents, where a fleet file is merged under each target's own, is `mode: merge`'s job and is described in the [layering guide](layering.md).

## Fleet pattern: disabling Actions on satellite repositories

An admin repository that runs all automation centrally may want GitHub Actions off everywhere else. Putting this in each satellite's file (or in the defaults file, for satellites without one) does that:

```yaml settings
actions:
  enabled: false
```

Applying it turns Actions off in the target repository entirely; no workflow there runs until Actions is enabled again. Two cautions come with it.

- Any other base Actions permission key implies `enabled: true` unless you say otherwise, so a file that sets `allowed_actions` without `enabled` re-enables Actions on its target.
- If the admin repository itself is a target (a repos-dir file named after it, or its slug in `repos`) and its applied document carries this block, the apply disables Actions in the admin repository too. That kills the very workflow that runs this action, and no later run can undo it, because no later run happens.

Recovery from the second is manual: re-enable Actions in the repository's settings UI, or call `PUT /repos/{owner}/{repo}/actions/permissions` yourself. To prevent it, keep the admin repository out of the target list, or give it a settings file of its own without this block: a repository with a file never receives the defaults.

## Private repositories in the fleet

When a public admin repository manages private targets, the default `private-repos: redact` hides their slugs and details from the run's public logs, summary, and outputs, and the `private-report` input can deliver each target's full report over a private channel; the [private repositories guide](private-repositories.md) covers what is hidden, what stays visible, and how to read the full detail.
