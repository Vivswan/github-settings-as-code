# Preview the blast radius of a fleet change

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
entirely (the [check mode guide](../operate/check-mode.md) explains why that
matters).
