# Check mode

`mode: check` runs the whole pipeline read-only. Each declared section reads the live state and reports how it differs from the settings file instead of writing anything. The same declared-keys-only rule as apply holds: a key you do not declare is never compared (see [Semantics](../reference/semantics.md)). Check mode changes no settings; the one write it can still perform is delivery of a private report when the `private-report` input is enabled. The issue channels update a marker-labelled issue on the target (`issue` on every run, `issue-on-failure` only to open it on failure or drift, or close it on recovery), and on their first delivery that writes - which for `issue-on-failure` means the first drifting run, never a healthy one - they create that marker label; the artifact channel uploads an encrypted artifact. None of them touches anything else (see the [private repositories guide](private-repositories.md)).

## Exit behavior

The step's exit code carries the verdict, and the `result` output names it:

- No drift anywhere ends with `result: clean` and exit 0.
- Any drift ends with `result: drift` and exit 1, so a scheduled check turns red the moment reality diverges from the file.
- A section error (a permission denial under the default `on-missing-permission: fail`, or any non-permission API error) marks that section failed and the run failed, exit 1.
- Under `on-missing-permission: warn`, a section the token cannot access is skipped with a warning annotation; if nothing else drifts, the run ends `partial` with exit 0.

Apply mode behaves differently on purpose: `mode: apply` exits 0 whether or not it changed anything (`result: applied` covers both), and only a failure exits 1. A green scheduled apply therefore says nothing about whether settings had drifted; a green scheduled check does. In multi-repo mode the worst result across all targets decides the exit code, so one drifted target fails the whole check run (see [multi-repo mode](multi-repo.md)).

## A scheduled check

Drift detection is most useful on a timer, so a manual change in the GitHub UI turns a workflow red within a day instead of surfacing months later:

```yaml
name: Settings drift check
on:
  schedule:
    - cron: "17 6 * * *"
  workflow_dispatch:

permissions:
  contents: read

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: Vivswan/github-settings-as-code@v2 # x-release-please-major
        with:
          token: ${{ secrets.ADMIN_TOKEN }}
          mode: check
```

The checkout step matters: in single-repo mode the settings file is read from the working tree. The `workflow_dispatch` trigger lets you run the check on demand from the Actions tab, which is also the way to re-verify right after fixing drift.

## Checking settings changes on pull requests

Because the settings file comes from the checkout, a `pull_request` workflow checks the proposed version of the file against the live repository:

```yaml
name: Preview settings changes
on:
  pull_request:
    paths: [.github/settings.yml]

permissions:
  contents: read

jobs:
  preview:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: Vivswan/github-settings-as-code@v2 # x-release-please-major
        with:
          token: ${{ secrets.ADMIN_TOKEN }}
          mode: check
```

Read this run as a preview, not a gate. A pull request that changes settings is supposed to differ from the live state, so the step exits 1 exactly when the PR changes something check can verify, and the drift lines list the changes an apply on merge will make. The comparison is the proposed file against the live repository, not against the base branch, so drift that existed before the PR shows up too; that is still the true apply-on-merge delta, but not every line is caused by the PR. Verifiable is the other operative word: write-only values (the LFS toggle, the interaction-limit expiry) are re-asserted by every apply without ever drifting a check, and a ruleset entry that declares fewer fields than the live ruleset carries can narrow it on apply without showing drift, because only declared fields are compared. A broken file still fails usefully: YAML parse errors and malformed section entries fail the run before any comparison. Two caveats: do not make this a required check (a legitimate settings change would be unmergeable), and workflows triggered by pull requests from forks run without secrets, so the token is only available on same-repository branches.

One token note for this workflow. Repository secrets are readable from any workflow a push-access user can edit, so wiring `ADMIN_TOKEN` into a `pull_request` job widens where the write-capable token gets used, even though it grants nothing a pusher could not already reach. Check mode only reads, so the preview works with a second fine-grained PAT whose grants are read-only (with one exception: GitHub gates even the Codespaces secrets reads at write, so drop `codespaces_secrets` from the preview or grant it); on repositories where settings changes are more restricted than push access, give the preview that token instead.

## What a "cannot verify" note means

Some declared values have no read-back on GitHub's side, so check mode cannot compare them with anything. Those surface as notice annotations rather than drift, and each note says what apply does about it:

- Write-only repository toggles - today `repository.enable_git_lfs`: GitHub offers no endpoint that reports the state, so apply re-asserts the declared value on every run.
- The whole `check_suite_preferences` section: GitHub exposes no read endpoint for check suite preferences, so check mode issues no request at all for it and apply re-asserts the declared preferences on every run.
- `interaction_limits.expiry`: GitHub accepts a duration but reads back only the computed `expires_at` timestamp, so apply re-arms the limit on every run.
- `webhooks[].config.secret`: GitHub echoes a live secret as `********`, so apply re-sends the declared secret on every run (rotations propagate).
- Secret values in all five secret families (`actions_secrets`, `dependabot_secrets`, `codespaces_secrets`, `agents_secrets`, and per-environment `secrets`): the API returns names only, so check mode verifies existence and apply re-seals and rewrites every declared value on each run. One note per family (or per environment), not per entry.
- `environments[].variables`, `environments[].secrets`, `environments[].deployment_branch_policies`, and `environments[].deployment_protection_rules` declared on an environment that does not exist yet: nothing can be listed until apply creates the environment, and the missing environment itself is already drift.
- `environments[].deployment_branch_policies` declared on a LIVE environment whose `deployment_branch_policy` does not enable `custom_branch_policies`: the patterns cannot be listed until apply turns the flag on, so the declared list surfaces as a note - while the flag mismatch itself is reported as ordinary environment drift.

A note is not drift and not a failure. A section whose only findings are notes counts as clean, and the notes appear in that section's detail cell in the step summary. The [secrets guide](../reference/secrets-and-vaults.md) goes deeper on what check mode can and cannot promise for secret material.

## Where the output lands

A check run reports through three channels:

- The run log carries one `drift:` line per difference, naming the section, the field path, and the declared versus live values. In multi-repo mode each line is prefixed with the target's slug.
- Annotations carry what needs attention at a glance: notices for section notes (including the "cannot verify" ones), warnings for permission skips under `on-missing-permission: warn`, and errors for failures.
- The step summary renders a table with each section's status and detail; multi-repo runs get a fleet rollup table plus one section table per target.

For a redacted private target the public surfaces show only section statuses, and the full detail travels over the `private-report` channel; the [private repositories guide](private-repositories.md) explains both.
