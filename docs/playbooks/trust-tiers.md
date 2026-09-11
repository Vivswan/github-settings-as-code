---
order: 360
---

# Trust tiers: read-only preview, gated apply

A repository secret is readable from any workflow that anyone with push access can edit, so on a fleet admin repository the write token deserves a higher bar than push. Split the trust in three tiers:

| Tier | Job | Credential |
|---|---|---|
| Merge | Fold each repository's layers into its merged document | None: `mode: merge` reads local files only |
| Preview | `mode: check` over the merged documents on pull requests, as in [Preview the blast radius](preview-blast-radius.md) | A read-only PAT stored as a repository secret |
| Apply | `mode: apply` over the same merged documents on `main` | The write PAT stored as an environment secret, released only after a human approves the run |

The apply workflow: `plan` lists the files in the flat `.github/repos/` directory, the merge job runs outside the gated environment, and the apply job inside it, so the write token only materializes after approval and never sits in a job that also computes anything. The `plan` and `merge` jobs are the ones from [Preview the blast radius](preview-blast-radius.md), with the same 256-job matrix cap: past 256 files, split the directory by cohort into copies of this workflow.

```yaml
name: Apply fleet settings
on:
  push:
    branches: [main]
    paths: [".github/settings/**", ".github/repos/**"]

permissions:
  contents: read

jobs:
  plan:
    runs-on: ubuntu-latest
    outputs:
      repos: ${{ steps.list.outputs.repos }}
    steps:
      - uses: actions/checkout@v7
      - id: list
        run: |
          echo "repos=$(find .github/repos -maxdepth 1 -name '*.yml' | sed -E 's#.*/(.+)\.yml$#\1#' | jq -Rsc 'split("\n") | map(select(. != ""))')" >> "$GITHUB_OUTPUT"

  merge:
    needs: plan
    runs-on: ubuntu-latest
    strategy:
      matrix:
        repo: ${{ fromJSON(needs.plan.outputs.repos) }}
    steps:
      - uses: actions/checkout@v7
      - uses: Vivswan/github-settings-as-code@v2 # x-release-please-major
        with:
          mode: merge
          settings-file: |
            .github/settings/baseline.yml
            .github/repos/${{ matrix.repo }}.yml
          merged-file: merged/${{ matrix.repo }}.yml
      - uses: actions/upload-artifact@v4
        with:
          name: merged-${{ matrix.repo }}
          path: merged/${{ matrix.repo }}.yml

  apply:
    needs: merge
    runs-on: ubuntu-latest
    environment: settings-apply
    steps:
      - uses: actions/download-artifact@v4
        with:
          pattern: merged-*
          merge-multiple: true
          path: merged
      - uses: Vivswan/github-settings-as-code@v2 # x-release-please-major
        with:
          token: ${{ secrets.FLEET_WRITE_TOKEN }}
          repos-dir: merged
        env:
          # The step-env half of the $FLEET_WRITE_TOKEN reference in the
          # environment's declared secrets below; `with.token` only feeds the
          # action's own input, never the reference resolver.
          FLEET_WRITE_TOKEN: ${{ secrets.FLEET_WRITE_TOKEN }}
```

The gate itself is a settings section, so the admin repository's own file (its entry in `.github/repos/`) declares it:

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

Bootstrapping, in order:

1. Reviewers take database IDs, not slugs; `gh api /orgs/acme/teams/platform --jq .id` finds one.
2. The admin repository only manages its own settings when it appears as a target, so give it its own file (`.github/repos/fleet-admin.yml`) declaring this environment; the `plan` job picks the file up on the next run.
3. The environment must exist before a job can be gated by it, so the first apply that creates it runs ungated.
4. `FLEET_WRITE_TOKEN` is declared as a `secrets` entry on the environment, and its `$FLEET_WRITE_TOKEN` reference resolves from the step's `env:` block; `with.token` alone does not expose it (see the [secrets guide](../reference/secrets-and-vaults.md)). That reads back the same secret the apply writes, so the FIRST apply must source it from a repository secret (or a vault step). Once the environment copy exists it overrides the same-named repository secret automatically, and the repository secret can be deleted.
5. `protected_branches: true` only admits runs from branches that carry protection, so protect `main` before enabling the gate.

Where one write token is still too broad, the `sections` allowlist splits it further: one job with an Issues-only PAT and `sections: labels,milestones`, another with the Administration PAT and `sections: repository,rulesets,collaborators`. Under the default `on-missing-permission: fail`, a mis-scoped token already fails the run; pair `on-missing-permission: warn` with `required-sections: rulesets` when you want the other sections to degrade gracefully while protection stays a hard requirement. The jobs are independently convergent, not a transaction.
