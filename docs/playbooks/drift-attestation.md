# Drift attestation for auditors

An auditor wants evidence that protection was enforced across the quarter,
not at the moment they asked. A daily check whose output is retained is
that evidence:

```yaml
name: Settings attestation
on:
  schedule:
    - cron: "41 5 * * *"
  workflow_dispatch:

permissions:
  contents: read
  issues: write

jobs:
  attest:
    runs-on: ubuntu-latest
    steps:
      - id: check
        continue-on-error: true
        uses: Vivswan/repo-settings-as-code@v1 # x-release-please-major
        with:
          token: ${{ secrets.FLEET_READ_TOKEN }}
          mode: check
          repos: "*"
          topics: production
      - name: Write the evidence record
        env:
          REPOS_RESULT: ${{ steps.check.outputs.repos-result }}
        run: |
          jq -n --argjson targets "${REPOS_RESULT:-null}" \
            '{run: env.GITHUB_RUN_ID, at: now | todate, targets: $targets}' \
            > evidence.json
      - uses: actions/upload-artifact@v4
        with:
          name: settings-attestation
          path: evidence.json
          retention-days: 90
      - if: steps.check.outputs.result != 'clean'
        env:
          GH_TOKEN: ${{ github.token }}
          GH_REPO: ${{ github.repository }}
        run: gh issue create --title "Settings drift $(date -I)" --body "See run $GITHUB_RUN_ID"
```

The reason this must be a check and not an apply is stated in the
[check mode guide](../operate/check-mode.md): apply exits 0 whether or not it changed
anything, so a green scheduled apply proves nothing about drift, while a
green scheduled check is exactly the claim the auditor needs. For a fleet
with private repositories, add `private-repos: redact` (the default) and
deliver the full detail through `private-report: artifact` with an age
key, which keeps slugs and settings out of the public run while preserving
the evidence; the
[private repositories guide](../operate/private-repositories.md) covers
the setup.
