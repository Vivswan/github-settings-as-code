# Migrating from the Probot Settings app

This page walks through moving a repository from the
[Probot Settings app](https://github.com/repository-settings/app) to this
action. The short version, and the claim the contract tests pin, is the
[README's migration paragraph](../../README.md#migrating-from-the-probot-settings-app);
the full side-by-side comparison sits right next to it, under
[Compared to the Probot Settings app](../../README.md#compared-to-the-probot-settings-app).
If this page and the README ever disagree, the README wins. What this page
adds is the walkthrough: what to expect, in what order to do things, and
how to read the first check run.

## Why migrate

The app applies settings from a hosted GitHub App installation, and when
something goes wrong it does nothing: there is no run log a repository owner
can open, so a misconfigured or uninstalled app looks exactly like a healthy
one. This action is a step in your own workflow instead. Every apply is a
visible run with a log, annotations, a step summary, and a red X on failure,
and `mode: check` reports drift between the file and the live
repository without changing any settings. On top of that you get rulesets, a
partial-success policy, a token you scope yourself, and per-call debug
tracing. The
[comparison table in the README](../../README.md#compared-to-the-probot-settings-app)
lists the differences one by one.

## What carries over as-is

Your existing settings.yml keeps working for `repository`, `labels`,
`branches`, `collaborators`, `teams`, and `milestones`: their original
Probot shapes remain compatible, including label renames via `new_name` and
`protection: null` to remove branch protection. For the list sections among
them the compatible shape is the plain array - the wrapped
`{undeclared, entries}` form is this action's own extension on top. The
[README's migration paragraph](../../README.md#migrating-from-the-probot-settings-app)
is the pinned statement of this parity. The sections outside that list
(`rulesets`, `autolinks`, `actions`, `workflows`, `pages`,
`code_scanning_default_setup`, and the rest) are not covered by the parity
guarantee; the check run below tells you whether such a section validates
as-is.

## What changed on purpose

The delivery model is a workflow plus a fine-grained PAT, not an app
installation. You mint the token, scope it to exactly the sections your file
declares, and save it as a repository secret; permission errors name the
exact grant to add. See [Token permissions](../reference/permissions.md).

Failures are loud. An unknown top-level key in the settings file is a hard
error, not a silent no-op, because a misspelled section that quietly did
nothing is the app's failure mode this action exists to replace. Prefix a
deliberate private key with an underscore to keep notes in the file. The
closed sections also reject entry keys they do not recognize: in
`collaborators` and `teams` a misspelled `permission` key would silently
grant the default role, and in `workflows` the enable/disable calls send
no payload, so an unrecognized key would silently do nothing.
[Forward compatibility](../reference/forward-compatibility.md) lists the
full closed set.

The engine is stateless. There is no state file and nothing is stored
between runs; resources are matched by their natural names, and only declared
keys are ever applied or compared. Removing a section from the file stops
managing it; it does not revert anything.

Rulesets are first class. Your `branches` section keeps working, and you can
optionally move protection to `rulesets`, which cover branch, tag, and push
targets. Undeclared rulesets are kept by default - deleting them is an
explicit opt-in (`undeclared: delete`), so removing protection stays a
deliberate action.

Deletions still exist where the app had them: undeclared labels are deleted
by default (Probot parity), and so are undeclared autolinks, collaborators,
Actions variables, and Copilot agents variables - plus, within a declared
per-environment key, that
environment's variables and deployment branch-policy patterns. Nothing else
is ever deleted implicitly; the README's
[Sections table](../../README.md#sections) states each section's default in
its Undeclared default column, and the check run lists everything an apply
would delete before you let it.

## Step by step

1. Keep your existing `.github/settings.yml` where it is. The default
   `settings-file` input reads the same path the app did.
2. Uninstall the Probot Settings app, so two writers do not race on the same
   settings.
3. Create a fine-grained PAT and save it as a repository secret. Grant only
   the permissions for the sections your file declares; the
   [getting started guide](getting-started.md) walks through this.
4. Add the workflow with `mode: check` for the first run:

```yaml
# .github/workflows/settings.yml
name: Apply Settings
on:
  push:
    branches: [main]
    paths: [.github/settings.yml]
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

5. Run it once from the Actions tab (workflow_dispatch) and read the output.
   You will see two kinds of findings: validation errors, which reject the
   file before any section runs, and drift lines, which list each difference
   between the file and the live repository, including anything an apply
   would delete.
6. Fix the file section by section and re-run check until the findings are
   only changes you intend.
7. Remove `mode: check`. From then on every push that touches the settings
   file applies it.

### A worked fix

Suppose the old file carries a misspelled entry key in `collaborators`, say
`permision: maintain`. The check run fails during upfront validation, before
any section has touched the repository, with a message naming the entry:
`collaborators[octocat]: declares "permision", which this section does not
recognize (known keys: username, permission)`. The message also says what the
typo would have done silently: granted the default `push` role instead of the
intended one. The fix is the spelling:

```yaml settings
collaborators:
  - username: octocat
    permission: maintain
```

Re-run check. Once the report is clean, or shows only the drift you expect,
switch to apply.

## Organization-wide configuration

The app's `extends` inheritance, where repositories pull shared settings from
an org settings repository, maps to this action's multi-repo mode: one admin
repository applies a `defaults-file` merged under per-repo files
(`repos-dir`) or under each repository's own settings.yml (`repos`), with no
hosted app in the loop. The
[multi-repo guide](../operate/multi-repo.md) owns the rules and the
walkthrough.

## At org scale: the shadow run

An organization with two hundred repositories should not migrate them one
at a time, and should not uninstall the app on faith. Run this action in
the app's shadow first:

1. Inventory the existing files into a `repos-dir`: each repository's
   `.github/settings.yml` copied to `.github/repos/<name>.yml` in the admin
   repository (a `gh api` loop over the repo list does it in one pass).
2. Run the whole directory in `mode: check` while the app is still
   installed. Validation errors surface before any section runs, so one
   fleet check finds every misspelled key in every file at once.
3. Read the results. A clean target means this action and the app agree on
   that repository; drift means either the app was not actually enforcing
   the file or the file uses something outside the
   [parity set](../../README.md#migrating-from-the-probot-settings-app). Fix
   files until the remaining drift is intended.
4. Uninstall the app, then flip cohorts to apply in stages rather than all
   at once; the [playbooks](../playbooks/README.md) page shows a
   ring-based rollout that fits here directly.

Two writers must never race on the same settings, so the uninstall in step
4 comes before the first apply, and the check-only shadow period is what
makes that safe.
