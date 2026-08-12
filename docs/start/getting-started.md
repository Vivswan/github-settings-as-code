# Getting started

This walkthrough takes one repository from nothing to a settings file that is
applied on every change: create the token, add the settings file and the
workflow, run check mode first, then switch to apply. What each section of
the settings file manages, and what applying it deletes or keeps, is
specified in the [README Sections table](../../README.md#sections); this page
only gets you to a first green run.

## 1. Create the token

The action authenticates with a fine-grained personal access token. Many
sections need the Administration permission, which the default workflow
`GITHUB_TOKEN` can never hold, so plan on a PAT.

The [pre-filled token form linked in the README](../../README.md#usage) starts
you off with every repository permission the Sections table can need. Pick
the resource owner and the repositories the token may touch. If the owner is
an organization and you plan to manage the `teams` section, also add the
Members organization permission at read; the form only offers organization
permissions once an organization is selected.

You can also grant less. The token only needs the permissions for the
sections your settings file declares, and
[Token permissions](../reference/permissions.md) explains which grant maps
to which section.

Save the token as a repository secret. The examples below call it
`ADMIN_TOKEN`.

## 2. Add the settings file

Settings live in `.github/settings.yml` by default (the `settings-file`
input moves it). A comment at the top wires editor autocomplete and hover
documentation to the published JSON Schema. A small first file:

```yaml settings
# yaml-language-server: $schema=https://raw.githubusercontent.com/Vivswan/github-settings-as-code/v2/lib/settings.schema.json # x-release-please-major

repository:
  description: Payments service
  has_wiki: false
  delete_branch_on_merge: true

labels:
  - name: bug
    color: "d73a4a"
    description: Something isn't working
```

Only declared keys are ever applied or compared, so everything this file
does not mention stays as it is. The exceptions are the sections the
[Sections table](../../README.md#sections) marks as deleting undeclared
entries: declaring `labels`, `autolinks`, `collaborators`,
`actions_variables`, or `agents_variables` makes the
declared list authoritative, and live entries missing from it are deleted on
apply. That is why the first run below is a check, not an apply.

## 3. Add the workflow

The action reads the settings file from the workspace, so the workflow needs
`actions/checkout` before the action step.

```yaml
# .github/workflows/settings.yml
name: Apply settings
on:
  push:
    branches: [main]
    paths: [.github/settings.yml]
  schedule:
    - cron: "23 6 * * 1"
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
          token: ${{ secrets.ADMIN_TOKEN }}
          mode: check
```

Each trigger earns its place. The push trigger runs the action on every
reviewed change to the settings file: a check while `mode: check` is set,
an apply once step 5 removes it. `workflow_dispatch` lets you run the
action by hand from the Actions tab, which is how the first run happens.
The schedule catches drift: in check mode a weekly run turns red when the
live settings diverge from the file, and after the switch to apply it
re-asserts the declared keys and reverts anything changed through the UI in
the meantime (apply is convergent, see
[Semantics](../reference/semantics.md)).

## 4. Run check mode first

`mode: check` compares the declared settings against the live repository,
makes no settings changes, and exits 1 when anything differs. Trigger the
workflow from the Actions tab. On a repository with existing labels the run
will fail with drift, and that is the point: the report lists exactly what
an apply would change or delete. The log shows one line per difference:

```text
drift: repository.description: "Payments service" != ""
drift: labels[bug].color: declared "d73a4a" != live "ee0701"; apply will set the declared value
drift: labels[wontfix]: undeclared - not in the settings file, so apply will DELETE it; add it to the settings file to keep it
```

Work through the deletions first: add the labels you want to keep to the
settings file, and leave out the ones you are happy to lose. Re-run check
until the only remaining drift is change you intend.

## 5. Switch to apply

Remove the `mode: check` line (the default is `apply`) and push, then run
the workflow once from the Actions tab: the push that edits only the
workflow file does not match the `paths` filter, so the first apply is a
manual dispatch. From then on every push that touches
`.github/settings.yml` applies it, and the
scheduled run keeps the repository converged. In apply mode the log shows
what was written instead:

```text
labels: created label "bug"
labels: DELETED undeclared label "wontfix"
result: applied
```

To keep a permanent drift-report workflow alongside the applying one, see
the [check mode guide](../operate/check-mode.md).

## 6. Reading the output

Three surfaces carry the result. The log holds the per-drift and per-change
lines shown above; a run that succeeds or finds drift ends in a
`result:` line naming the outcome (`applied`, `clean`, `drift`, or
`partial`), while a failing single-repo run stops at its error annotation
instead (the `result` output still reads `failed`). The step summary renders a table with
one row per declared section: its status plus the same detail lines, so you
rarely need to open the log at all. Annotations surface problems on the run
page: errors carry the GitHub API's message verbatim plus the fix, warnings
mark sections skipped under `on-missing-permission: warn`, and notices
carry advisory notes (for example that `enable_git_lfs` is write-only, so
check mode cannot verify it).

The action also sets a `result` output for downstream steps; the
[README Inputs table](../../README.md#inputs) documents it alongside every
input.

## Where to go next

The [examples cookbook](examples.md) has a full-featured settings file and
the null semantics. [Multi-repo mode](../operate/multi-repo.md) scales this setup from
one repository to a fleet. When a run fails,
[troubleshooting](../operate/troubleshooting.md) covers the common failure shapes.
