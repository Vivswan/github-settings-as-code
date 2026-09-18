---
order: 330
---

# Preview the blast radius of a fleet change

One line in a fleet's baseline can delete labels on two hundred repositories. Check mode on pull requests is the plan step, and it runs on the same merged documents the apply will run.

Three jobs. `plan` lists the files in the flat `.github/repos/` directory; `merge` folds each repository's layers (no token needed) and uploads the merged document; `preview` collects them into one directory and runs a single multi-repo check over it, so the pull request gets one comment:

```yaml
name: Preview fleet changes
on:
  pull_request:
    paths: [".github/settings/**", ".github/repos/**"]

permissions:
  contents: read
  pull-requests: write

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
      - uses: Vivswan/github-settings-as-code@v3 # x-release-please-major
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

  preview:
    needs: merge
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: actions/download-artifact@v4
        with:
          pattern: merged-*
          merge-multiple: true
          path: merged
      - id: plan
        continue-on-error: true
        uses: Vivswan/github-settings-as-code@v3 # x-release-please-major
        with:
          token: ${{ secrets.FLEET_READ_TOKEN }}
          mode: check
          repos-dir: merged
      - name: Comment the per-repo results
        env:
          REPOS_RESULT: ${{ steps.plan.outputs.repos-result }}
          GH_TOKEN: ${{ github.token }}
        run: |
          body="$(jq -r 'to_entries[] | "- \(.key): \(.value.result)"' <<< "$REPOS_RESULT")"
          gh pr comment "${{ github.event.pull_request.number }}" \
            --body "Settings check for this PR:"$'\n'"$body"
```

How to read it:

- `continue-on-error` is load-bearing: a pull request that changes settings is supposed to exit 1, so the verdict is the rendered `repos-result` map and the drift lines in the run log, not the step's color.
- The report is proposed-versus-live, not a diff of the PR: the drift includes any divergence that existed before the PR, and it is exactly what an apply on merge would change.
- The read-only token keeps the write-capable credential out of `pull_request` jobs entirely (the [check mode guide](../operate/check-mode.md) explains why that matters).
- A file named `payments.yml` in the merged directory targets `acme/payments` under the admin repository's owner; the [multi-repo guide](../operate/multi-repo.md) covers the naming.
- `.github/repos/` is flat here: `find -maxdepth 1` reads only its top level, and a file's bare name is the repository. A repository of another owner needs the `<owner>/<name>.yml` form the multi-repo guide describes, carried through to `merged-file`.

Adding a repository is adding its file under `.github/repos/`; the `plan` job reads the directory, so no list is maintained by hand. The `merge` matrix runs one job per file, and a matrix runs at most 256 jobs; past that, split the directory by cohort into copies of this workflow, each filtered on its folder and commenting on its own. The [layering guide](../operate/layering.md) owns what the fold does to each layer.
