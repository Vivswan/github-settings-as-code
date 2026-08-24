# Trust tiers: read-only preview, gated apply

A repository secret is readable from any workflow that anyone with push access can edit, so on a fleet admin repository the write token deserves a higher bar than push. Split the trust in two: previews run with a read-only PAT stored as a repository secret (as in [Preview the blast radius](preview-blast-radius.md)), and the apply job runs with the write PAT stored as an environment secret on an environment with required reviewers, so the write token only materializes after a human approves the run.

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
      - uses: Vivswan/github-settings-as-code@v2 # x-release-please-major
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

The gate itself is a settings section, so the admin repository's own file declares it:

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

Reviewers take database IDs, not slugs; `gh api /orgs/acme/teams/platform --jq .id` finds one. The bootstrap deserves care, in order: the admin repository only manages its own settings when it appears as a target (give it its own file, e.g. `.github/repos/fleet-admin.yml`, declaring this environment); the environment must exist before a job can be gated by it, so the first apply that creates it runs ungated; `FLEET_WRITE_TOKEN` itself is declared as a `secrets` entry on the environment above, whose `$FLEET_WRITE_TOKEN` reference resolves from the step's `env:` block in the workflow snippet - `with.token` alone does not expose it (see the [secrets guide](../reference/secrets-and-vaults.md)). That reads back the same secret the apply writes, so the FIRST apply must source it from a repository secret (or a vault step); once the environment copy exists it overrides the same-named repository secret automatically, and the repository secret can be deleted. Finally, `protected_branches: true` only admits runs from branches that carry protection, so protect `main` before enabling the gate.

Where one write token is still too broad, the `sections` allowlist splits it further: one job with an Issues-only PAT and `sections: labels,milestones`, another with the Administration PAT and `sections: repository,rulesets,collaborators`. Under the default `on-missing-permission: fail`, a mis-scoped token already fails the run; pair `on-missing-permission: warn` with `required-sections: rulesets` when you want the other sections to degrade gracefully while protection stays a hard requirement. The jobs are independently convergent, not a transaction.
