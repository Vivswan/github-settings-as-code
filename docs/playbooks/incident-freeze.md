# Incident freeze and unfreeze

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
      - uses: Vivswan/github-settings-as-code@v1 # x-release-please-major
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
